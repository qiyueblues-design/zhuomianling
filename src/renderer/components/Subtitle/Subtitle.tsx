import type { CSSProperties } from "react";
import type { SubtitleState } from "../../services/subtitle/subtitleStore";

interface SubtitleProps {
  state: SubtitleState;
}

export function Subtitle({ state }: SubtitleProps): JSX.Element | null {
  if (!state.visible) {
    return null;
  }

  const style: CSSProperties = {};

  if (state.maxWidth) {
    style.maxWidth = state.maxWidth;
  }

  return (
    <div
      className={`petSubtitleBubble tone-${state.tone}${state.isTyping ? " typing" : ""}`}
      style={style}
      aria-live="polite"
    >
      <span>{state.text}</span>
      {state.isTyping ? <span className="subtitleCaret" aria-hidden="true" /> : null}
    </div>
  );
}
