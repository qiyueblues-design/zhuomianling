import type { PetDefinition } from "../../shared/types/pet";

export function hasUsableLive2DModel(pet: PetDefinition): boolean {
  if (!pet.modelPath.trim()) {
    return false;
  }

  if (pet.live2dSettings?.entryFileName) {
    return true;
  }

  return pet.details.features.some((feature) =>
    feature.title === "Live2D 显示" && feature.status === "ready"
  );
}

export async function loadAvailablePets(): Promise<PetDefinition[]> {
  const localPets = (await window.desktopPet?.petConfig.listLocal()) ?? [];

  return localPets.filter((pet) => pet.isLocal || hasUsableLive2DModel(pet));
}
