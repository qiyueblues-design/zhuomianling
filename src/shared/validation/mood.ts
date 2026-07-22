import { isPetMoodRangeId, isSystemMoodEvent, type SystemMoodEvent } from "../mood";
import type { PersistedPetMoodState, PetMoodMeterPosition } from "../types/mood";

const maxFutureTimestampMs = 366 * 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeMoodMeterPosition(value: unknown): PetMoodMeterPosition | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.left !== "number" || typeof value.top !== "number" ||
      !Number.isFinite(value.left) || !Number.isFinite(value.top) ||
      Math.abs(value.left) > 100_000 || Math.abs(value.top) > 100_000) {
    throw new Error("心情胶囊位置无效。");
  }
  return { left: value.left, top: value.top };
}

export function parsePersistedMoodState(value: unknown, now = Date.now()): PersistedPetMoodState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isInteger(value.baseValue) ||
      (value.baseValue as number) < -100 || (value.baseValue as number) > 100 ||
      typeof value.baseChangedAt !== "number" || !Number.isFinite(value.baseChangedAt) ||
      (value.baseChangedAt as number) < 0 || (value.baseChangedAt as number) > now + maxFutureTimestampMs) {
    throw new Error("MOOD_STATE_CORRUPTED");
  }
  const cooldowns: Partial<Record<SystemMoodEvent, number>> = {};
  if (value.eventCooldowns !== undefined) {
    if (!isRecord(value.eventCooldowns)) throw new Error("MOOD_STATE_CORRUPTED");
    for (const [key, timestamp] of Object.entries(value.eventCooldowns)) {
      const normalizedKey = key === "drag" ? "dragCompleted" : key;
      if (!isSystemMoodEvent(normalizedKey) || typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0 || timestamp > now + maxFutureTimestampMs) {
        throw new Error("MOOD_STATE_CORRUPTED");
      }
      cooldowns[normalizedKey] = Math.max(cooldowns[normalizedKey] ?? 0, timestamp);
    }
  }
  const globalUntil = value.globalEventCooldownUntil;
  if (globalUntil !== undefined && (typeof globalUntil !== "number" || !Number.isFinite(globalUntil) || globalUntil < 0 || globalUntil > now + maxFutureTimestampMs)) {
    throw new Error("MOOD_STATE_CORRUPTED");
  }
  return {
    schemaVersion: 1,
    baseValue: value.baseValue as number,
    baseChangedAt: value.baseChangedAt as number,
    eventCooldowns: cooldowns,
    globalEventCooldownUntil: globalUntil as number | undefined,
    meterPosition: normalizeMoodMeterPosition(value.meterPosition)
  };
}

export function assertMoodRangeId(value: unknown): asserts value is import("../mood").PetMoodRangeId {
  if (!isPetMoodRangeId(value)) throw new Error("未知的心情区间。");
}
