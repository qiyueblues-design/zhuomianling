import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_SETTINGS, type MemoryRecord } from "../../../shared/types/memory";
import { AiMemoryRecallService, type MemoryRecallDiagnostic } from "./memoryRecall";

const enabledSettings = {
  ...DEFAULT_MEMORY_SETTINGS,
  recallEnabled: true,
  recallLimit: 5,
  contextBudgetChars: 1_024
};

function memory(content: string): MemoryRecord {
  return {
    id: "memory-1",
    petId: "pet-a",
    chapter: "about_you",
    memoryType: "profile",
    content,
    tags: [],
    important: false,
    origin: "manual",
    sourceAvailable: false,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    revision: 1
  };
}

function abortablePending(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

describe("AiMemoryRecallService", () => {
  it("does not touch storage or backend when recall is disabled", async () => {
    const synchronize = vi.fn();
    const retrieve = vi.fn();
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => undefined),
      synchronize,
      retrieve
    });
    await expect(service.recall("pet-a", [{ role: "user", content: "hello" }], new AbortController().signal))
      .resolves.toEqual({ recalledCount: 0 });
    expect(synchronize).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("returns only a bounded untrusted context and emits content-free diagnostics", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const retrieve = vi.fn(async (_petId, query: string) => {
      expect(query).toContain("current-question");
      expect(query).not.toContain("persona-secret");
      return {
        ok: true as const,
        value: {
          items: [{ memory: memory("private-memory-content"), score: 0.9 }],
          answerPolicy: "reference" as const
        }
      };
    });
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn(async () => undefined),
      retrieve,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const result = await service.recall("pet-a", [
      { role: "system", content: "persona-secret" },
      { role: "user", content: "current-question" }
    ], new AbortController().signal);
    expect(result.recalledCount).toBe(1);
    expect(result.context).toContain("private-memory-content");
    expect(result.context!.length).toBeLessThanOrEqual(enabledSettings.contextBudgetChars);
    expect(diagnostics).toEqual([
      expect.objectContaining({ petId: "pet-a", stage: "context", code: "ok", recalledCount: 1 })
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("private-memory-content");
    expect(JSON.stringify(diagnostics)).not.toContain("current-question");
  });

  it("turns its own 1200ms-class deadline into a no-memory fallback", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn((_petId, signal) => abortablePending(signal)),
      retrieve: vi.fn(),
      deadlineMs: 10,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(service.recall("pet-a", [{ role: "user", content: "hello" }], new AbortController().signal))
      .resolves.toEqual({ recalledCount: 0 });
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "index", code: "timeout" })]);
  });

  it("degrades a missing application-owned runtime before retrieval", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn(async () => { throw new Error("runtime missing"); }),
      retrieve: vi.fn(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(service.recall("pet-a", [{ role: "user", content: "hello" }], new AbortController().signal))
      .resolves.toEqual({ recalledCount: 0 });
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "index", code: "unavailable" })]);
  });

  it("propagates the parent cancellation to index work without throwing", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const controller = new AbortController();
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn((_petId, signal) => abortablePending(signal)),
      retrieve: vi.fn(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const pending = service.recall("pet-a", [{ role: "user", content: "hello" }], controller.signal);
    controller.abort("renderer");
    await expect(pending).resolves.toEqual({ recalledCount: 0 });
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "index", code: "canceled" })]);
  });

  it("degrades structured backend failures without leaking their query", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn(async () => undefined),
      retrieve: vi.fn(async () => ({
        ok: false as const,
        error: { code: "unavailable" as const, message: "hidden", retryable: true }
      })),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(service.recall("pet-a", [{ role: "user", content: "sensitive-query" }], new AbortController().signal))
      .resolves.toEqual({ recalledCount: 0 });
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "retrieve", code: "unavailable" })]);
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive-query");
  });

  it("injects a no-guessing constraint when a memory check has no high-confidence match", async () => {
    const service = new AiMemoryRecallService({
      getSettings: async () => ({ ...DEFAULT_MEMORY_SETTINGS, recallEnabled: true }),
      synchronize: async () => undefined,
      retrieve: async () => ({
        ok: true,
        value: { items: [], answerPolicy: "unknown" }
      })
    });
    const result = await service.recall(
      "pet-a",
      [{ role: "user", content: "你记得我喜欢什么颜色吗？" }],
      new AbortController().signal
    );
    expect(result.recalledCount).toBe(0);
    expect(result.context).toContain("必须明确承认不知道或记不清");
  });
});
