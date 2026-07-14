import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isValidPetId } from "../../../shared/validation/petId";
import type { MemorySidecarHandshake, MemorySidecarRequest } from "./memorySidecarProtocol";
import {
  assertHandshake,
  MEMORY_SIDECAR_MAX_DEADLINE_MS,
  MEMORY_SIDECAR_MAX_LINE_BYTES,
  parseSidecarResponse,
  validateSidecarValueBudget
} from "./memorySidecarProtocol";
import { registerMemorySidecar, unregisterMemorySidecar } from "./memorySidecarRuntime";

const pythonBootstrap = [
  "import runpy,sys",
  "sys.dont_write_bytecode=True",
  "root=sys.argv[1]",
  "sys.path[:0]=[root,*sys.argv[2:]]",
  "runpy.run_module('desktop_pet_memory_sidecar',run_name='__main__')"
].join(";");

export type MemorySidecarClientErrorCode =
  | "canceled"
  | "timeout"
  | "unavailable"
  | "invalid-response"
  | "incompatible"
  | "internal"
  | (string & {});

export class MemorySidecarClientError extends Error {
  constructor(readonly code: MemorySidecarClientErrorCode, message: string) {
    super(message);
    this.name = "MemorySidecarClientError";
  }
}

export interface MemorySidecarClientOptions {
  executablePath: string;
  sidecarRoot: string;
  dependencyRoots?: string[];
  modelRoot?: string;
  testCommandArguments?: string[];
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  now?: () => number;
  onDiagnostic?: (event: { kind: "stderr" | "protocol" | "exit"; bytes?: number }) => void;
}

export interface MemorySidecarCallOptions {
  petId?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: MemorySidecarClientError) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface MemorySidecarMetrics {
  pid?: number;
  startCount: number;
  lastColdStartMs?: number;
  lastWarmRequestMs?: number;
  stderrBytes: number;
  consecutiveFailures: number;
  retryAfterMs: number;
  circuitOpen: boolean;
}

function safeEnvironment(modelRoot?: string): NodeJS.ProcessEnv {
  const allowedNames = ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"];
  const environment: NodeJS.ProcessEnv = {
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    // Packaged resources are immutable inputs. Portable installs may still be
    // writable, so never create __pycache__ beside sidecar/dependency files.
    PYTHONDONTWRITEBYTECODE: "1"
  };
  for (const name of allowedNames) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  if (modelRoot) environment.DESKTOP_PET_MEMORY_MODEL_ROOT = modelRoot;
  return environment;
}

function isProcessRunning(child: ChildProcessWithoutNullStreams | undefined): child is ChildProcessWithoutNullStreams {
  return Boolean(child && child.exitCode === null && !child.killed);
}

export class MemorySidecarClient {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<MemorySidecarHandshake>;
  private handshake?: MemorySidecarHandshake;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly retired = new Set<string>();
  private readonly retiredOrder: string[] = [];
  private shuttingDown = false;
  private startCount = 0;
  private lastColdStartMs?: number;
  private lastWarmRequestMs?: number;
  private stderrBytes = 0;
  private shutdownPromise?: Promise<void>;
  private consecutiveFailures = 0;
  private restartNotBefore = 0;
  private circuitOpenUntil = 0;
  private readonly failedChildren = new WeakSet<ChildProcessWithoutNullStreams>();

  constructor(private readonly options: MemorySidecarClientOptions) {
    if (
      !path.isAbsolute(options.executablePath) ||
      !path.isAbsolute(options.sidecarRoot) ||
      (options.modelRoot !== undefined && !path.isAbsolute(options.modelRoot))
    ) {
      throw new MemorySidecarClientError("internal", "Sidecar executable and root must be absolute paths.");
    }
    if (options.testCommandArguments && process.env.NODE_ENV !== "test") {
      throw new MemorySidecarClientError("internal", "Custom sidecar arguments are test-only.");
    }
    if (options.dependencyRoots?.some((entry) => !path.isAbsolute(entry))) {
      throw new MemorySidecarClientError("internal", "Sidecar dependency roots must be absolute paths.");
    }
    for (const [name, value] of Object.entries({
      restartBaseDelayMs: options.restartBaseDelayMs,
      restartMaxDelayMs: options.restartMaxDelayMs,
      circuitCooldownMs: options.circuitCooldownMs
    })) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 300_000)) {
        throw new MemorySidecarClientError("internal", `Invalid ${name}.`);
      }
    }
    if (
      options.circuitFailureThreshold !== undefined &&
      (!Number.isInteger(options.circuitFailureThreshold) || options.circuitFailureThreshold < 2 || options.circuitFailureThreshold > 20)
    ) {
      throw new MemorySidecarClientError("internal", "Invalid circuitFailureThreshold.");
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  getMetrics(): MemorySidecarMetrics {
    const now = this.now();
    return {
      pid: isProcessRunning(this.child) ? this.child.pid : undefined,
      startCount: this.startCount,
      lastColdStartMs: this.lastColdStartMs,
      lastWarmRequestMs: this.lastWarmRequestMs,
      stderrBytes: this.stderrBytes,
      consecutiveFailures: this.consecutiveFailures,
      retryAfterMs: Math.max(0, Math.max(this.restartNotBefore, this.circuitOpenUntil) - now),
      circuitOpen: now < this.circuitOpenUntil
    };
  }

  async ensureStarted(): Promise<MemorySidecarHandshake> {
    if (this.handshake && isProcessRunning(this.child)) return this.handshake;
    if (this.startPromise) return this.startPromise;
    if (this.shuttingDown) throw new MemorySidecarClientError("unavailable", "Memory sidecar is shutting down.");
    const now = this.now();
    if (now < this.circuitOpenUntil) {
      throw new MemorySidecarClientError("unavailable", "Memory sidecar restart circuit is temporarily open.");
    }
    if (now < this.restartNotBefore) {
      throw new MemorySidecarClientError("unavailable", "Memory sidecar restart is backing off.");
    }
    this.startPromise = this.start().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async start(): Promise<MemorySidecarHandshake> {
    const startedAt = performance.now();
    const [executableStat, rootStat, ...dependencyStats] = await Promise.all([
      fs.lstat(this.options.executablePath),
      fs.lstat(this.options.sidecarRoot),
      ...(this.options.dependencyRoots ?? []).map((entry) => fs.lstat(entry))
    ]);
    if (
      executableStat.isSymbolicLink() ||
      !executableStat.isFile() ||
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      dependencyStats.some((stat) => stat.isSymbolicLink() || !stat.isDirectory())
    ) {
      throw new MemorySidecarClientError("unavailable", "Memory sidecar launch paths are unsafe.");
    }
    if (this.options.modelRoot) {
      const modelStat = await fs.lstat(this.options.modelRoot);
      if (modelStat.isSymbolicLink() || !modelStat.isDirectory()) {
        throw new MemorySidecarClientError("unavailable", "Memory sidecar model root is unsafe.");
      }
    }
    const [executablePath, sidecarRoot, ...dependencyRoots] = await Promise.all([
      fs.realpath(this.options.executablePath),
      fs.realpath(this.options.sidecarRoot),
      ...(this.options.dependencyRoots ?? []).map((entry) => fs.realpath(entry))
    ]);
    const args = this.options.testCommandArguments ?? ["-u", "-c", pythonBootstrap, sidecarRoot, ...dependencyRoots];
    const modelRoot = this.options.modelRoot ? await fs.realpath(this.options.modelRoot) : undefined;
    const child = spawn(executablePath, args, {
      cwd: sidecarRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeEnvironment(modelRoot)
    });
    this.child = child;
    this.handshake = undefined;
    this.stdoutBuffer = Buffer.alloc(0);
    this.startCount += 1;
    registerMemorySidecar(this);
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(child, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      this.options.onDiagnostic?.({ kind: "stderr", bytes: chunk.byteLength });
    });
    child.stdin.on("error", () => {
      if (this.child === child) {
        this.rejectAll(new MemorySidecarClientError("unavailable", "Memory sidecar stdin failed."));
      }
    });
    child.once("error", () => this.onExit(child));
    child.once("exit", () => this.onExit(child));

    try {
      const result = await this.send(
        "handshake",
        {},
        { deadlineMs: this.options.startupTimeoutMs ?? 5_000 },
        false
      );
      const handshake = assertHandshake(result);
      if (this.child !== child || !isProcessRunning(child)) {
        throw new MemorySidecarClientError("unavailable", "Memory sidecar exited during handshake.");
      }
      this.handshake = handshake;
      this.lastColdStartMs = performance.now() - startedAt;
      return handshake;
    } catch (error) {
      this.recordFailure(child);
      this.terminateOwnedProcess(child);
      if (error instanceof MemorySidecarClientError) throw error;
      throw new MemorySidecarClientError("incompatible", "Memory sidecar handshake failed.");
    }
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: MemorySidecarCallOptions = {}
  ): Promise<T> {
    if (!method || method.length > 64) throw new MemorySidecarClientError("internal", "Invalid sidecar method.");
    if (["handshake", "cancel", "shutdown"].includes(method)) {
      throw new MemorySidecarClientError("internal", "Sidecar control method is reserved.");
    }
    this.validateCall(params, options);
    const wasWarm = Boolean(this.handshake && isProcessRunning(this.child));
    const startedAt = performance.now();
    await this.ensureStarted();
    const result = await this.send(method, params, options, true);
    this.recordSuccess();
    if (wasWarm) this.lastWarmRequestMs = performance.now() - startedAt;
    return result as T;
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    options: MemorySidecarCallOptions,
    sendCancelOnTimeout: boolean
  ): Promise<unknown> {
    const child = this.child;
    if (!isProcessRunning(child) || !child.stdin.writable) {
      return Promise.reject(new MemorySidecarClientError("unavailable", "Memory sidecar is unavailable."));
    }
    const deadlineMs = options.deadlineMs ?? 1_200;
    try {
      this.validateCall(params, options);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = randomUUID();
    const request: MemorySidecarRequest = { id, method, deadlineMs, params };
    if (options.petId !== undefined) request.petId = options.petId;
    let serialized: string;
    try {
      serialized = `${JSON.stringify(request)}\n`;
    } catch {
      return Promise.reject(new MemorySidecarClientError("internal", "Sidecar request is not serializable."));
    }
    if (Buffer.byteLength(serialized, "utf8") > MEMORY_SIDECAR_MAX_LINE_BYTES) {
      return Promise.reject(new MemorySidecarClientError("internal", "Sidecar request exceeds its byte budget."));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new MemorySidecarClientError("canceled", "Memory sidecar request was canceled."));
    }

    return new Promise<unknown>((resolve, reject) => {
      const finishCanceled = (code: "canceled" | "timeout") => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener("abort", pending.onAbort!);
        this.retire(id);
        if (sendCancelOnTimeout) this.sendControlCancel(id);
        reject(
          new MemorySidecarClientError(
            code,
            code === "timeout" ? "Memory sidecar request timed out." : "Memory sidecar request was canceled."
          )
        );
      };
      const timer = setTimeout(() => finishCanceled("timeout"), deadlineMs);
      const onAbort = () => finishCanceled("canceled");
      const pending: PendingRequest = { resolve, reject, timer, signal: options.signal, onAbort };
      this.pending.set(id, pending);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdin.write(serialized, "utf8");
      } catch {
        this.finishPending(id, new MemorySidecarClientError("unavailable", "Memory sidecar stdin failed."));
      }
    });
  }

  private validateCall(params: Record<string, unknown>, options: MemorySidecarCallOptions): void {
    const deadlineMs = options.deadlineMs ?? 1_200;
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MEMORY_SIDECAR_MAX_DEADLINE_MS) {
      throw new MemorySidecarClientError("internal", "Invalid sidecar deadline.");
    }
    if (options.petId !== undefined && !isValidPetId(options.petId)) {
      throw new MemorySidecarClientError("internal", "Invalid sidecar pet ID.");
    }
    try {
      validateSidecarValueBudget(params);
    } catch {
      throw new MemorySidecarClientError("internal", "Invalid sidecar payload.");
    }
  }

  private sendControlCancel(targetId: string): void {
    const child = this.child;
    if (!isProcessRunning(child) || !child.stdin.writable) return;
    const id = randomUUID();
    this.retire(id);
    const request: MemorySidecarRequest = {
      id,
      method: "cancel",
      deadlineMs: 1_000,
      params: { targetId }
    };
    try {
      child.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
    } catch {}
  }

  private retire(id: string): void {
    this.retired.add(id);
    this.retiredOrder.push(id);
    while (this.retiredOrder.length > 256) {
      this.retired.delete(this.retiredOrder.shift()!);
    }
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.byteLength > MEMORY_SIDECAR_MAX_LINE_BYTES && !this.stdoutBuffer.includes(0x0a)) {
      this.failProtocol(child);
      return;
    }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf(0x0a)) >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line.byteLength) continue;
      try {
        const response = parseSidecarResponse(line);
        if (this.retired.delete(response.id)) continue;
        const pending = this.pending.get(response.id);
        if (!pending) {
          this.failProtocol(child);
          return;
        }
        if (response.ok) this.finishPending(response.id, undefined, response.result);
        else {
          this.finishPending(
            response.id,
            new MemorySidecarClientError(response.error.code, response.error.message)
          );
        }
      } catch {
        this.failProtocol(child);
        return;
      }
    }
  }

  private finishPending(id: string, error?: MemorySidecarClientError, value?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private failProtocol(child: ChildProcessWithoutNullStreams): void {
    this.options.onDiagnostic?.({ kind: "protocol" });
    this.rejectAll(new MemorySidecarClientError("invalid-response", "Memory sidecar protocol failed."));
    this.recordFailure(child);
    this.terminateOwnedProcess(child);
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.restartNotBefore = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(child?: ChildProcessWithoutNullStreams): void {
    if (this.shuttingDown) return;
    if (child) {
      if (this.failedChildren.has(child)) return;
      this.failedChildren.add(child);
    }
    this.consecutiveFailures += 1;
    const base = this.options.restartBaseDelayMs ?? 250;
    const maximum = this.options.restartMaxDelayMs ?? 10_000;
    const delay = Math.min(maximum, base * (2 ** Math.min(16, this.consecutiveFailures - 1)));
    const now = this.now();
    this.restartNotBefore = Math.max(this.restartNotBefore, now + delay);
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 5)) {
      this.circuitOpenUntil = Math.max(this.circuitOpenUntil, now + (this.options.circuitCooldownMs ?? 30_000));
    }
  }

  private rejectAll(error: MemorySidecarClientError): void {
    for (const id of [...this.pending.keys()]) this.finishPending(id, error);
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.recordFailure(child);
    this.options.onDiagnostic?.({ kind: "exit" });
    this.child = undefined;
    this.handshake = undefined;
    this.stdoutBuffer = Buffer.alloc(0);
    this.rejectAll(new MemorySidecarClientError("unavailable", "Memory sidecar exited."));
    unregisterMemorySidecar(this);
  }

  private terminateOwnedProcess(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {}
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown().finally(() => {
      this.shutdownPromise = undefined;
    });
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      await this.startPromise?.catch(() => undefined);
      const child = this.child;
      if (!isProcessRunning(child)) return;
      try {
        await this.send(
          "shutdown",
          {},
          { deadlineMs: this.options.shutdownTimeoutMs ?? 2_000 },
          false
        );
      } catch {}
      try {
        child.stdin.end();
      } catch {}
      const exited = await new Promise<boolean>((resolve) => {
        if (child.exitCode !== null) return resolve(true);
        const timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs ?? 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        this.terminateOwnedProcess(child);
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(resolve, 1_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } finally {
      unregisterMemorySidecar(this);
      this.child = undefined;
      this.handshake = undefined;
      this.shuttingDown = false;
    }
  }
}
