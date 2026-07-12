import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryPendingTurn } from "../../../shared/types/memory";
import { MEMORY_LIMITS } from "../../../shared/types/memory";
import {
  assertBoundedMemoryString,
  assertMemoryObjectBudget,
  MemoryValidationError
} from "../../../shared/validation/memory";
import { assertValidPetId } from "../../../shared/validation/petId";
import { writeJsonFileAtomically } from "../config/durableJsonFile";
import { withPetConfigWriteLock } from "../config/petConfigWriteQueue";
import {
  ensureSafeMemoryChildDirectory,
  ensureMemoryPathsAtDirectory,
  ensureSafeMemoryPaths
} from "./memoryPaths";
import { MemoryLedgerError } from "./MemoryLedger";

export interface MemoryPendingStoreOptions {
  memoryDirectoryPath?: string;
}

function isPendingTurn(value: unknown, petId: string): value is MemoryPendingTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Partial<MemoryPendingTurn>;
  return (
    pending.schemaVersion === 1 &&
    pending.petId === petId &&
    typeof pending.requestId === "string" &&
    pending.requestId.length > 0 &&
    pending.requestId.length <= MEMORY_LIMITS.idChars &&
    typeof pending.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(pending.contentHash) &&
    typeof pending.userText === "string" &&
    pending.userText.length > 0 &&
    pending.userText.length <= MEMORY_LIMITS.contentChars &&
    typeof pending.assistantReply === "string" &&
    pending.assistantReply.length > 0 &&
    pending.assistantReply.length <= MEMORY_LIMITS.contentChars &&
    typeof pending.occurredAt === "string" &&
    Number.isFinite(Date.parse(pending.occurredAt)) &&
    typeof pending.retainSource === "boolean" &&
    Number.isInteger(pending.attempt) &&
    (pending.attempt ?? -1) >= 0 &&
    (pending.attempt ?? Number.MAX_SAFE_INTEGER) <= 20 &&
    typeof pending.createdAt === "string" &&
    Number.isFinite(Date.parse(pending.createdAt)) &&
    (pending.nextAttemptAt === undefined ||
      (typeof pending.nextAttemptAt === "string" && Number.isFinite(Date.parse(pending.nextAttemptAt)))) &&
    (pending.deadLetteredAt === undefined ||
      (typeof pending.deadLetteredAt === "string" && Number.isFinite(Date.parse(pending.deadLetteredAt)))) &&
    (pending.lastErrorCode === undefined ||
      (typeof pending.lastErrorCode === "string" && /^[a-z0-9-]{1,64}$/.test(pending.lastErrorCode)))
  );
}

function fileStem(requestId: string): string {
  return crypto.createHash("sha256").update(requestId, "utf8").digest("hex");
}

async function rejectSymlink(filePath: string): Promise<void> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) {
      throw new MemoryLedgerError("MEMORY_STORAGE_UNAVAILABLE", "Pending memory file is a symbolic link.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readJsonBounded(filePath: string): Promise<unknown> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new MemoryLedgerError("MEMORY_STORAGE_UNAVAILABLE", "Pending memory path is unsafe.");
  }
  if (stat.size > MEMORY_LIMITS.objectBudgetBytes) {
    throw new MemoryLedgerError("LEDGER_CORRUPTED", "Pending memory file exceeds its budget.");
  }
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "")) as unknown;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class MemoryPendingStore {
  private readonly petId: string;
  private readonly memoryDirectoryPath?: string;

  constructor(petId: string, options: MemoryPendingStoreOptions = {}) {
    this.petId = assertValidPetId(petId);
    this.memoryDirectoryPath = options.memoryDirectoryPath;
  }

  private async directory(): Promise<string> {
    const paths = this.memoryDirectoryPath
      ? await ensureMemoryPathsAtDirectory(this.memoryDirectoryPath)
      : await ensureSafeMemoryPaths(this.petId);
    await fs.mkdir(paths.directory, { recursive: true });
    return ensureSafeMemoryChildDirectory(paths.directory, "pending");
  }

  private validate(value: MemoryPendingTurn): void {
    if (!isPendingTurn(value, this.petId)) throw new MemoryValidationError("Invalid pending memory turn.");
    assertBoundedMemoryString(value.requestId, "requestId", MEMORY_LIMITS.idChars);
    assertMemoryObjectBudget(value);
  }

  async write(value: MemoryPendingTurn): Promise<void> {
    this.validate(value);
    await withPetConfigWriteLock(this.petId, async () => {
      const directory = await this.directory();
      const stem = fileStem(value.requestId);
      const filePath = path.join(directory, `${stem}.json`);
      const backupPath = `${filePath}.bak`;
      await Promise.all([rejectSymlink(filePath), rejectSymlink(backupPath)]);
      await writeJsonFileAtomically(filePath, value, {
        backup: {
          filePath: backupPath,
          validateCurrent: (current) => isPendingTurn(current, this.petId)
        }
      });
    });
  }

  async read(requestId: string): Promise<MemoryPendingTurn | undefined> {
    assertBoundedMemoryString(requestId, "requestId", MEMORY_LIMITS.idChars);
    const directory = await this.directory();
    const filePath = path.join(directory, `${fileStem(requestId)}.json`);
    await rejectSymlink(filePath);
    try {
      const parsed = await readJsonBounded(filePath);
      if (!isPendingTurn(parsed, this.petId) || parsed.requestId !== requestId) {
        throw new MemoryLedgerError("LEDGER_CORRUPTED", "Pending memory turn is corrupted.");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof MemoryLedgerError) throw error;
      throw new MemoryLedgerError("LEDGER_CORRUPTED", "Pending memory turn is corrupted.", error);
    }
  }

  async list(): Promise<MemoryPendingTurn[]> {
    const directory = await this.directory();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const pending: MemoryPendingTurn[] = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new MemoryLedgerError("MEMORY_STORAGE_UNAVAILABLE", "Pending memory storage contains an unsafe entry.");
      }
      const filePath = path.join(directory, entry.name);
      try {
        const value = await readJsonBounded(filePath);
        if (!isPendingTurn(value, this.petId) || fileStem(value.requestId) !== path.basename(entry.name, ".json")) {
          throw new Error();
        }
        pending.push(value);
      } catch (error) {
        throw new MemoryLedgerError("LEDGER_CORRUPTED", "Pending memory queue is corrupted.", error);
      }
    }
    return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId));
  }

  async remove(requestId: string): Promise<void> {
    assertBoundedMemoryString(requestId, "requestId", MEMORY_LIMITS.idChars);
    await withPetConfigWriteLock(this.petId, async () => {
      const directory = await this.directory();
      const filePath = path.join(directory, `${fileStem(requestId)}.json`);
      await Promise.all([rejectSymlink(filePath), rejectSymlink(`${filePath}.bak`)]);
      await Promise.all([
        fs.rm(filePath, { force: true }),
        fs.rm(`${filePath}.bak`, { force: true })
      ]);
      await syncDirectory(directory);
    });
  }

  async restoreBackup(requestId: string): Promise<void> {
    assertBoundedMemoryString(requestId, "requestId", MEMORY_LIMITS.idChars);
    await withPetConfigWriteLock(this.petId, async () => {
      const directory = await this.directory();
      const filePath = path.join(directory, `${fileStem(requestId)}.json`);
      const backupPath = `${filePath}.bak`;
      await Promise.all([rejectSymlink(filePath), rejectSymlink(backupPath)]);
      let parsed: unknown;
      try {
        parsed = await readJsonBounded(backupPath);
      } catch (error) {
        throw new MemoryLedgerError("LEDGER_CORRUPTED", "Pending memory backup is unavailable.", error);
      }
      if (!isPendingTurn(parsed, this.petId) || parsed.requestId !== requestId) {
        throw new MemoryLedgerError("LEDGER_CORRUPTED", "Pending memory backup is invalid.");
      }
      await writeJsonFileAtomically(filePath, parsed);
    });
  }
}
