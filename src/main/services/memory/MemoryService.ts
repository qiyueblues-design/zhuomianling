import type {
  MemoryConversationTurn,
  MemoryErrorDto,
  MemoryForgetRequest,
  MemoryMemorizeResponse,
  MemoryProviderStatus,
  MemoryRebuildRequest,
  MemoryRebuildResponse,
  MemoryResult,
  MemoryRetrieveResponse,
  MemorySettings,
  MemoryUpsertRequest
} from "../../../shared/types/memory";
import { MEMORY_LIMITS } from "../../../shared/types/memory";
import {
  assertMemoryConversationTurn,
  assertMemoryMemorizeResponse,
  assertMemoryObjectBudget,
  assertBoundedMemoryString,
  assertMemoryRecord,
  assertMemoryRecordInput,
  assertMemoryRetrieveRequest,
  assertMemoryRetrieveResponse,
  normalizeMemorySettings,
  MemoryValidationError
} from "../../../shared/validation/memory";
import { isValidPetId } from "../../../shared/validation/petId";
import { MemoryBackendError, type MemoryBackend } from "./MemoryBackend";

export interface MemoryServiceOptions {
  operationTimeoutMs?: number;
}

function mapError(error: unknown, timedOut: boolean, externallyCanceled: boolean): MemoryErrorDto {
  if (externallyCanceled) {
    return { code: "canceled", message: "Memory operation was canceled.", retryable: false };
  }
  if (timedOut) {
    return { code: "timeout", message: "Memory operation timed out.", retryable: true };
  }
  if (error instanceof MemoryValidationError) {
    return { code: "invalid-request", message: error.message.slice(0, MEMORY_LIMITS.messageChars), retryable: false };
  }
  if (error instanceof MemoryBackendError) {
    return {
      code: error.code,
      message: error.message.slice(0, MEMORY_LIMITS.messageChars),
      retryable: error.retryable
    };
  }
  return { code: "internal", message: "Memory operation failed.", retryable: true };
}

function validatePetId(petId: string): string {
  if (!isValidPetId(petId)) {
    throw new MemoryValidationError("Invalid pet ID.");
  }
  return petId;
}

export class MemoryService {
  private readonly operationTimeoutMs: number;

  constructor(private readonly backend: MemoryBackend, options: MemoryServiceOptions = {}) {
    this.operationTimeoutMs = options.operationTimeoutMs ?? 1_200;
  }

  private async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<MemoryResult<T>> {
    if (signal?.aborted) {
      return { ok: false, error: mapError(undefined, false, true) };
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.operationTimeoutMs);

    try {
      const value = await operation(controller.signal);
      assertMemoryObjectBudget(value);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: mapError(error, timedOut, Boolean(signal?.aborted)) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  health(signal?: AbortSignal): Promise<MemoryResult<MemoryProviderStatus>> {
    return this.run((operationSignal) => this.backend.health(operationSignal), signal);
  }

  retrieve(
    petId: string,
    query: string,
    settingsValue?: MemorySettings,
    signal?: AbortSignal
  ): Promise<MemoryResult<MemoryRetrieveResponse>> {
    try {
      const settings = normalizeMemorySettings(settingsValue);
      const validPetId = validatePetId(petId);
      const request = {
        petId: validPetId,
        query,
        limit: settings.recallLimit,
        contextBudgetChars: settings.contextBudgetChars
      };
      assertMemoryRetrieveRequest(request);
      if (!settings.recallEnabled) {
        return Promise.resolve({ ok: true, value: { items: [] } });
      }
      return this.run(
        async (operationSignal) => {
          const response = await this.backend.retrieve(request, operationSignal);
          assertMemoryRetrieveResponse(response, validPetId);
          return response;
        },
        signal
      );
    } catch (error) {
      return Promise.resolve({ ok: false, error: mapError(error, false, false) });
    }
  }

  memorize(
    turn: MemoryConversationTurn,
    settingsValue?: MemorySettings,
    signal?: AbortSignal
  ): Promise<MemoryResult<MemoryMemorizeResponse>> {
    try {
      const settings = normalizeMemorySettings(settingsValue);
      assertMemoryConversationTurn(turn);
      if (!settings.autoCaptureEnabled) {
        return Promise.resolve({ ok: true, value: { entries: [] } });
      }
      return this.run(async (operationSignal) => {
        const response = await this.backend.memorize(turn, operationSignal);
        assertMemoryMemorizeResponse(response, turn.petId);
        return response;
      }, signal);
    } catch (error) {
      return Promise.resolve({ ok: false, error: mapError(error, false, false) });
    }
  }

  upsert(request: MemoryUpsertRequest, signal?: AbortSignal): Promise<MemoryResult<void>> {
    try {
      validatePetId(request.petId);
      assertMemoryRecordInput(request.memory);
      if (request.memory.petId !== request.petId) {
        throw new MemoryValidationError("Memory pet ID does not match its request.");
      }
      assertMemoryObjectBudget(request);
      return this.run((operationSignal) => this.backend.upsert(request, operationSignal), signal);
    } catch (error) {
      return Promise.resolve({ ok: false, error: mapError(error, false, false) });
    }
  }

  forget(request: MemoryForgetRequest, signal?: AbortSignal): Promise<MemoryResult<void>> {
    try {
      validatePetId(request.petId);
      assertBoundedMemoryString(request.memoryId, "memoryId", MEMORY_LIMITS.idChars);
      assertMemoryObjectBudget(request);
      return this.run((operationSignal) => this.backend.forget(request, operationSignal), signal);
    } catch (error) {
      return Promise.resolve({ ok: false, error: mapError(error, false, false) });
    }
  }

  rebuild(request: MemoryRebuildRequest, signal?: AbortSignal): Promise<MemoryResult<MemoryRebuildResponse>> {
    try {
      validatePetId(request.petId);
      assertBoundedMemoryString(request.targetId, "targetId", MEMORY_LIMITS.idChars);
      request.records.forEach((record) => {
        assertMemoryRecord(record);
        if (record.petId !== request.petId) {
          throw new MemoryValidationError("Rebuild snapshot crossed pet boundaries.");
        }
      });
      assertMemoryObjectBudget(request);
      return this.run((operationSignal) => this.backend.rebuild(request, operationSignal), signal);
    } catch (error) {
      return Promise.resolve({ ok: false, error: mapError(error, false, false) });
    }
  }

  closePet(petId: string, signal?: AbortSignal): Promise<MemoryResult<void>> {
    try {
      const validPetId = validatePetId(petId);
      return this.run((operationSignal) => this.backend.closePet(validPetId, operationSignal), signal);
    } catch (error) {
      return Promise.resolve({ ok: false, error: mapError(error, false, false) });
    }
  }

  close(signal?: AbortSignal): Promise<MemoryResult<void>> {
    return this.run((operationSignal) => this.backend.close(operationSignal), signal);
  }
}
