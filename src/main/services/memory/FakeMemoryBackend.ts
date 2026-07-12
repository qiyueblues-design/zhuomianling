import type {
  MemoryConversationTurn,
  MemoryErrorCode,
  MemoryForgetRequest,
  MemoryMemorizeResponse,
  MemoryProviderStatus,
  MemoryRebuildRequest,
  MemoryRebuildResponse,
  MemoryRecord,
  MemoryRecordInput,
  MemoryRetrieveRequest,
  MemoryRetrieveResponse,
  MemoryUpsertRequest
} from "../../../shared/types/memory";
import {
  assertMemoryConversationTurn,
  assertMemoryObjectBudget,
  assertMemoryRecordInput,
  assertMemoryRetrieveRequest
} from "../../../shared/validation/memory";
import { assertValidPetId } from "../../../shared/validation/petId";
import { MemoryBackendError, type MemoryBackend } from "./MemoryBackend";

export interface FakeMemoryBackendOptions {
  delayMs?: number;
  now?: () => string;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MemoryBackendError("canceled", "Memory operation was canceled.", false);
  }
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new MemoryBackendError("canceled", "Memory operation was canceled.", false));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  throwIfAborted(signal);
}

function toRecord(input: MemoryRecordInput, now: string): MemoryRecord {
  return {
    id: input.id,
    petId: input.petId,
    chapter: input.chapter,
    memoryType: input.memoryType,
    content: input.content,
    tags: [...(input.tags ?? [])],
    important: input.important ?? false,
    origin: input.origin,
    sourceTime: input.sourceTime,
    sourceAvailable: input.sourceAvailable ?? false,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    deletedAt: input.deletedAt,
    revision: input.revision ?? 1
  };
}

export class FakeMemoryBackend implements MemoryBackend {
  private readonly records = new Map<string, Map<string, MemoryRecord>>();
  private readonly failures: MemoryBackendError[] = [];
  private readonly delayMs: number;
  private readonly now: () => string;
  private closed = false;

  constructor(options: FakeMemoryBackendOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.now = options.now ?? (() => "2026-01-01T00:00:00.000Z");
  }

  failNext(
    code: Extract<
      MemoryErrorCode,
      "canceled" | "timeout" | "unavailable" | "invalid-config" | "index-dirty" | "internal"
    >,
    message = `Fake ${code}`
  ): void {
    this.failures.push(new MemoryBackendError(code, message));
  }

  snapshot(petId: string): MemoryRecord[] {
    return [...(this.records.get(petId)?.values() ?? [])].map((record) => ({
      ...record,
      tags: [...record.tags]
    }));
  }

  private async begin(signal: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new MemoryBackendError("unavailable", "Fake memory backend is closed.");
    }
    await waitForDelay(this.delayMs, signal);
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  private petRecords(petId: string): Map<string, MemoryRecord> {
    let records = this.records.get(petId);
    if (!records) {
      records = new Map();
      this.records.set(petId, records);
    }
    return records;
  }

  async health(signal: AbortSignal): Promise<MemoryProviderStatus> {
    await this.begin(signal);
    return { state: "ready" };
  }

  async retrieve(
    request: MemoryRetrieveRequest,
    signal: AbortSignal
  ): Promise<MemoryRetrieveResponse> {
    await this.begin(signal);
    assertMemoryRetrieveRequest(request);
    const query = request.query.trim().toLocaleLowerCase();
    let usedChars = 0;
    const items = this.snapshot(request.petId)
      .filter((record) => !record.deletedAt)
      .map((memory) => {
        const content = memory.content.toLocaleLowerCase();
        const tagMatch = memory.tags.some((tag) => tag.toLocaleLowerCase().includes(query));
        return { memory, score: content.includes(query) ? 1 : tagMatch ? 0.8 : 0.1 };
      })
      .sort((left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id))
      .filter(({ memory }) => {
        if (usedChars + memory.content.length > request.contextBudgetChars) return false;
        usedChars += memory.content.length;
        return true;
      })
      .slice(0, request.limit);
    const response = { items };
    assertMemoryObjectBudget(response);
    return response;
  }

  async memorize(
    turn: MemoryConversationTurn,
    signal: AbortSignal
  ): Promise<MemoryMemorizeResponse> {
    await this.begin(signal);
    assertMemoryConversationTurn(turn);
    const entry: MemoryRecordInput = {
      id: `auto-${turn.requestId}`,
      petId: turn.petId,
      chapter: "about_you",
      memoryType: "profile",
      content: turn.userText,
      origin: "automatic",
      sourceTime: turn.occurredAt,
      sourceAvailable: turn.retainSource
    };
    await this.upsertWithoutDelay({ petId: turn.petId, memory: entry });
    return { entries: [entry] };
  }

  private async upsertWithoutDelay(request: MemoryUpsertRequest): Promise<void> {
    assertValidPetId(request.petId);
    assertMemoryRecordInput(request.memory);
    if (request.memory.petId !== request.petId) {
      throw new MemoryBackendError("internal", "Memory pet ID does not match its request.", false);
    }
    this.petRecords(request.petId).set(request.memory.id, toRecord(request.memory, this.now()));
  }

  async upsert(request: MemoryUpsertRequest, signal: AbortSignal): Promise<void> {
    await this.begin(signal);
    await this.upsertWithoutDelay(request);
  }

  async forget(request: MemoryForgetRequest, signal: AbortSignal): Promise<void> {
    await this.begin(signal);
    assertValidPetId(request.petId);
    this.petRecords(request.petId).delete(request.memoryId);
  }

  async rebuild(
    request: MemoryRebuildRequest,
    signal: AbortSignal
  ): Promise<MemoryRebuildResponse> {
    await this.begin(signal);
    assertValidPetId(request.petId);
    const replacement = new Map<string, MemoryRecord>();
    for (const record of request.records) {
      assertMemoryRecordInput(record);
      if (record.petId !== request.petId) {
        throw new MemoryBackendError("internal", "Rebuild snapshot crossed pet boundaries.", false);
      }
      replacement.set(record.id, toRecord(record, this.now()));
    }
    this.records.set(request.petId, replacement);
    return { indexedCount: replacement.size };
  }

  async closePet(petId: string, signal: AbortSignal): Promise<void> {
    await this.begin(signal);
    assertValidPetId(petId);
  }

  async close(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.closed = true;
  }
}
