import path from "node:path";
import { assertValidPetId } from "../../../shared/validation/petId";
import { getLocalPetDirectoryPath } from "../config/petConfigPersistence";

export function getMoodDirectoryPath(petId: string): string {
  return path.join(getLocalPetDirectoryPath(assertValidPetId(petId)), "mood");
}

export function getMoodStatePath(petId: string): string {
  return path.join(getMoodDirectoryPath(petId), "state.json");
}

export function getMoodVoiceRootPath(petId: string): string {
  return path.join(getLocalPetDirectoryPath(assertValidPetId(petId)), "voice", "mood");
}

export function getMoodVoiceRangePath(petId: string, rangeId: import("../../../shared/mood").PetMoodRangeId): string {
  return path.join(getMoodVoiceRootPath(petId), rangeId);
}
