import {
  defaultPetVoiceModelVersion,
  petVoiceModelVersions,
  type PetVoiceModelVersion
} from "../types/pet";

export function isPetVoiceModelVersion(value: unknown): value is PetVoiceModelVersion {
  return petVoiceModelVersions.some((version) => version === value);
}

export function normalizePetVoiceModelVersion(value: unknown): PetVoiceModelVersion {
  return isPetVoiceModelVersion(value) ? value : defaultPetVoiceModelVersion;
}
