import fs from "node:fs/promises";
import path from "node:path";
import { assertValidPetId } from "../../../shared/validation/petId";
import {
  assertPathContained,
  assertExistingLocalPetDirectoryContained
} from "../config/petConfigPersistence";

export interface MemoryPaths {
  directory: string;
  ledger: string;
  ledgerBackup: string;
  pending: string;
  meta: string;
}

export async function assertSafeExistingMemoryEntry(rootPath: string, entryPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) throw new Error("Memory storage must not contain symbolic links.");
    const realPath = await fs.realpath(entryPath);
    assertPathContained(rootPath, realPath, "Memory storage escaped its pet directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function getMemoryPaths(directoryPath: string): MemoryPaths {
  const directory = path.resolve(directoryPath);
  return {
    directory,
    ledger: path.join(directory, "ledger.sqlite3"),
    ledgerBackup: path.join(directory, "ledger.sqlite3.bak"),
    pending: path.join(directory, "pending"),
    meta: path.join(directory, "meta.json")
  };
}

export async function ensureSafeMemoryPaths(petId: string): Promise<MemoryPaths> {
  assertValidPetId(petId);
  const petDirectory = await assertExistingLocalPetDirectoryContained(petId);
  const directory = await ensureSafeMemoryChildDirectory(petDirectory, "memory");
  const paths = getMemoryPaths(directory);
  await Promise.all([
    assertSafeExistingMemoryEntry(directory, paths.ledger),
    assertSafeExistingMemoryEntry(directory, paths.ledgerBackup),
    assertSafeExistingMemoryEntry(directory, paths.pending),
    assertSafeExistingMemoryEntry(directory, paths.meta)
  ]);
  return paths;
}

export async function ensureMemoryPathsAtDirectory(directoryPath: string): Promise<MemoryPaths> {
  const directory = path.resolve(directoryPath);
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink()) throw new Error("Memory directory must not be a symbolic link.");
  const realDirectory = await fs.realpath(directory);
  const paths = getMemoryPaths(realDirectory);
  await Promise.all([
    assertSafeExistingMemoryEntry(realDirectory, paths.ledger),
    assertSafeExistingMemoryEntry(realDirectory, paths.ledgerBackup),
    assertSafeExistingMemoryEntry(realDirectory, paths.pending),
    assertSafeExistingMemoryEntry(realDirectory, paths.meta)
  ]);
  return paths;
}

export async function ensureSafeMemoryChildDirectory(
  memoryDirectory: string,
  childName: string
): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(childName)) throw new Error("Invalid memory subdirectory.");
  const root = await fs.realpath(memoryDirectory);
  const child = path.resolve(root, childName);
  assertPathContained(root, child, "Memory subdirectory escaped its root.");
  await fs.mkdir(child, { recursive: true });
  const stat = await fs.lstat(child);
  if (stat.isSymbolicLink()) throw new Error("Memory subdirectory must not be a symbolic link.");
  const realChild = await fs.realpath(child);
  assertPathContained(root, realChild, "Memory subdirectory escaped its root.");
  return child;
}
