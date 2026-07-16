export interface Live2DModelBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Live2DClientPoint {
  clientX: number;
  clientY: number;
}

export interface Live2DCanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Live2DModelYAxis = "up" | "down";

export interface Live2DDrawableGeometry {
  vertices: ArrayLike<number>;
  visible?: boolean;
  opacity?: number;
}

const minimumVisibleDrawableOpacity = 0.001;
const rightFaceAnchorXRatio = 0.78;
const rightFaceAnchorYRatio = 0.16;

export function measureLive2DVertexBounds(
  vertexSets: Iterable<ArrayLike<number>>,
  yAxis: Live2DModelYAxis
): Live2DModelBounds | undefined {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;

  for (const vertices of vertexSets) {
    for (let index = 0; index + 1 < vertices.length; index += 2) {
      const x = vertices[index];
      const y = vertices[index + 1];

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }

      left = Math.min(left, x);
      right = Math.max(right, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
    }
  }

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(right) ||
    !Number.isFinite(minimumY) ||
    !Number.isFinite(maximumY) ||
    left >= right ||
    minimumY >= maximumY
  ) {
    return undefined;
  }

  return {
    left,
    right,
    top: yAxis === "up" ? maximumY : minimumY,
    bottom: yAxis === "up" ? minimumY : maximumY,
    width: right - left,
    height: maximumY - minimumY
  };
}

export function calculateVisibleBottomTranslation(
  scaleY: number,
  visibleBottom: number,
  targetBottom: number
): number {
  return targetBottom - scaleY * visibleBottom;
}

export function measureVisibleLive2DDrawableBounds(
  drawables: Iterable<Live2DDrawableGeometry>,
  yAxis: Live2DModelYAxis
): Live2DModelBounds | undefined {
  const visibleVertexSets: ArrayLike<number>[] = [];

  for (const drawable of drawables) {
    if (
      drawable.visible === false ||
      (typeof drawable.opacity === "number" &&
        drawable.opacity <= minimumVisibleDrawableOpacity)
    ) {
      continue;
    }

    visibleVertexSets.push(drawable.vertices);
  }

  return measureLive2DVertexBounds(visibleVertexSets, yAxis);
}

export function projectRightFaceAnchorToClientPoint(
  bounds: Live2DModelBounds,
  yAxis: Live2DModelYAxis,
  modelToClipMatrix: ArrayLike<number>,
  canvasRect: Live2DCanvasRect
): Live2DClientPoint | undefined {
  if (
    modelToClipMatrix.length < 16 ||
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isFinite(canvasRect.left) ||
    !Number.isFinite(canvasRect.top) ||
    !Number.isFinite(canvasRect.width) ||
    !Number.isFinite(canvasRect.height) ||
    canvasRect.width <= 0 ||
    canvasRect.height <= 0
  ) {
    return undefined;
  }

  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(modelToClipMatrix[index])) {
      return undefined;
    }
  }

  const modelX = bounds.left + bounds.width * rightFaceAnchorXRatio;
  const modelY =
    yAxis === "up"
      ? bounds.top - bounds.height * rightFaceAnchorYRatio
      : bounds.top + bounds.height * rightFaceAnchorYRatio;
  const clipX =
    modelToClipMatrix[0] * modelX +
    modelToClipMatrix[4] * modelY +
    modelToClipMatrix[12];
  const clipY =
    modelToClipMatrix[1] * modelX +
    modelToClipMatrix[5] * modelY +
    modelToClipMatrix[13];
  const clipW =
    modelToClipMatrix[3] * modelX +
    modelToClipMatrix[7] * modelY +
    modelToClipMatrix[15];

  if (
    !Number.isFinite(clipX) ||
    !Number.isFinite(clipY) ||
    !Number.isFinite(clipW) ||
    Math.abs(clipW) <= 0.000001
  ) {
    return undefined;
  }

  const normalizedX = clipX / clipW;
  const normalizedY = clipY / clipW;
  const clientX = canvasRect.left + (normalizedX + 1) * 0.5 * canvasRect.width;
  const clientY = canvasRect.top + (1 - normalizedY) * 0.5 * canvasRect.height;

  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return undefined;
  }

  return { clientX, clientY };
}
