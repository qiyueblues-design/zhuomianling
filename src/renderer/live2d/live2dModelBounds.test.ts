import { describe, expect, it } from "vitest";
import {
  calculateVisibleBottomTranslation,
  measureLive2DVertexBounds,
  measureVisibleLive2DDrawableBounds,
  projectRightFaceAnchorToClientPoint
} from "./live2dModelBounds";

const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("Live2D visible model bounds", () => {
  it("measures Cubism 4/5 vertices whose Y axis points upward", () => {
    const bounds = measureLive2DVertexBounds(
      [
        new Float32Array([-1.5, -2.25, 0.5, 1.75]),
        new Float32Array([-0.25, -0.5, 2.25, 0.75])
      ],
      "up"
    );

    expect(bounds).toEqual({
      left: -1.5,
      right: 2.25,
      top: 1.75,
      bottom: -2.25,
      width: 3.75,
      height: 4
    });
  });

  it("measures Cubism 2 vertices whose Y axis points downward", () => {
    const bounds = measureLive2DVertexBounds(
      [
        [20, 80, 180, 320],
        [45, 120, 150, 275]
      ],
      "down"
    );

    expect(bounds).toEqual({
      left: 20,
      right: 180,
      top: 80,
      bottom: 320,
      width: 160,
      height: 240
    });
  });

  it("uses the lowest visible drawable instead of assuming the model canvas has feet", () => {
    const bounds = measureLive2DVertexBounds(
      [
        [-0.8, 0.9, 0.8, -0.35],
        [-0.4, 0.1, 0.4, -0.6]
      ],
      "up"
    );

    expect(bounds?.bottom).toBe(-0.6);
    expect(bounds?.bottom).not.toBe(-1);
  });

  it.each([
    {
      model: "no-feet",
      vertexSets: [
        [-0.6, 1, 0.6, -0.4],
        [-0.5, 0.2, 0.5, -0.6]
      ],
      expectedBottom: -0.6
    },
    {
      model: "floating",
      vertexSets: [[-0.8, 1.5, 0.8, 0.25]],
      expectedBottom: 0.25
    },
    {
      model: "long-skirt",
      vertexSets: [
        [-0.5, 1.2, 0.5, -0.2],
        [-0.9, 0.3, 0.9, -1.55]
      ],
      expectedBottom: -1.55
    },
    {
      model: "low-tail",
      vertexSets: [
        [-0.5, 1.2, 0.5, -0.5],
        [-0.4, 0.2, 1.3, -1.8]
      ],
      expectedBottom: -1.8
    }
  ])("anchors a $model model by its actual lowest geometry", ({ vertexSets, expectedBottom }) => {
    expect(measureLive2DVertexBounds(vertexSets, "up")?.bottom).toBe(expectedBottom);
  });

  it("excludes hidden and fully transparent Cubism 4/5 drawables from fitting", () => {
    const bounds = measureVisibleLive2DDrawableBounds(
      [
        { vertices: [-0.6, 1.2, 0.6, -0.8], visible: true, opacity: 1 },
        { vertices: [-0.4, 0.1, 0.4, -2.4], visible: false, opacity: 1 },
        { vertices: [-0.3, 0, 0.3, -2.1], visible: true, opacity: 0.001 },
        { vertices: [-0.2, -0.2, 0.8, -1.35], visible: true, opacity: 0.8 }
      ],
      "up"
    );

    expect(bounds?.bottom).toBe(-1.35);
    expect(bounds?.right).toBe(0.8);
  });

  it("calculates the translation that places the visible bottom on its target", () => {
    const scaleY = -0.005;
    const visibleBottom = 320;
    const targetBottom = -1.45;
    const translation = calculateVisibleBottomTranslation(
      scaleY,
      visibleBottom,
      targetBottom
    );

    expect(scaleY * visibleBottom + translation).toBeCloseTo(targetBottom, 10);
  });

  it("ignores malformed vertices and rejects empty or flat bounds", () => {
    expect(
      measureLive2DVertexBounds([[Number.NaN, 1, 0, 0, 2, Number.POSITIVE_INFINITY]], "up")
    ).toBeUndefined();
    expect(measureLive2DVertexBounds([[0, 1, 2, 1]], "down")).toBeUndefined();
  });

  it("projects the Cubism 4/5 right-face point from Y-up model space", () => {
    const point = projectRightFaceAnchorToClientPoint(
      { left: -1, right: 1, top: 1, bottom: -1, width: 2, height: 2 },
      "up",
      identityMatrix,
      { left: 10, top: 20, width: 200, height: 100 }
    );

    expect(point?.clientX).toBeCloseTo(194, 8);
    expect(point?.clientY).toBeCloseTo(38, 8);
  });

  it("projects the Cubism 2 right-face point from Y-down model space", () => {
    const point = projectRightFaceAnchorToClientPoint(
      { left: -1, right: 1, top: -1, bottom: 1, width: 2, height: 2 },
      "down",
      identityMatrix,
      { left: 10, top: 20, width: 200, height: 100 }
    );

    expect(point?.clientX).toBeCloseTo(194, 8);
    expect(point?.clientY).toBeCloseTo(102, 8);
  });

  it.each([0.7, 1, 1.5])("tracks a %s desktop-scale matrix", (scale) => {
    const point = projectRightFaceAnchorToClientPoint(
      { left: -1, right: 1, top: 1, bottom: -1, width: 2, height: 2 },
      "up",
      [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      { left: 0, top: 0, width: 300, height: 400 }
    );

    expect(point?.clientX).toBeCloseTo(150 + 126 * scale, 8);
    expect(point?.clientY).toBeCloseTo(200 - 128 * scale, 8);
  });

  it("rejects zero-size viewports and invalid homogeneous matrices", () => {
    const bounds = { left: -1, right: 1, top: 1, bottom: -1, width: 2, height: 2 };

    expect(
      projectRightFaceAnchorToClientPoint(bounds, "up", identityMatrix, {
        left: 0,
        top: 0,
        width: 0,
        height: 100
      })
    ).toBeUndefined();
    expect(
      projectRightFaceAnchorToClientPoint(
        bounds,
        "up",
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
        { left: 0, top: 0, width: 100, height: 100 }
      )
    ).toBeUndefined();
  });
});
