import type { MemoryErrorDto } from "../../../shared/types/memory";
import { MEMORY_LIMITS } from "../../../shared/types/memory";
import { MemoryValidationError } from "../../../shared/validation/memory";
import { MemoryLedgerError } from "./MemoryLedger";
import { MemoryBackendError } from "./MemoryBackend";

export function toMemoryErrorDto(error: unknown): MemoryErrorDto {
  if (error instanceof MemoryValidationError) {
    return {
      code: "invalid-request",
      message: error.message.slice(0, MEMORY_LIMITS.messageChars),
      retryable: false
    };
  }
  if (error instanceof MemoryLedgerError) {
    switch (error.code) {
      case "MEMORY_NOT_FOUND":
        return { code: "not-found", message: error.message, retryable: false };
      case "MEMORY_REVISION_CONFLICT":
        return { code: "conflict", message: error.message, retryable: false };
      case "MEMORY_STORAGE_UNAVAILABLE":
        return { code: "storage-unavailable", message: error.message, retryable: true };
      case "LEDGER_CORRUPTED":
      case "LEDGER_VERSION_UNSUPPORTED":
        return { code: "ledger-corrupted", message: error.message, retryable: false };
    }
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
