import type { Live2DClientPoint } from "../../live2d/live2dModelBounds";

export interface SubtitleBubblePosition {
  left: number;
  top: number;
  availableWidth: number;
}

export interface SubtitleBubblePositionInput {
  anchor: Live2DClientPoint;
  bubbleHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

const viewportPadding = 8;
const arrowTipOffset = 12;
const arrowCenterOffset = 18;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function calculateSubtitleBubblePosition({
  anchor,
  bubbleHeight,
  viewportWidth,
  viewportHeight
}: SubtitleBubblePositionInput): SubtitleBubblePosition {
  const safeBubbleHeight = Math.max(0, Number.isFinite(bubbleHeight) ? bubbleHeight : 0);
  const safeViewportWidth = Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  const safeViewportHeight = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const preferredLeft = anchor.clientX + arrowTipOffset;
  const preferredTop = anchor.clientY - arrowCenterOffset;
  const left = Math.max(
    viewportPadding,
    Number.isFinite(preferredLeft) ? preferredLeft : viewportPadding
  );

  return {
    left,
    top: clamp(
      Number.isFinite(preferredTop) ? preferredTop : viewportPadding,
      viewportPadding,
      safeViewportHeight - safeBubbleHeight - viewportPadding
    ),
    availableWidth: Math.max(0, safeViewportWidth - viewportPadding - left)
  };
}
