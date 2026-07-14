import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_SETTINGS, type MemoryRecordInput } from "../../../shared/types/memory";
import { FakeMemoryBackend } from "./FakeMemoryBackend";
import { MemoryService } from "./MemoryService";

const enabledSettings = {
  ...DEFAULT_MEMORY_SETTINGS,
  recallEnabled: true,
  autoCaptureEnabled: true
};

function record(petId: string, id: string, content: string): MemoryRecordInput {
  return {
    petId,
    id,
    chapter: "about_you",
    memoryType: "profile",
    content,
    origin: "manual"
  };
}

describe("FakeMemoryBackend contract", () => {
  it("is deterministic and keeps records isolated by pet", async () => {
    const backend = new FakeMemoryBackend();
    const service = new MemoryService(backend);
    await service.upsert({ petId: "pet-a", memory: record("pet-a", "a-1", "likes tea") });
    await service.upsert({ petId: "pet-b", memory: record("pet-b", "b-1", "likes coffee") });

    const first = await service.retrieve("pet-a", "tea", enabledSettings);
    const second = await service.retrieve("pet-a", "tea", enabledSettings);

    expect(first).toEqual(second);
    expect(first.ok && first.value.items.map(({ memory }) => memory.id)).toEqual(["a-1"]);
    expect(backend.snapshot("pet-b").map(({ id }) => id)).toEqual(["b-1"]);
  });

  it("supports memorize, forget, and rebuild without touching disk", async () => {
    const backend = new FakeMemoryBackend();
    const service = new MemoryService(backend);
    const memorized = await service.memorize(
      {
        petId: "pet-a",
        requestId: "request-1",
        userText: "I prefer quiet mornings",
        assistantReply: "Understood",
        occurredAt: "2026-07-13T00:00:00.000Z",
        retainSource: false
      },
      enabledSettings
    );

    expect(memorized.ok && memorized.value.entries[0]?.id).toBe("auto-request-1");
    await service.forget({ petId: "pet-a", memoryId: "auto-request-1" });
    expect(backend.snapshot("pet-a")).toEqual([]);

    const rebuilt = await service.rebuild({
      petId: "pet-a",
      targetId: "staging-fixture",
      records: [
        {
          ...record("pet-a", "rebuilt-1", "rebuilt"),
          tags: [],
          important: false,
          sourceAvailable: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          revision: 1
        }
      ]
    });
    expect(rebuilt).toEqual({ ok: true, value: { indexedCount: 1 } });
  });

  it("observes cancellation", async () => {
    const backend = new FakeMemoryBackend({ delayMs: 100 });
    const service = new MemoryService(backend, { operationTimeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = service.health(controller.signal);
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "canceled", retryable: false }
    });
  });
});

describe("MemoryService orchestration", () => {
  it("does not invoke retrieval or capture when legacy defaults are disabled", async () => {
    const backend = new FakeMemoryBackend();
    backend.failNext("internal");
    const service = new MemoryService(backend);

    await expect(service.retrieve("pet-a", "query")).resolves.toEqual({
      ok: true,
      value: { items: [], answerPolicy: "reference" }
    });
    await expect(
      service.memorize({
        petId: "pet-a",
        requestId: "request-1",
        userText: "user",
        assistantReply: "assistant",
        occurredAt: "2026-07-13T00:00:00.000Z",
        retainSource: false
      })
    ).resolves.toEqual({ ok: true, value: { entries: [] } });
    await expect(service.health()).resolves.toMatchObject({
      ok: false,
      error: { code: "internal" }
    });
  });

  it("maps deadline aborts to timeout and backend errors without leaking unknown errors", async () => {
    const slowBackend = new FakeMemoryBackend({ delayMs: 50 });
    const slowService = new MemoryService(slowBackend, { operationTimeoutMs: 5 });
    await expect(slowService.health()).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: true }
    });

    const failedBackend = new FakeMemoryBackend();
    failedBackend.failNext("unavailable", "fixture unavailable");
    const failedService = new MemoryService(failedBackend);
    await expect(failedService.health()).resolves.toEqual({
      ok: false,
      error: { code: "unavailable", message: "fixture unavailable", retryable: true }
    });
  });

  it("rejects cross-pet mutations before they reach the backend", async () => {
    const backend = new FakeMemoryBackend();
    const service = new MemoryService(backend);
    const result = await service.upsert({ petId: "pet-a", memory: record("pet-b", "bad", "bad") });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(backend.snapshot("pet-a")).toEqual([]);
    expect(backend.snapshot("pet-b")).toEqual([]);
  });
});
