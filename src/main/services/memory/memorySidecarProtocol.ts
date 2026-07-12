import { MEMORY_LIMITS } from "../../../shared/types/memory";
import { MemoryValidationError } from "../../../shared/validation/memory";

export const MEMORY_SIDECAR_PROTOCOL_VERSION = 1;
export const MEMORY_SIDECAR_MAX_LINE_BYTES = 65_536;
export const MEMORY_SIDECAR_MAX_DEADLINE_MS = 60_000;
const maxDepth = 16;
const maxArrayItems = 100;
const maxObjectKeys = 128;
const maxStringChars = 32_768;

export interface MemorySidecarRequest {
  id: string;
  method: string;
  petId?: string;
  deadlineMs: number;
  params: Record<string, unknown>;
}

export interface MemorySidecarErrorPayload {
  code: string;
  message: string;
}

export type MemorySidecarResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: MemorySidecarErrorPayload };

export interface MemorySidecarHandshake {
  sidecarVersion: string;
  protocolVersion: number;
  pythonVersion: string;
  memuVersion: string | null;
  schemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateSidecarValueBudget(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let stringChars = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > maxDepth) throw new MemoryValidationError("Sidecar payload is too deep.");
    if (typeof current.value === "string") {
      stringChars += current.value.length;
      if (stringChars > maxStringChars) throw new MemoryValidationError("Sidecar strings exceed their budget.");
    } else if (Array.isArray(current.value)) {
      if (current.value.length > maxArrayItems) throw new MemoryValidationError("Sidecar array exceeds its budget.");
      current.value.forEach((item) => stack.push({ value: item, depth: current.depth + 1 }));
    } else if (isRecord(current.value)) {
      const entries = Object.entries(current.value);
      if (entries.length > maxObjectKeys) throw new MemoryValidationError("Sidecar object exceeds its key budget.");
      entries.forEach(([key, item]) => {
        stringChars += key.length;
        if (stringChars > maxStringChars) {
          throw new MemoryValidationError("Sidecar strings exceed their budget.");
        }
        stack.push({ value: item, depth: current.depth + 1 });
      });
    } else if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new MemoryValidationError("Sidecar numbers must be finite.");
    } else if (
      current.value !== null &&
      typeof current.value !== "boolean" &&
      typeof current.value !== "number"
    ) {
      throw new MemoryValidationError("Sidecar payload contains an unsupported value.");
    }
  }
}

export function parseSidecarResponse(line: Buffer): MemorySidecarResponse {
  if (line.byteLength > MEMORY_SIDECAR_MAX_LINE_BYTES) {
    throw new MemoryValidationError("Sidecar response exceeds its byte budget.");
  }
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    throw new MemoryValidationError("Sidecar response is not valid JSON.");
  }
  validateSidecarValueBudget(value);
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.ok !== "boolean") {
    throw new MemoryValidationError("Sidecar response has an invalid envelope.");
  }
  const allowed = value.ok ? ["id", "ok", "result"] : ["id", "ok", "error"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new MemoryValidationError("Sidecar response contains unknown fields.");
  }
  if (value.ok) {
    if (!Object.prototype.hasOwnProperty.call(value, "result")) {
      throw new MemoryValidationError("Sidecar success response has no result.");
    }
    return { id: value.id, ok: true, result: value.result };
  }
  if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
    throw new MemoryValidationError("Sidecar error response is invalid.");
  }
  if (value.error.code.length > 64 || value.error.message.length > MEMORY_LIMITS.messageChars) {
    throw new MemoryValidationError("Sidecar error exceeds its string budget.");
  }
  return {
    id: value.id,
    ok: false,
    error: { code: value.error.code, message: value.error.message }
  };
}

export function assertHandshake(value: unknown): MemorySidecarHandshake {
  if (!isRecord(value)) throw new MemoryValidationError("Sidecar handshake is invalid.");
  const handshake = value as Partial<MemorySidecarHandshake>;
  const allowed = ["sidecarVersion", "protocolVersion", "pythonVersion", "memuVersion", "schemaVersion"];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof handshake.sidecarVersion !== "string" ||
    handshake.protocolVersion !== MEMORY_SIDECAR_PROTOCOL_VERSION ||
    typeof handshake.pythonVersion !== "string" ||
    !/^3\.13(?:\.|$)/.test(handshake.pythonVersion) ||
    (handshake.memuVersion !== null && typeof handshake.memuVersion !== "string") ||
    handshake.schemaVersion !== 1
  ) {
    throw new MemoryValidationError("Sidecar handshake is incompatible.");
  }
  return handshake as MemorySidecarHandshake;
}
