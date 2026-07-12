import type {
  MemoryConversationTurn,
  MemoryErrorCode,
  MemoryForgetRequest,
  MemoryMemorizeResponse,
  MemoryProviderStatus,
  MemoryRebuildRequest,
  MemoryRebuildResponse,
  MemoryRetrieveRequest,
  MemoryRetrieveResponse,
  MemoryUpsertRequest
} from "../../../shared/types/memory";

export class MemoryBackendError extends Error {
  constructor(
    readonly code: Extract<
      MemoryErrorCode,
      "canceled" | "timeout" | "unavailable" | "invalid-config" | "index-dirty" | "internal"
    >,
    message: string,
    readonly retryable = code === "timeout" || code === "unavailable" || code === "internal"
  ) {
    super(message);
    this.name = "MemoryBackendError";
  }
}

export interface MemoryBackend {
  health(signal: AbortSignal): Promise<MemoryProviderStatus>;
  retrieve(request: MemoryRetrieveRequest, signal: AbortSignal): Promise<MemoryRetrieveResponse>;
  memorize(turn: MemoryConversationTurn, signal: AbortSignal): Promise<MemoryMemorizeResponse>;
  upsert(request: MemoryUpsertRequest, signal: AbortSignal): Promise<void>;
  forget(request: MemoryForgetRequest, signal: AbortSignal): Promise<void>;
  rebuild(request: MemoryRebuildRequest, signal: AbortSignal): Promise<MemoryRebuildResponse>;
  closePet(petId: string, signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
}
