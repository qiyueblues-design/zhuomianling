import { describe, expect, it } from "vitest";
import { calculateSubtitleBubblePosition } from "./subtitleAnchor";

describe("subtitle right-face anchoring", () => {
  it("places the bubble to the right with its arrow centered on the face point", () => {
    expect(
      calculateSubtitleBubblePosition({
        anchor: { clientX: 120, clientY: 90 },
        bubbleWidth: 100,
        bubbleHeight: 40,
        viewportWidth: 300,
        viewportHeight: 200
      })
    ).toEqual({ left: 134, top: 72 });
  });

  it("keeps the bubble inside the right edge", () => {
    expect(
      calculateSubtitleBubblePosition({
        anchor: { clientX: 280, clientY: 90 },
        bubbleWidth: 100,
        bubbleHeight: 40,
        viewportWidth: 300,
        viewportHeight: 200
      })
    ).toEqual({ left: 192, top: 72 });
  });

  it.each([
    { name: "top", clientY: 5, expectedTop: 8 },
    { name: "bottom", clientY: 195, expectedTop: 152 }
  ])("keeps the bubble inside the $name edge", ({ clientY, expectedTop }) => {
    expect(
      calculateSubtitleBubblePosition({
        anchor: { clientX: 120, clientY },
        bubbleWidth: 100,
        bubbleHeight: 40,
        viewportWidth: 300,
        viewportHeight: 200
      }).top
    ).toBe(expectedTop);
  });
});
