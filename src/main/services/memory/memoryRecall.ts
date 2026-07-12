import fs from "node:fs/promises";
import path from "node:path";
import type { AiChatMessage } from "../../../shared/types/ai";
import type {
  MemoryResult,
  MemoryRetrieveResponse,
  MemorySettings
} from "../../../shared/types/memory";
import { normalizeMemorySettings } from "../../../shared/validation/memory";
import { getLocalPetMemorySettings } from "../config/petConfigStore";
import { MemoryIndexCoordinator } from "./MemoryIndexCoordinator";
import { MemoryLedger } from "./MemoryLedger";
import { MemoryService } from "./MemoryService";
import { MemorySidecarClient } from "./MemorySidecarClient";
import { MemuMemoryBackend } from "./MemuMemoryBackend";
import { ensureSafeMemoryChildDirectory, ensureSafeMemoryPaths } from "./memoryPaths";
import {
  buildMemoryRecallQuery,
  buildUntrustedMemoryContext
} from "./memoryPrompt";

const recallDeadlineMs = 1_200;

export interface MemoryRecallDiagnostic {
  petId: string;
  stage: "settings" | "index" | "retrieve" | "context";
  code: string;
  durationMs: number;
  recalledCount?: number;
}

export interface AiMemoryRecallResult {
  context?: string;
  recalledCount: number;
}

export interface AiMemoryRecallDependencies {
  getSettings(petId: string): Promise<MemorySettings | undefined>;
  synchronize(petId: string, signal: AbortSignal): Promise<void>;
  retrieve(
    petId: string,
    query: string,
    settings: MemorySettings,
    signal: AbortSignal
  ): Promise<MemoryResult<MemoryRetrieveResponse>>;
  onDiagnostic?(diagnostic: MemoryRecallDiagnostic): void;
  now?: () => number;
  deadlineMs?: number;
}

export class AiMemoryRecallService {
  constructor(private readonly dependencies: AiMemoryRecallDependencies) {}

  async recall(
    petId: string,
    messages: AiChatMessage[],
    signal: AbortSignal
  ): Promise<AiMemoryRecallResult> {
    const now = this.dependencies.now ?? (() => performance.now());
    const startedAt = now();
    const controller = new AbortController();
    let timedOut = false;
    let stage: MemoryRecallDiagnostic["stage"] = "settings";
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("memory-recall-timeout");
    }, this.dependencies.deadlineMs ?? recallDeadlineMs);

    const diagnose = (code: string, recalledCount?: number) => {
      this.dependencies.onDiagnostic?.({
        petId,
        stage,
        code,
        durationMs: Math.max(0, now() - startedAt),
        recalledCount
      });
    };

    try {
      const settings = normalizeMemorySettings(await this.dependencies.getSettings(petId));
      if (!settings.recallEnabled) return { recalledCount: 0 };
      const query = buildMemoryRecallQuery(messages);
      if (!query) return { recalledCount: 0 };

      stage = "index";
      await this.dependencies.synchronize(petId, controller.signal);
      if (controller.signal.aborted) throw new Error("recall-aborted");

      stage = "retrieve";
      const response = await this.dependencies.retrieve(petId, query, settings, controller.signal);
      if (!response.ok) {
        diagnose(timedOut ? "timeout" : response.error.code);
        return { recalledCount: 0 };
      }

      stage = "context";
      const context = buildUntrustedMemoryContext(response.value.items, settings);
      diagnose("ok", context.includedCount);
      return { context: context.context, recalledCount: context.includedCount };
    } catch {
      diagnose(signal.aborted ? "canceled" : timedOut ? "timeout" : "unavailable");
      return { recalledCount: 0 };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface MemoryRecallRuntimeRoots {
  appPath: string;
  resourcesPath: string;
}

interface MemoryRuntimePaths {
  executablePath: string;
  sidecarRoot: string;
  dependencyRoot: string;
}

export interface MemoryRuntimeComponents {
  service: MemoryService;
  normalizationService: MemoryService;
  coordinator: MemoryIndexCoordinator;
  backend: MemuMemoryBackend;
}

let runtimeRoots: MemoryRecallRuntimeRoots | undefined;
let componentsPromise: Promise<MemoryRuntimeComponents> | undefined;

export function configureMemoryRecallRuntime(roots: MemoryRecallRuntimeRoots): void {
  if (!path.isAbsolute(roots.appPath) || !path.isAbsolute(roots.resourcesPath)) {
    throw new Error("Memory recall runtime roots must be absolute.");
  }
  runtimeRoots = { appPath: path.resolve(roots.appPath), resourcesPath: path.resolve(roots.resourcesPath) };
}

async function isSafeRuntimePath(target: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const stat = await fs.lstat(target);
    return !stat.isSymbolicLink() && (kind === "file" ? stat.isFile() : stat.isDirectory());
  } catch {
    return false;
  }
}

async function resolveRuntimePaths(): Promise<MemoryRuntimePaths> {
  if (!runtimeRoots) throw new Error("Memory recall runtime is not configured.");
  const candidates: MemoryRuntimePaths[] = [
    {
      executablePath: path.join(runtimeRoots.resourcesPath, "memory-sidecar", "runtime", "python.exe"),
      sidecarRoot: path.join(runtimeRoots.resourcesPath, "memory-sidecar", "sidecar"),
      dependencyRoot: path.join(runtimeRoots.resourcesPath, "memory-sidecar", "site-packages")
    },
    {
      executablePath: path.join(runtimeRoots.appPath, ".cache", "memory-sidecar-python-3.13", "runtime", "python.exe"),
      sidecarRoot: path.join(runtimeRoots.appPath, "sidecar", "memory"),
      dependencyRoot: path.join(runtimeRoots.appPath, ".cache", "memory-sidecar-python-3.13", "memu-1.5.1-site-packages")
    }
  ];
  for (const candidate of candidates) {
    if (
      await isSafeRuntimePath(candidate.executablePath, "file") &&
      await isSafeRuntimePath(candidate.sidecarRoot, "directory") &&
      await isSafeRuntimePath(candidate.dependencyRoot, "directory")
    ) {
      return candidate;
    }
  }
  throw new Error("Application-owned memory runtime is unavailable.");
}

async function indexDirectoryForPet(petId: string): Promise<string> {
  const memoryPaths = await ensureSafeMemoryPaths(petId);
  return ensureSafeMemoryChildDirectory(memoryPaths.directory, "index");
}

async function createRuntimeComponents(): Promise<MemoryRuntimeComponents> {
  const runtime = await resolveRuntimePaths();
  const client = new MemorySidecarClient({
    executablePath: runtime.executablePath,
    sidecarRoot: runtime.sidecarRoot,
    dependencyRoots: [runtime.dependencyRoot],
    startupTimeoutMs: 15_000,
    shutdownTimeoutMs: 5_000
  });
  const backend = new MemuMemoryBackend({ client, indexDirectoryForPet });
  return {
    service: new MemoryService(backend, { operationTimeoutMs: recallDeadlineMs }),
    normalizationService: new MemoryService(backend, { operationTimeoutMs: 60_000 }),
    backend,
    coordinator: new MemoryIndexCoordinator({
      backend,
      indexDirectoryForPet,
      modelFingerprint: backend.modelFingerprint
    })
  };
}

export function getRuntimeComponents(): Promise<MemoryRuntimeComponents> {
  componentsPromise ??= createRuntimeComponents();
  return componentsPromise;
}

export function getExistingRuntimeComponents(): Promise<MemoryRuntimeComponents> | undefined {
  return componentsPromise;
}

const defaultRecallService = new AiMemoryRecallService({
  getSettings: getLocalPetMemorySettings,
  async synchronize(petId, signal) {
    const components = await getRuntimeComponents();
    const ledger = await MemoryLedger.open(petId);
    try {
      await components.coordinator.synchronize(ledger, signal);
    } finally {
      ledger.close();
    }
  },
  async retrieve(petId, query, settings, signal) {
    const components = await getRuntimeComponents();
    return components.service.retrieve(petId, query, settings, signal);
  },
  onDiagnostic(diagnostic) {
    if (diagnostic.code === "ok") return;
    console.warn("Memory recall degraded.", diagnostic);
  }
});

export function recallMemoryForAi(
  petId: string,
  messages: AiChatMessage[],
  signal: AbortSignal
): Promise<AiMemoryRecallResult> {
  return defaultRecallService.recall(petId, messages, signal);
}
