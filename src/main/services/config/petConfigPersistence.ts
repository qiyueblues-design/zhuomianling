import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { PetDefinition } from "../../../shared/types/pet";
import { normalizeLegacyPetDefinition } from "../../../shared/validation/petDefinition";
import { assertValidPetId, isValidPetId } from "../../../shared/validation/petId";
import { writeJsonFileAtomically } from "./durableJsonFile";
import { withPetConfigWriteLock } from "./petConfigWriteQueue";

const localPetsDirectoryName = "pets";
const localPetFileName = "pet.local.json";
const localPetBackupFileName = `${localPetFileName}.bak`;

export type PetConfigBackupSource = "current-or-replacement" | "replacement";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containsLegacyPlaintextVoiceCredentials(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.voiceInputSettings)) {
    return false;
  }

  return ["appId", "secretId", "secretKey"].some((key) =>
    Object.prototype.hasOwnProperty.call(value.voiceInputSettings, key)
  );
}

export function assertPathContained(rootPath: string, targetPath: string, message: string): void {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(message);
  }
}

export function getLocalPetsRootPath(): string {
  return path.resolve(app.getPath("userData"), localPetsDirectoryName);
}

export function getLocalPetDirectoryPath(petId: string): string {
  const petsRootPath = getLocalPetsRootPath();
  const petDirectoryPath = path.resolve(petsRootPath, assertValidPetId(petId));
  assertPathContained(petsRootPath, petDirectoryPath, "Invalid pet directory.");
  return petDirectoryPath;
}

export function getLocalPetConfigPath(petId: string): string {
  return path.join(getLocalPetDirectoryPath(petId), localPetFileName);
}

export function getLocalPetConfigBackupPath(petId: string): string {
  return path.join(getLocalPetDirectoryPath(petId), localPetBackupFileName);
}

async function ensureRealDirectoryContained(
  rootPath: string,
  targetDirectoryPath: string,
  message: string
): Promise<void> {
  const userDataPath = path.resolve(app.getPath("userData"));
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.mkdir(rootPath, { recursive: true });
  const [realUserDataPath, realRootPath] = await Promise.all([
    fs.realpath(userDataPath),
    fs.realpath(rootPath)
  ]);
  assertPathContained(realUserDataPath, realRootPath, message);

  await fs.mkdir(targetDirectoryPath, { recursive: true });
  const realTargetPath = await fs.realpath(targetDirectoryPath);

  if (path.resolve(realRootPath) !== path.resolve(realTargetPath)) {
    assertPathContained(realRootPath, realTargetPath, message);
  }
}

export async function ensureSafeLocalPetDirectory(petId: string): Promise<string> {
  const petDirectoryPath = getLocalPetDirectoryPath(petId);
  await ensureRealDirectoryContained(
    getLocalPetsRootPath(),
    petDirectoryPath,
    "Pet directory escaped the local pets root."
  );
  return petDirectoryPath;
}

export async function assertExistingLocalPetDirectoryContained(
  petId: string
): Promise<string> {
  const targetPetId = assertValidPetId(petId);
  const userDataPath = path.resolve(app.getPath("userData"));
  const petsRootPath = getLocalPetsRootPath();
  const petDirectoryPath = getLocalPetDirectoryPath(targetPetId);
  const [realUserDataPath, realPetsRootPath, realPetDirectoryPath] = await Promise.all([
    fs.realpath(userDataPath),
    fs.realpath(petsRootPath),
    fs.realpath(petDirectoryPath)
  ]);
  assertPathContained(
    realUserDataPath,
    realPetsRootPath,
    "Local pets root escaped the application data directory."
  );
  assertPathContained(
    realPetsRootPath,
    realPetDirectoryPath,
    "Pet directory escaped the local pets root."
  );
  return petDirectoryPath;
}

export async function ensureSafeLocalPetSubdirectory(
  petId: string,
  directoryName: string
): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(directoryName)) {
    throw new Error("Invalid pet subdirectory.");
  }

  const petDirectoryPath = await ensureSafeLocalPetDirectory(petId);
  const targetDirectoryPath = path.resolve(petDirectoryPath, directoryName);
  assertPathContained(petDirectoryPath, targetDirectoryPath, "Invalid pet subdirectory.");
  await ensureRealDirectoryContained(
    petDirectoryPath,
    targetDirectoryPath,
    "Pet subdirectory escaped its pet root."
  );
  return targetDirectoryPath;
}

export function isStoredPetDefinitionForId(
  value: unknown,
  petId: string
): value is PetDefinition {
  return (
    isRecord(value) &&
    value.id === petId &&
    isValidPetId(value.id) &&
    typeof value.name === "string" &&
    Boolean(value.name.trim())
  );
}

/** Caller must hold withPetConfigWriteLock across its complete read-modify-write operation. */
export async function writePetConfigFileAtomically(
  petId: string,
  pet: PetDefinition,
  backupSource: PetConfigBackupSource = "current-or-replacement"
): Promise<void> {
  const targetPetId = assertValidPetId(petId);

  if (!isStoredPetDefinitionForId(pet, targetPetId)) {
    throw new Error("Refusing to write an invalid or mismatched pet configuration.");
  }

  if (containsLegacyPlaintextVoiceCredentials(pet)) {
    throw new Error("Refusing to persist legacy plaintext voice credentials.");
  }

  await ensureSafeLocalPetDirectory(targetPetId);
  await writeJsonFileAtomically(getLocalPetConfigPath(targetPetId), pet, {
    backup: {
      filePath: getLocalPetConfigBackupPath(targetPetId),
      source: backupSource,
      validateCurrent: (value) =>
        isStoredPetDefinitionForId(value, targetPetId) &&
        !containsLegacyPlaintextVoiceCredentials(value)
    }
  });
}

export async function readValidPetConfigBackup(
  petId: string
): Promise<PetDefinition | undefined> {
  const targetPetId = assertValidPetId(petId);

  try {
    await assertExistingLocalPetDirectoryContained(targetPetId);
    const content = (await fs.readFile(getLocalPetConfigBackupPath(targetPetId), "utf8")).replace(
      /^\uFEFF/,
      ""
    );
    const parsed = JSON.parse(content) as unknown;
    return isStoredPetDefinitionForId(parsed, targetPetId)
      ? normalizeLegacyPetDefinition(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function restorePetConfigBackupAtomically(
  petId: string,
  validateBeforeRestore?: (pet: PetDefinition) => void | Promise<void>
): Promise<PetDefinition | undefined> {
  const targetPetId = assertValidPetId(petId);

  return withPetConfigWriteLock(targetPetId, async () => {
    const backupPet = await readValidPetConfigBackup(targetPetId);

    if (!backupPet) {
      return undefined;
    }

    await validateBeforeRestore?.(backupPet);
    await ensureSafeLocalPetDirectory(targetPetId);
    await writeJsonFileAtomically(getLocalPetConfigPath(targetPetId), backupPet);
    return backupPet;
  });
}
