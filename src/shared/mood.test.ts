import { describe, expect, it } from "vitest";
import { calculateEffectiveMood, clampMoodValue, getMoodRange, moodVoiceFallbackChains } from "./mood";

describe("mood rules", () => {
  it.each([
    [-100,"darkened"],[-90,"darkened"],[-89,"slump"],[-61,"slump"],[-60,"downcast"],[-21,"downcast"],
    [-20,"calm"],[0,"calm"],[20,"calm"],[21,"pleasant"],[60,"pleasant"],[61,"joyful"],[89,"joyful"],[90,"excited"],[100,"excited"]
  ])("maps %s to %s", (value, id) => expect(getMoodRange(value).id).toBe(id));

  it("clamps finite integers and rejects non-finite input safely", () => {
    expect(clampMoodValue(120.9)).toBe(100);
    expect(clampMoodValue(-120)).toBe(-100);
    expect(clampMoodValue(Number.NaN)).toBe(0);
  });

  it("decays toward zero after the hold period without crossing it", () => {
    const start = 1_000_000;
    expect(calculateEffectiveMood(10, start, start + 10 * 60_000)).toBe(10);
    expect(calculateEffectiveMood(10, start, start + 15 * 60_000)).toBe(9);
    expect(calculateEffectiveMood(-2, start, start + 30 * 60_000)).toBe(0);
    expect(calculateEffectiveMood(100, start, start + 8 * 60 * 60_000)).toBe(6);
  });

  it("uses one-way voice fallback chains", () => {
    expect(moodVoiceFallbackChains.darkened).toEqual(["darkened","slump","downcast","calm"]);
    expect(moodVoiceFallbackChains.excited).toEqual(["excited","joyful","pleasant","calm"]);
  });
});
