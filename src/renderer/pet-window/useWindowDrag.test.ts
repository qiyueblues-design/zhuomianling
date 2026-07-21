import { describe, expect, it } from "vitest";
import { calculateChatPanelAppearancePosition } from "./useWindowDrag";

describe("chat panel appearance positioning", () => {
  it("aligns the chat panel center to the model canvas 50% axis", () => {
    expect(calculateChatPanelAppearancePosition({
      viewportWidth: 380,
      panelWidth: 252,
      modelCanvasLeft: 10,
      modelCanvasWidth: 295
    })).toEqual({
      left: 31.5,
      bottom: 8
    });
  });

  it("falls back to the model canvas left edge when the panel no longer fits its width", () => {
    expect(calculateChatPanelAppearancePosition({
      viewportWidth: 266,
      panelWidth: 248,
      modelCanvasLeft: 10,
      modelCanvasWidth: 202
    })).toEqual({
      left: 10,
      bottom: 8
    });
  });

  it("keeps the appearance position inside the viewport edge padding", () => {
    expect(calculateChatPanelAppearancePosition({
      viewportWidth: 240,
      panelWidth: 230,
      modelCanvasLeft: -20,
      modelCanvasWidth: 180
    })).toEqual({
      left: 8,
      bottom: 8
    });
  });
});
