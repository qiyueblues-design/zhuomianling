import type { PetDesktopPosition } from "../types/pet";

export const defaultPetDesktopScale = 1;
export const minPetDesktopScale = 0.7;
export const maxPetDesktopScale = 1.5;
export const petDesktopScaleStep = 0.05;
export const maxPetDesktopCoordinate = 10_000_000;

export function isPetDesktopScale(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minPetDesktopScale &&
    value <= maxPetDesktopScale
  );
}

export function normalizePetDesktopScale(value: unknown): number {
  const numericValue =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : defaultPetDesktopScale;
  const clampedValue = Math.min(maxPetDesktopScale, Math.max(minPetDesktopScale, numericValue));
  const steppedValue = Math.round(clampedValue / petDesktopScaleStep) * petDesktopScaleStep;

  return Math.round(steppedValue * 100) / 100;
}

export function normalizePetDesktopPosition(value: unknown): PetDesktopPosition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const position = value as { x?: unknown; y?: unknown };

  if (
    typeof position.x !== "number" ||
    !Number.isFinite(position.x) ||
    Math.abs(position.x) > maxPetDesktopCoordinate ||
    typeof position.y !== "number" ||
    !Number.isFinite(position.y) ||
    Math.abs(position.y) > maxPetDesktopCoordinate
  ) {
    return undefined;
  }

  return {
    x: Math.round(position.x),
    y: Math.round(position.y)
  };
}
