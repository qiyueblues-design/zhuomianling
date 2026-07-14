import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { SubtitleState } from "../../services/subtitle/subtitleStore";
import type { Live2DClientPoint } from "../../live2d/live2dModelBounds";
import {
  calculateSubtitleBubblePosition,
  type SubtitleBubblePosition
} from "./subtitleAnchor";

interface SubtitleProps {
  state: SubtitleState;
  anchor?: Live2DClientPoint;
}

const fallbackAnchor: Live2DClientPoint = {
  clientX: 204,
  clientY: 184
};

export function Subtitle({ state, anchor }: SubtitleProps): JSX.Element | null {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<SubtitleBubblePosition>();

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;

    if (!state.visible || !bubble) {
      return;
    }

    const updatePosition = (): void => {
      const rect = bubble.getBoundingClientRect();
      const nextPosition = calculateSubtitleBubblePosition({
        anchor: anchor ?? fallbackAnchor,
        bubbleWidth: rect.width,
        bubbleHeight: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      });

      setPosition((currentPosition) =>
        currentPosition?.left === nextPosition.left && currentPosition.top === nextPosition.top
          ? currentPosition
          : nextPosition
      );
    };

    updatePosition();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
    resizeObserver?.observe(bubble);
    window.addEventListener("resize", updatePosition);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [anchor?.clientX, anchor?.clientY, state.maxWidth, state.text, state.visible]);

  if (!state.visible) {
    return null;
  }

  const viewportWidth = typeof window === "undefined" ? 380 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 430 : window.innerHeight;
  const initialPosition = calculateSubtitleBubblePosition({
    anchor: anchor ?? fallbackAnchor,
    bubbleWidth: state.maxWidth ?? 150,
    bubbleHeight: 60,
    viewportWidth,
    viewportHeight
  });
  const style: CSSProperties = {
    left: position?.left ?? initialPosition.left,
    top: position?.top ?? initialPosition.top
  };

  if (state.maxWidth) {
    style.maxWidth = `min(${state.maxWidth}px, calc(100vw - 16px))`;
  }

  return (
    <div
      ref={bubbleRef}
      className={`petSubtitleBubble tone-${state.tone}${state.isTyping ? " typing" : ""}`}
      style={style}
      aria-live="polite"
    >
      <span>{state.text}</span>
      {state.isTyping ? <span className="subtitleCaret" aria-hidden="true" /> : null}
    </div>
  );
}
