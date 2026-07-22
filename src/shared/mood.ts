export const petMoodRanges = [
  { id: "darkened", label: "黑化", min: -100, max: -90 },
  { id: "slump", label: "低迷", min: -89, max: -61 },
  { id: "downcast", label: "失落", min: -60, max: -21 },
  { id: "calm", label: "平静", min: -20, max: 20 },
  { id: "pleasant", label: "愉快", min: 21, max: 60 },
  { id: "joyful", label: "喜悦", min: 61, max: 89 },
  { id: "excited", label: "兴奋", min: 90, max: 100 }
] as const;

export type PetMoodRangeId = (typeof petMoodRanges)[number]["id"];
export type SystemMoodEvent = "click" | "rapidClick" | "dragCompleted" | "chatOpened";

export const systemMoodEventRules: Readonly<Record<SystemMoodEvent, {
  delta: number;
  cooldownMs: number;
}>> = {
  click: { delta: 2, cooldownMs: 30_000 },
  rapidClick: { delta: -8, cooldownMs: 90_000 },
  dragCompleted: { delta: 1, cooldownMs: 60_000 },
  chatOpened: { delta: 1, cooldownMs: 60_000 }
};

export const moodGlobalEventCooldownMs = 15_000;
export const moodDecayDelayMs = 10 * 60_000;
export const moodDecayStepMs = 5 * 60_000;

export const moodVoiceFallbackChains: Readonly<Record<PetMoodRangeId, readonly PetMoodRangeId[]>> = {
  darkened: ["darkened", "slump", "downcast", "calm"],
  slump: ["slump", "downcast", "calm"],
  downcast: ["downcast", "calm"],
  calm: ["calm"],
  pleasant: ["pleasant", "calm"],
  joyful: ["joyful", "pleasant", "calm"],
  excited: ["excited", "joyful", "pleasant", "calm"]
};

export function clampMoodValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-100, Math.min(100, Math.trunc(value)));
}

export function getMoodRange(value: number): (typeof petMoodRanges)[number] {
  const normalized = clampMoodValue(value);
  return petMoodRanges.find((range) => normalized >= range.min && normalized <= range.max)
    ?? petMoodRanges[3];
}

export function isPetMoodRangeId(value: unknown): value is PetMoodRangeId {
  return typeof value === "string" && petMoodRanges.some((range) => range.id === value);
}

export function isSystemMoodEvent(value: unknown): value is SystemMoodEvent {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(systemMoodEventRules, value);
}

export function calculateEffectiveMood(baseValue: number, baseChangedAt: number, now: number): number {
  const value = clampMoodValue(baseValue);
  if (!Number.isFinite(baseChangedAt) || !Number.isFinite(now) || now <= baseChangedAt + moodDecayDelayMs) {
    return value;
  }
  const steps = Math.floor((now - baseChangedAt - moodDecayDelayMs) / moodDecayStepMs);
  if (steps <= 0) {
    return value;
  }
  return value > 0 ? Math.max(0, value - steps) : Math.min(0, value + steps);
}
