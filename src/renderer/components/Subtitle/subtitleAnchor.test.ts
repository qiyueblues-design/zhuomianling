import { describe, expect, it } from "vitest";
import { calculateSubtitleBubblePosition } from "./subtitleAnchor";

describe("subtitle right-face anchoring", () => {
  it("places the bubble to the right with its arrow centered on the face point", () => {
    expect(
      calculateSubtitleBubblePosition({
        anchor: { clientX: 120, clientY: 90 },
        bubbleHeight: 40,
        viewportWidth: 300,
        viewportHeight: 200
      })
    ).toEqual({ left: 132, top: 72, availableWidth: 160 });
  });

  it("keeps the arrow tip anchored and narrows the bubble at the right edge", () => {
    expect(
      calculateSubtitleBubblePosition({
        anchor: { clientX: 250, clientY: 90 },
        bubbleHeight: 40,
        viewportWidth: 300,
        viewportHeight: 200
      })
    ).toEqual({ left: 262, top: 72, availableWidth: 30 });
  });

  it.each([
    { name: "top", clientY: 5, expectedTop: 8 },
    { name: "bottom", clientY: 195, expectedTop: 152 }
  ])("keeps the bubble inside the $name edge", ({ clientY, expectedTop }) => {
    expect(
      calculateSubtitleBubblePosition({
        anchor: { clientX: 120, clientY },
        bubbleHeight: 40,
        viewportWidth: 300,
        viewportHeight: 200
      }).top
    ).toBe(expectedTop);
  });
});
