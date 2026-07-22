import type { CSSProperties } from "react";
import type { PetMoodDisplayState, PetMoodMeterPosition } from "../../shared/types/mood";
import type { PetCustomThemeMoodMeter, PetMoodMeterParticleStyle, PetUiTheme } from "../../shared/types/pet";
import type { PetMoodRangeId } from "../../shared/mood";
import { useMoodMeterDrag } from "./useMoodMeterDrag";

const themeParticleStyles: Record<PetUiTheme, PetMoodMeterParticleStyle> = {
  soft: "float",
  rock: "dust",
  pixel: "pixel",
  journal: "float",
  cyber: "scan",
  minimal: "minimal",
  custom: "minimal"
};

const moodWaveAmplitude: Record<PetMoodRangeId, number> = {
  darkened: 3.2,
  slump: 1.8,
  downcast: 0.9,
  calm: 0.45,
  pleasant: 0.9,
  joyful: 1.8,
  excited: 3.2
};

export function getMoodBoundaryY(value: number): number {
  const progress = Math.abs(value) / 100;
  return value > 0 ? 100 * (1 - progress) : 100 * progress;
}

function Capsule({ value, direction, theme, rangeId, waveAmplitude }: { value: number; direction: "positive" | "negative"; theme: PetUiTheme; rangeId: PetMoodRangeId; waveAmplitude?: number }): JSX.Element {
  const boundary = value === 0 ? (direction === "positive" ? 96 : 4) : getMoodBoundaryY(value);
  const amplitude = waveAmplitude ?? moodWaveAmplitude[rangeId];
  const wave = theme === "pixel"
    ? `M 0 ${boundary} H 8 V ${boundary - amplitude} H 16 V ${boundary + amplitude} H 24 V ${boundary} H 32`
    : `M 0 ${boundary} Q 8 ${boundary - amplitude} 16 ${boundary} T 32 ${boundary}`;
  const fill = direction === "positive" ? `${wave} L 32 100 L 0 100 Z` : `${wave} L 32 0 L 0 0 Z`;

  return <div className={`moodCapsule ${direction}`} style={{ "--mood-boundary": `${boundary}%` } as CSSProperties}>
    <svg viewBox="0 0 32 100" aria-hidden="true">
      <rect className="moodUnfilled" width="32" height="100" />
      <path className="moodFilled" d={fill} />
      <path className="moodBoundary" d={wave} />
    </svg>
    <strong>{value > 0 ? `+${value}` : value}</strong>
    <i /><i /><i />
  </div>;
}

export function MoodMeter({ state, theme, customization, fallbackPosition }: { state: PetMoodDisplayState; theme: PetUiTheme; customization?: PetCustomThemeMoodMeter; fallbackPosition: PetMoodMeterPosition }): JSX.Element {
  const zero = state.value === 0;
  const drag = useMoodMeterDrag(state.meterPosition, zero ? 208 : 100, fallbackPosition);
  const direction = state.rangeId === "calm" ? "calm" : state.value > 0 ? "up" : "down";
  const rangeStyle = theme === "custom" ? customization?.ranges?.[state.rangeId] : undefined;
  const style = {
    left: drag.position.left,
    top: drag.position.top,
    ...(theme === "custom" && customization ? {
      "--mood-surface": customization.surface,
      "--mood-empty": customization.emptyColor,
      "--mood-text": customization.textColor,
      "--mood-frame-color": customization.frameColor ?? "var(--mood-active)",
      "--mood-boundary-color": customization.boundaryColor ?? "var(--mood-active)",
      "--mood-particle-color": customization.particleColor ?? "var(--mood-active)",
      "--mood-custom-shadow": customization.shadow,
      "--mood-custom-inset-shadow": customization.insetShadow,
      ...(rangeStyle ? {
        "--mood-frame-alpha": `${rangeStyle.frameOpacity * 100}%`,
        "--mood-glow-alpha": `${rangeStyle.glowOpacity * 100}%`,
        "--mood-glow-size": `${rangeStyle.glowRadius}px`,
        "--mood-liquid-alpha": `${rangeStyle.liquidOpacity * 100}%`,
        "--mood-line-width": rangeStyle.boundaryWidth,
        "--mood-particle-opacity": rangeStyle.particleOpacity,
        "--mood-aura-opacity": rangeStyle.auraOpacity,
        "--mood-accent-opacity": rangeStyle.accentOpacity,
        "--mood-line-speed": `${rangeStyle.animationSeconds}s`,
        "--mood-effect-speed": `${rangeStyle.animationSeconds}s`
      } : {})
    } : {})
  } as CSSProperties;
  const frame = customization?.frame ?? "soft-pill";
  const particleStyle = customization?.particleStyle ?? themeParticleStyles[theme];
  const effectStyle = customization?.effectStyle ?? "halo";
  return <div className={`moodMeter theme-${theme} frame-${frame} range-${state.rangeId} direction-${direction} particle-${particleStyle} effect-${effectStyle} ${zero ? "zero" : ""}`} style={style} role="meter" aria-label={`当前心情：${state.label}，${state.value}`} aria-valuemin={-100} aria-valuemax={100} aria-valuenow={state.value} aria-valuetext={`${state.label} ${state.value}`} {...drag}>
    {state.value >= 0 ? <Capsule value={state.value} direction="positive" theme={theme} rangeId={state.rangeId} waveAmplitude={rangeStyle?.waveAmplitude} /> : null}
    {state.value <= 0 ? <Capsule value={state.value} direction="negative" theme={theme} rangeId={state.rangeId} waveAmplitude={rangeStyle?.waveAmplitude} /> : null}
  </div>;
}
