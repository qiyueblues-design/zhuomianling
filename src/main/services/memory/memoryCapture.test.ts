import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_SETTINGS, type MemoryPendingTurn } from "../../../shared/types/memory";
import {
  AutomaticMemoryCaptureQueue,
  type CaptureLedger,
  type MemoryCaptureDiagnostic
} from "./memoryCapture";

class FakePendingStore {
  readonly values = new Map<string, MemoryPendingTurn>();
  readonly write = vi.fn(async (value: MemoryPendingTurn) => {
    this.values.set(value.requestId, structuredClone(value));
  });
  readonly read = vi.fn(async (requestId: string) => this.values.get(requestId));
  readonly list = vi.fn(async () => [...this.values.values()]);
  readonly remove = vi.fn(async (requestId: string) => {
    this.values.delete(requestId);
  });
}

class FakeLedger implements CaptureLedger {
  committed = false;
  readonly commitAutomaticTurn = vi.fn(async () => {
    this.committed = true;
    return { memories: [], duplicate: false, outboxSequences: [] };
  });
  readonly close = vi.fn();

  isAutomaticTurnCommitted(): boolean {
    return this.committed;
  }
}

const settings = {
  ...DEFAULT_MEMORY_SETTINGS,
  autoCaptureEnabled: true,
  retainSources: false
};

const completed = {
  petId: "pet-a",
  requestId: "request-1",
  userText: "current user text",
  assistantReply: "visible assistant reply",
  occurredAt: "2026-07-13T00:00:00.000Z"
};

describe("AutomaticMemoryCaptureQueue", () => {
  it("does nothing when automatic capture is disabled", async () => {
    const createPendingStore = vi.fn();
    const queue = new AutomaticMemoryCaptureQueue({
      getSettings: vi.fn(async () => undefined),
      createPendingStore,
      openLedger: vi.fn(),
      normalize: vi.fn(),
      synchronize: vi.fn()
    });
    await expect(queue.capture(completed)).resolves.toBe(false);
    expect(createPendingStore).not.toHaveBeenCalled();
  });

  it("durably queues, normalizes, commits once, removes pending, then syncs index", async () => {
    const store = new FakePendingStore();
    const ledger = new FakeLedger();
    const events: string[] = [];
    store.write.mockImplementation(async (value) => {
      events.push("pending");
      store.values.set(value.requestId, structuredClone(value));
    });
    ledger.commitAutomaticTurn.mockImplementation(async (_turn, _hash, entries) => {
      events.push("ledger");
      ledger.committed = true;
      expect(entries[0]?.content).toBe("normalized fact");
      return { memories: [], duplicate: false, outboxSequences: [] };
    });
    store.remove.mockImplementation(async (requestId) => {
      events.push("remove");
      store.values.delete(requestId);
    });
    const synchronize = vi.fn(async () => { events.push("index"); });
    const queue = new AutomaticMemoryCaptureQueue({
      getSettings: vi.fn(async () => settings),
      createPendingStore: () => store,
      openLedger: vi.fn(async () => ledger),
      normalize: vi.fn(async (turn) => {
        events.push("normalize");
        expect(turn.userText).toBe("current user text");
        expect(turn.assistantReply).toBe("visible assistant reply");
        return {
          ok: true as const,
          value: {
            entries: [{
              id: "auto-1",
              petId: "pet-a",
              chapter: "about_you" as const,
              memoryType: "profile" as const,
              content: "normalized fact",
              origin: "automatic" as const
            }]
          }
        };
      }),
      synchronize
    });
    await expect(queue.capture(completed)).resolves.toBe(true);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledOnce());
    expect(events).toEqual(["pending", "normalize", "ledger", "remove", "index"]);
    expect(store.values.size).toBe(0);
    expect(ledger.commitAutomaticTurn).toHaveBeenCalledOnce();
    expect(ledger.close).toHaveBeenCalledOnce();
    await queue.shutdown();
  });

  it("finishes a crash-after-commit pending item without normalizing or duplicating", async () => {
    const store = new FakePendingStore();
    const ledger = new FakeLedger();
    ledger.committed = true;
    const normalize = vi.fn();
    const queue = new AutomaticMemoryCaptureQueue({
      getSettings: vi.fn(async () => settings),
      createPendingStore: () => store,
      openLedger: vi.fn(async () => ledger),
      normalize,
      synchronize: vi.fn(async () => undefined)
    });
    await queue.capture(completed);
    await vi.waitFor(() => expect(store.remove).toHaveBeenCalledWith("request-1"));
    expect(normalize).not.toHaveBeenCalled();
    expect(ledger.commitAutomaticTurn).not.toHaveBeenCalled();
    await queue.shutdown();
  });

  it("retries bounded failures and leaves a durable dead letter", async () => {
    const store = new FakePendingStore();
    const diagnostics: MemoryCaptureDiagnostic[] = [];
    const queue = new AutomaticMemoryCaptureQueue({
      getSettings: vi.fn(async () => settings),
      createPendingStore: () => store,
      openLedger: vi.fn(async () => new FakeLedger()),
      normalize: vi.fn(async () => ({
        ok: false as const,
        error: { code: "unavailable" as const, message: "hidden", retryable: true }
      })),
      synchronize: vi.fn(),
      retryDelaysMs: [0],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await queue.capture(completed);
    await vi.waitFor(() => expect(store.values.get("request-1")?.deadLetteredAt).toEqual(expect.any(String)));
    expect(store.values.get("request-1")).toMatchObject({ attempt: 5, lastErrorCode: "unavailable" });
    expect(diagnostics.at(-1)).toMatchObject({ stage: "retry", code: "dead-letter", attempt: 5 });
    expect(JSON.stringify(diagnostics)).not.toContain(completed.userText);
    expect(JSON.stringify(diagnostics)).not.toContain(completed.assistantReply);
    await queue.shutdown();
  });

  it("does not restore pending after authority commit when index sync fails", async () => {
    const store = new FakePendingStore();
    const ledger = new FakeLedger();
    const diagnostics: MemoryCaptureDiagnostic[] = [];
    const queue = new AutomaticMemoryCaptureQueue({
      getSettings: vi.fn(async () => settings),
      createPendingStore: () => store,
      openLedger: vi.fn(async () => ledger),
      normalize: vi.fn(async () => ({ ok: true as const, value: { entries: [] } })),
      synchronize: vi.fn(async () => { throw new Error("index failed"); }),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await queue.capture(completed);
    await vi.waitFor(() => expect(ledger.commitAutomaticTurn).toHaveBeenCalled());
    await vi.waitFor(() => expect(store.values.size).toBe(0));
    expect(diagnostics).toContainEqual(expect.objectContaining({ stage: "index", code: "index-dirty" }));
    await queue.shutdown();
  });

  it("waits for an in-flight durable pending write during shutdown", async () => {
    const store = new FakePendingStore();
    let finishWrite: (() => void) | undefined;
    store.write.mockImplementation((value) => new Promise<void>((resolve) => {
      finishWrite = () => {
        store.values.set(value.requestId, structuredClone(value));
        resolve();
      };
    }));
    const normalize = vi.fn();
    const queue = new AutomaticMemoryCaptureQueue({
      getSettings: vi.fn(async () => settings),
      createPendingStore: () => store,
      openLedger: vi.fn(async () => new FakeLedger()),
      normalize,
      synchronize: vi.fn()
    });

    const capture = queue.capture(completed);
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledOnce());
    let shutdownFinished = false;
    const shutdown = queue.shutdown().then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    finishWrite?.();

    await expect(capture).resolves.toBe(true);
    await shutdown;
    expect(store.values.get(completed.requestId)).toMatchObject({ attempt: 0 });
    expect(normalize).not.toHaveBeenCalled();
  });

  it("suspends one pet for deletion without losing an in-flight pending turn", async () => {
    const store = new FakePendingStore();
    let finishWrite: (() => void) | undefined;
    store.write.mockImplementationOnce((value) => new Promise<void>((resolve) => {
      finishWrite = () => {
        store.values.set(value.requestId, structuredClone(value));
        resolve();
      };
    }));
    const normalize = vi.fn(async () => ({ ok: true as const, value: { entries: [] } }));
    const queue = new AutomaticMemoryCaptureQueue({
      getSettings: vi.fn(async () => settings),
      createPendingStore: () => store,
      openLedger: vi.fn(async () => new FakeLedger()),
      normalize,
      synchronize: vi.fn(async () => undefined),
      retryDelaysMs: [0]
    });

    const capture = queue.capture(completed);
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledOnce());
    const suspended = queue.suspendPet("pet-a");
    finishWrite?.();
    const release = await suspended;
    await expect(capture).resolves.toBe(true);
    expect(store.values.get(completed.requestId)).toMatchObject({ attempt: 0 });
    expect(normalize).not.toHaveBeenCalled();
    await expect(queue.capture({ ...completed, requestId: "request-paused" })).resolves.toBe(false);

    release();
    await vi.waitFor(() => expect(normalize).toHaveBeenCalledOnce());
    await queue.shutdown();
  });
});
