import type { Live2DClientPoint } from "../../live2d/live2dModelBounds";

export interface SubtitleBubblePosition {
  left: number;
  top: number;
}

export interface SubtitleBubblePositionInput {
  anchor: Live2DClientPoint;
  bubbleWidth: number;
  bubbleHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

const viewportPadding = 8;
const anchorGap = 14;
const arrowCenterOffset = 18;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function calculateSubtitleBubblePosition({
  anchor,
  bubbleWidth,
  bubbleHeight,
  viewportWidth,
  viewportHeight
}: SubtitleBubblePositionInput): SubtitleBubblePosition {
  const safeBubbleWidth = Math.max(0, Number.isFinite(bubbleWidth) ? bubbleWidth : 0);
  const safeBubbleHeight = Math.max(0, Number.isFinite(bubbleHeight) ? bubbleHeight : 0);
  const safeViewportWidth = Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  const safeViewportHeight = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const preferredLeft = anchor.clientX + anchorGap;
  const preferredTop = anchor.clientY - arrowCenterOffset;

  return {
    left: clamp(
      Number.isFinite(preferredLeft) ? preferredLeft : viewportPadding,
      viewportPadding,
      safeViewportWidth - safeBubbleWidth - viewportPadding
    ),
    top: clamp(
      Number.isFinite(preferredTop) ? preferredTop : viewportPadding,
      viewportPadding,
      safeViewportHeight - safeBubbleHeight - viewportPadding
    )
  };
}
