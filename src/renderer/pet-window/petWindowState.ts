import type { PetDefinition } from "../../shared/types/pet";
import type { DesktopPetPayload, PetWindowState } from "../../shared/types/window";

export interface PetWindowRouteState {
  petId: string;
  petName: string;
  modelPath: string;
  avatar: string;
  petDefinition?: PetDefinition;
}

function parsePetDefinition(value: string | null): PetDefinition | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as PetDefinition;

    return parsed.id && parsed.name ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readSearchParams(): PetWindowRouteState {
  const params = new URLSearchParams(window.location.search);
  const petName = params.get("petName") ?? "桌宠";

  return {
    petId: params.get("petId") ?? "unknown",
    petName,
    modelPath: params.get("modelPath") ?? "",
    avatar: params.get("avatar") ?? petName.slice(0, 2).toUpperCase(),
    petDefinition: parsePetDefinition(params.get("petDefinition"))
  };
}

export function createPetWindowStateFromPayload(
  payload: DesktopPetPayload,
  fallbackPet: PetWindowRouteState
): PetWindowRouteState {
  return {
    petId: payload.id,
    petName: payload.name,
    modelPath: payload.modelPath,
    avatar: payload.avatar ?? payload.name.slice(0, 2).toUpperCase(),
    petDefinition: payload.definition ?? fallbackPet.petDefinition
  };
}

export const fallbackState: PetWindowState = {
  visible: true,
  clickThrough: false
};
