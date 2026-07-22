import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getMoodBoundaryY } from "./MoodMeter";

describe("MoodMeter geometry", () => {
  it.each([[-100,100],[-50,50],[50,50],[100,0]])("maps %s to boundary %s", (value, boundary) => {
    expect(getMoodBoundaryY(value)).toBe(boundary);
  });

  it("remains mounted after the radial menu closes", async () => {
    const source = await readFile(new URL("./PetWindow.tsx", import.meta.url), "utf8");
    expect(source).toContain("{moodMeterOpen && moodDisplay && !state.clickThrough && !closingEffect ? (");
    expect(source).not.toContain("{radialMenuOpen && moodMeterOpen && moodDisplay");
    expect(source).toMatch(/const closeRadialMenu = \(\): void => \{\s*setRadialMenuOpen\(false\);\s*\};/);
  });
});
