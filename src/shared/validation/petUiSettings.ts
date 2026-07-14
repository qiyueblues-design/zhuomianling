export const defaultPetDesktopScale = 1;
export const minPetDesktopScale = 0.7;
export const maxPetDesktopScale = 1.5;
export const petDesktopScaleStep = 0.05;

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
