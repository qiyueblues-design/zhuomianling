import type { LocalPetConfigCorruption, PetDefinition } from "../../shared/types/pet";

export interface AvailablePetsLoadResult {
  pets: PetDefinition[];
  corruption?: LocalPetConfigCorruption;
}

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

export async function loadAvailablePets(): Promise<AvailablePetsLoadResult> {
  const result = await window.desktopPet?.petConfig.listLocal();
  const localPets = result?.pets ?? [];

  return {
    pets: localPets.filter((pet) => pet.isLocal || hasUsableLive2DModel(pet)),
    corruption: result?.corruption
  };
}
