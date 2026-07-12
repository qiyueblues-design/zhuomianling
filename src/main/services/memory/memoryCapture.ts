import crypto from "node:crypto";
import type {
  MemoryConversationTurn,
  MemoryMemorizeResponse,
  MemoryPendingTurn,
  MemoryResult,
  MemorySettings
} from "../../../shared/types/memory";
import { assertMemoryConversationTurn, normalizeMemorySettings } from "../../../shared/validation/memory";
import { getAiConnectionConfig } from "../ai/aiSettings";
import { getLocalPetMemorySettings, listLocalPets } from "../config/petConfigStore";
import { MemoryLedger } from "./MemoryLedger";
import { MemoryPendingStore } from "./MemoryPendingStore";
import { getRuntimeComponents } from "./memoryRecall";

const maximumAttempts = 5;
const defaultRetryDelaysMs = [1_000, 5_000, 30_000, 300_000] as const;

export interface CompletedAiTurn {
  petId: string;
  requestId: string;
  userText: string;
  assistantReply: string;
  occurredAt: string;
}

export interface CaptureLedger {
  isAutomaticTurnCommitted(requestId: string, contentHash: string): boolean;
  commitAutomaticTurn(
    turn: MemoryConversationTurn,
    contentHash: string,
    entries: MemoryMemorizeResponse["entries"]
  ): ReturnType<MemoryLedger["commitAutomaticTurn"]>;
  close(): void;
}

type CapturePendingStore = Pick<MemoryPendingStore, "write" | "read" | "list" | "remove">;

export interface MemoryCaptureDiagnostic {
  petId: string;
  requestId: string;
  stage: "pending" | "provider" | "normalize" | "ledger" | "index" | "retry";
  code: string;
  attempt: number;
}

export interface AutomaticMemoryCaptureDependencies {
  getSettings(petId: string): Promise<MemorySettings | undefined>;
  createPendingStore(petId: string): CapturePendingStore;
  openLedger(petId: string): Promise<CaptureLedger>;
  normalize(
    turn: MemoryConversationTurn,
    settings: MemorySettings,
    signal: AbortSignal
  ): Promise<MemoryResult<MemoryMemorizeResponse>>;
  synchronize(ledger: CaptureLedger, signal: AbortSignal): Promise<void>;
  now?: () => Date;
  retryDelaysMs?: readonly number[];
  onDiagnostic?(diagnostic: MemoryCaptureDiagnostic): void;
}

export function hashCompletedMemoryTurn(turn: CompletedAiTurn): string {
  return crypto.createHash("sha256").update(JSON.stringify([
    turn.petId,
    turn.requestId,
    turn.userText,
    turn.assistantReply,
    turn.occurredAt
  ]), "utf8").digest("hex");
}

export class AutomaticMemoryCaptureQueue {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly activeTasks = new Map<Promise<unknown>, string>();
  private readonly controllers = new Map<AbortController, string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly pausedPets = new Set<string>();
  private shuttingDown = false;

  constructor(private readonly dependencies: AutomaticMemoryCaptureDependencies) {}

  private diagnose(
    pending: Pick<MemoryPendingTurn, "petId" | "requestId" | "attempt">,
    stage: MemoryCaptureDiagnostic["stage"],
    code: string
  ): void {
    this.dependencies.onDiagnostic?.({
      petId: pending.petId,
      requestId: pending.requestId,
      stage,
      code,
      attempt: pending.attempt
    });
  }

  private enqueue<T>(petId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(petId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(petId, current);
    void current.finally(() => {
      if (this.queues.get(petId) === current) this.queues.delete(petId);
    }).catch(() => undefined);
    return current;
  }

  private track(task: Promise<unknown>, petId: string): void {
    this.activeTasks.set(task, petId);
    void task.finally(() => this.activeTasks.delete(task)).catch(() => undefined);
  }

  capture(turn: CompletedAiTurn): Promise<boolean> {
    const task = this.captureTurn(turn);
    this.track(task, turn.petId);
    return task;
  }

  private async captureTurn(turn: CompletedAiTurn): Promise<boolean> {
    if (this.shuttingDown || this.pausedPets.has(turn.petId)) return false;
    let settings: MemorySettings;
    try {
      settings = normalizeMemorySettings(await this.dependencies.getSettings(turn.petId));
      if (!settings.autoCaptureEnabled) return false;
      assertMemoryConversationTurn({
        ...turn,
        retainSource: settings.retainSources
      });
    } catch {
      this.diagnose({ ...turn, attempt: 0 }, "pending", "invalid-request");
      return false;
    }

    const now = (this.dependencies.now ?? (() => new Date()))();
    const pending: MemoryPendingTurn = {
      schemaVersion: 1,
      ...turn,
      contentHash: hashCompletedMemoryTurn(turn),
      retainSource: settings.retainSources,
      attempt: 0,
      createdAt: now.toISOString()
    };
    try {
      const store = this.dependencies.createPendingStore(turn.petId);
      await store.write(pending);
      const task = this.enqueue(turn.petId, () => this.processPending(store, pending.requestId));
      this.track(task, turn.petId);
      return true;
    } catch {
      this.diagnose(pending, "pending", "storage-unavailable");
      return false;
    }
  }

  async resumePet(petId: string): Promise<void> {
    if (this.shuttingDown || this.pausedPets.has(petId)) return;
    const settings = normalizeMemorySettings(await this.dependencies.getSettings(petId));
    if (!settings.autoCaptureEnabled) return;
    const store = this.dependencies.createPendingStore(petId);
    for (const pending of await store.list()) {
      if (pending.deadLetteredAt) continue;
      this.schedule(store, pending);
    }
  }

  private schedule(store: CapturePendingStore, pending: MemoryPendingTurn): void {
    if (this.shuttingDown || this.pausedPets.has(pending.petId) || pending.deadLetteredAt) return;
    const key = `${pending.petId}:${pending.requestId}`;
    clearTimeout(this.retryTimers.get(key));
    const now = (this.dependencies.now ?? (() => new Date()))().getTime();
    const delay = Math.max(0, (pending.nextAttemptAt ? Date.parse(pending.nextAttemptAt) : now) - now);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      const task = this.enqueue(pending.petId, () => this.processPending(store, pending.requestId));
      this.track(task, pending.petId);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(key, timer);
  }

  private async processPending(store: CapturePendingStore, requestId: string): Promise<void> {
    if (this.shuttingDown) return;
    const pending = await store.read(requestId);
    if (!pending || this.pausedPets.has(pending.petId) || pending.deadLetteredAt) return;
    const controller = new AbortController();
    this.controllers.set(controller, pending.petId);
    let ledger: CaptureLedger | undefined;
    let stage: MemoryCaptureDiagnostic["stage"] = "provider";
    try {
      const settings = normalizeMemorySettings(await this.dependencies.getSettings(pending.petId));
      if (!settings.autoCaptureEnabled) return;
      stage = "ledger";
      ledger = await this.dependencies.openLedger(pending.petId);
      if (ledger.isAutomaticTurnCommitted(pending.requestId, pending.contentHash)) {
        stage = "pending";
        await store.remove(pending.requestId);
        try {
          stage = "index";
          await this.dependencies.synchronize(ledger, controller.signal);
        } catch {
          if (!this.shuttingDown) this.diagnose(pending, "index", "index-dirty");
        }
        return;
      }

      const turn: MemoryConversationTurn = {
        petId: pending.petId,
        requestId: pending.requestId,
        userText: pending.userText,
        assistantReply: pending.assistantReply,
        occurredAt: pending.occurredAt,
        retainSource: pending.retainSource
      };
      stage = "normalize";
      const result = await this.dependencies.normalize(turn, settings, controller.signal);
      if (!result.ok) {
        await this.recordFailure(store, pending, result.error.code, "normalize");
        return;
      }

      stage = "ledger";
      await ledger.commitAutomaticTurn(turn, pending.contentHash, result.value.entries);
      stage = "pending";
      await store.remove(pending.requestId);
      try {
        stage = "index";
        await this.dependencies.synchronize(ledger, controller.signal);
      } catch {
        if (!this.shuttingDown) this.diagnose(pending, "index", "index-dirty");
      }
    } catch {
      if (!this.shuttingDown && !controller.signal.aborted) {
        await this.recordFailure(store, pending, "internal", stage);
      }
    } finally {
      ledger?.close();
      this.controllers.delete(controller);
    }
  }

  private async recordFailure(
    store: CapturePendingStore,
    pending: MemoryPendingTurn,
    code: string,
    stage: MemoryCaptureDiagnostic["stage"]
  ): Promise<void> {
    const attempt = pending.attempt + 1;
    const now = (this.dependencies.now ?? (() => new Date()))();
    const next: MemoryPendingTurn = {
      ...pending,
      attempt,
      lastErrorCode: /^[a-z0-9-]{1,64}$/.test(code) ? code : "internal"
    };
    if (attempt >= maximumAttempts) {
      next.deadLetteredAt = now.toISOString();
      delete next.nextAttemptAt;
      try {
        await store.write(next);
      } catch {
        this.diagnose(pending, "pending", "storage-unavailable");
        return;
      }
      this.diagnose(next, "retry", "dead-letter");
      return;
    }
    const delays = this.dependencies.retryDelaysMs ?? defaultRetryDelaysMs;
    const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 300_000;
    next.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
    try {
      await store.write(next);
    } catch {
      this.diagnose(pending, "pending", "storage-unavailable");
      return;
    }
    this.diagnose(next, stage, next.lastErrorCode ?? "internal");
    this.schedule(store, next);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const controller of this.controllers.keys()) controller.abort("application-shutdown");
    while (this.activeTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks.keys()]);
    }
  }

  async suspendPet(petId: string): Promise<() => void> {
    this.pausedPets.add(petId);
    for (const [key, timer] of this.retryTimers) {
      if (key.startsWith(`${petId}:`)) {
        clearTimeout(timer);
        this.retryTimers.delete(key);
      }
    }
    for (const [controller, ownerPetId] of this.controllers) {
      if (ownerPetId === petId) controller.abort("pet-suspended");
    }
    while ([...this.activeTasks.values()].includes(petId)) {
      await Promise.allSettled(
        [...this.activeTasks].filter(([, ownerPetId]) => ownerPetId === petId).map(([task]) => task)
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pausedPets.delete(petId);
      void this.resumePet(petId).catch(() => undefined);
    };
  }
}

const automaticCaptureQueue = new AutomaticMemoryCaptureQueue({
  getSettings: getLocalPetMemorySettings,
  createPendingStore: (petId) => new MemoryPendingStore(petId),
  openLedger: (petId) => MemoryLedger.open(petId),
  async normalize(turn, settings, signal) {
    const profileId = settings.providerProfileId ?? turn.petId;
    const provider = await getAiConnectionConfig(profileId);
    if (!provider?.baseUrl || !provider.model || !provider.apiKey) {
      return {
        ok: false,
        error: { code: "invalid-config", message: "Memory provider is not configured.", retryable: true }
      };
    }
    const runtime = await getRuntimeComponents();
    await runtime.backend.configureNormalizationProvider({
      petId: turn.petId,
      profileId,
      baseUrl: provider.baseUrl,
      chatModel: provider.model,
      apiKey: provider.apiKey
    }, signal);
    return runtime.normalizationService.memorize(turn, settings, signal);
  },
  async synchronize(ledger, signal) {
    const runtime = await getRuntimeComponents();
    await runtime.coordinator.synchronize(ledger as MemoryLedger, signal);
  },
  onDiagnostic(diagnostic) {
    console.warn("Automatic memory capture degraded.", diagnostic);
  }
});

export function captureCompletedAiTurn(turn: CompletedAiTurn): Promise<boolean> {
  return automaticCaptureQueue.capture(turn);
}

export async function resumeAutomaticMemoryCaptures(): Promise<void> {
  const pets = await listLocalPets();
  await Promise.allSettled(pets.map((pet) => automaticCaptureQueue.resumePet(pet.id)));
}

export function shutdownAutomaticMemoryCaptures(): Promise<void> {
  return automaticCaptureQueue.shutdown();
}

export async function refreshAutomaticMemoryCapturesForPet(petId: string): Promise<void> {
  const release = await automaticCaptureQueue.suspendPet(petId);
  release();
}

export function suspendAutomaticMemoryCapturesForPet(petId: string): Promise<() => void> {
  return automaticCaptureQueue.suspendPet(petId);
}
