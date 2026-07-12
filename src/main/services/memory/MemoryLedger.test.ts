import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRecordInput } from "../../../shared/types/memory";
import { MemoryLedger, MemoryLedgerError } from "./MemoryLedger";
import { MemoryPendingStore } from "./MemoryPendingStore";
import { createMemoryExportFileName, exportMemorySnapshot } from "./memoryExport";

let temporaryDirectory = "";

function createClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 13, 0, 0, tick++)).toISOString();
}

function ledgerOptions(directory = temporaryDirectory) {
  let id = 0;
  return {
    memoryDirectoryPath: directory,
    now: createClock(),
    idFactory: () => `memory-${++id}`
  };
}

async function createMemory(ledger: MemoryLedger, content: string, chapter = "about_you" as const) {
  return ledger.create({
    petId: ledger.petId,
    chapter,
    memoryType: "profile",
    content,
    tags: ["fixture"]
  });
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-ledger-test-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("MemoryLedger schema and queries", () => {
  it("creates the explicit schema with WAL and searchable FTS5 content", async () => {
    const ledger = await MemoryLedger.open("pet-a", ledgerOptions());
    await createMemory(ledger, "I prefer jasmine tea");
    const search = ledger.search({ petId: "pet-a", query: "jasmine", pageSize: 10 });
    const databasePath = ledger.paths.ledger;
    ledger.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const version = database
      .prepare("SELECT value FROM memory_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    database.close();

    expect(version.value).toBe("1");
    expect(journal.journal_mode).toBe("wal");
    expect(search.items.map(({ content }) => content)).toEqual(["I prefer jasmine tea"]);
  });

  it("uses stable cursor pagination and bounded filters", async () => {
    const ledger = await MemoryLedger.open("pet-a", ledgerOptions());
    await createMemory(ledger, "first");
    await createMemory(ledger, "second", "important_events");
    await createMemory(ledger, "third");

    const firstPage = ledger.list({ petId: "pet-a", pageSize: 2, sort: "oldest" });
    const secondPage = ledger.list({
      petId: "pet-a",
      pageSize: 2,
      sort: "oldest",
      cursor: firstPage.nextCursor
    });
    const chapter = ledger.list({
      petId: "pet-a",
      chapters: ["important_events"],
      pageSize: 10
    });

    expect(firstPage.items.map(({ content }) => content)).toEqual(["first", "second"]);
    expect(secondPage.items.map(({ content }) => content)).toEqual(["third"]);
    expect(chapter.items.map(({ content }) => content)).toEqual(["second"]);
    expect(() =>
      ledger.search({ petId: "pet-a", query: `" OR * ()`, pageSize: 10 })
    ).not.toThrow();
    ledger.close();
  });

  it("keeps identical record IDs isolated in separate pet ledgers", async () => {
    const petADirectory = path.join(temporaryDirectory, "pet-a-memory");
    const petBDirectory = path.join(temporaryDirectory, "pet-b-memory");
    const petA = await MemoryLedger.open("pet-a", ledgerOptions(petADirectory));
    const petB = await MemoryLedger.open("pet-b", ledgerOptions(petBDirectory));
    await createMemory(petA, "only a");
    await createMemory(petB, "only b");

    expect(petA.snapshot().map(({ content }) => content)).toEqual(["only a"]);
    expect(petB.snapshot().map(({ content }) => content)).toEqual(["only b"]);
    petA.close();
    petB.close();
  });
});

describe("MemoryLedger mutations and recovery", () => {
  it("enforces optimistic concurrency and rolls a failed transaction back", async () => {
    const ledger = await MemoryLedger.open("pet-a", ledgerOptions());
    const created = await createMemory(ledger, "original");
    const request = {
      petId: "pet-a",
      memoryId: created.memory.id,
      expectedRevision: 1,
      content: "updated"
    };
    const results = await Promise.allSettled([ledger.update(request), ledger.update(request)]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: { code: "MEMORY_REVISION_CONFLICT" }
    });
    expect(ledger.get(created.memory.id)?.revision).toBe(2);
    expect(ledger.listOutbox()).toHaveLength(2);
    ledger.close();
  });

  it("supports forget, undo, and clear with transactional outbox entries", async () => {
    const ledger = await MemoryLedger.open("pet-a", ledgerOptions());
    const first = await createMemory(ledger, "first");
    await createMemory(ledger, "second");
    const forgotten = await ledger.forget("pet-a", first.memory.id, 1);
    expect(ledger.get(first.memory.id)).toBeUndefined();
    const restored = await ledger.undoForget("pet-a", first.memory.id, forgotten.revision);
    expect(restored.memory.deletedAt).toBeUndefined();
    const cleared = await ledger.clear("pet-a");

    expect(cleared.clearedCount).toBe(2);
    expect(ledger.getSummary().total).toBe(0);
    expect(ledger.listOutbox().map(({ operation }) => operation)).toEqual([
      "upsert",
      "upsert",
      "forget",
      "upsert",
      "clear"
    ]);
    ledger.close();
  });

  it("commits an automatic turn once and retains source only with consent", async () => {
    const ledger = await MemoryLedger.open("pet-a", ledgerOptions());
    const turn = {
      petId: "pet-a",
      requestId: "request-1",
      userText: "I like quiet mornings",
      assistantReply: "I will remember that",
      occurredAt: "2026-07-13T00:00:00.000Z",
      retainSource: true
    };
    const entries: MemoryRecordInput[] = [
      {
        id: "automatic-1",
        petId: "pet-a",
        chapter: "preferences_habits",
        memoryType: "behavior",
        content: "Prefers quiet mornings",
        origin: "automatic"
      }
    ];
    const hash = "a".repeat(64);
    expect(ledger.isAutomaticTurnCommitted(turn.requestId, hash)).toBe(false);
    const first = await ledger.commitAutomaticTurn(turn, hash, entries);
    const duplicate = await ledger.commitAutomaticTurn(turn, hash, entries);

    expect(first.duplicate).toBe(false);
    expect(ledger.isAutomaticTurnCommitted(turn.requestId, hash)).toBe(true);
    expect(duplicate).toMatchObject({ duplicate: true, outboxSequences: [] });
    expect(ledger.snapshot()).toHaveLength(1);
    expect(ledger.getSourceTurns()).toHaveLength(1);
    await expect(ledger.commitAutomaticTurn(turn, "b".repeat(64), entries)).rejects.toMatchObject({
      code: "MEMORY_REVISION_CONFLICT"
    });
    expect(() => ledger.isAutomaticTurnCommitted(turn.requestId, "b".repeat(64))).toThrow(
      expect.objectContaining({ code: "MEMORY_REVISION_CONFLICT" })
    );
    ledger.close();
  });

  it("keeps the last valid backup and requires explicit recovery from corruption", async () => {
    const options = ledgerOptions();
    const ledger = await MemoryLedger.open("pet-a", options);
    await createMemory(ledger, "survives in backup");
    await createMemory(ledger, "newer than backup");
    const ledgerPath = ledger.paths.ledger;
    ledger.close();
    await fs.writeFile(ledgerPath, "not a sqlite database", "utf8");

    await expect(MemoryLedger.open("pet-a", options)).rejects.toMatchObject({
      code: "LEDGER_CORRUPTED"
    });
    expect(await fs.readFile(ledgerPath, "utf8")).toBe("not a sqlite database");

    await MemoryLedger.restoreBackup("pet-a", temporaryDirectory);
    const restored = await MemoryLedger.open("pet-a", options);
    expect(restored.snapshot().map(({ content }) => content)).toEqual(["survives in backup"]);
    restored.close();
  });

  it("rejects a ledger from a newer schema without overwriting it", async () => {
    const ledgerPath = path.join(temporaryDirectory, "ledger.sqlite3");
    const database = new DatabaseSync(ledgerPath);
    database.exec("CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    database.prepare("INSERT INTO memory_meta(key, value) VALUES ('schema_version', '999')").run();
    database.close();

    await expect(MemoryLedger.open("pet-a", ledgerOptions())).rejects.toMatchObject({
      code: "LEDGER_VERSION_UNSUPPORTED"
    });
    const unchanged = new DatabaseSync(ledgerPath, { readOnly: true });
    expect(
      (unchanged.prepare("SELECT value FROM memory_meta WHERE key = 'schema_version'").get() as { value: string }).value
    ).toBe("999");
    unchanged.close();
  });

  it("migrates an explicit version-zero ledger after preserving its original backup", async () => {
    const ledgerPath = path.join(temporaryDirectory, "ledger.sqlite3");
    const database = new DatabaseSync(ledgerPath);
    database.exec("CREATE TABLE memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    database.prepare("INSERT INTO memory_meta(key, value) VALUES ('schema_version', '0')").run();
    database.close();

    const ledger = await MemoryLedger.open("pet-a", ledgerOptions());
    expect(ledger.getSummary().total).toBe(0);
    ledger.close();
    await expect(fs.access(path.join(temporaryDirectory, "ledger.sqlite3.bak"))).resolves.toBeUndefined();

    const migrated = new DatabaseSync(ledgerPath, { readOnly: true });
    const metadata = migrated.prepare("SELECT key, value FROM memory_meta").all() as Array<{
      key: string;
      value: string;
    }>;
    expect(Object.fromEntries(metadata.map(({ key, value }) => [key, value]))).toMatchObject({
      schema_version: "1",
      pet_id: "pet-a"
    });
    migrated.close();
  });

  it("rejects a valid ledger copied into another pet boundary", async () => {
    const petADirectory = path.join(temporaryDirectory, "pet-a-memory");
    const petBDirectory = path.join(temporaryDirectory, "pet-b-memory");
    const petA = await MemoryLedger.open("pet-a", ledgerOptions(petADirectory));
    await createMemory(petA, "belongs to a");
    petA.close();
    await fs.mkdir(petBDirectory, { recursive: true });
    await fs.copyFile(
      path.join(petADirectory, "ledger.sqlite3"),
      path.join(petBDirectory, "ledger.sqlite3")
    );

    await expect(MemoryLedger.open("pet-b", ledgerOptions(petBDirectory))).rejects.toMatchObject({
      code: "LEDGER_CORRUPTED"
    });
  });

  it("tracks outbox progress and index dirty metadata", async () => {
    const ledger = await MemoryLedger.open("pet-a", ledgerOptions());
    const created = await createMemory(ledger, "index me");
    await ledger.setIndexState("pet-a", true, "embedding-fixture-v1");
    await ledger.markOutboxProcessed("pet-a", created.outboxSequence);

    expect(ledger.getIndexMetadata()).toEqual({
      dirty: true,
      lastAppliedSequence: created.outboxSequence,
      modelFingerprint: "embedding-fixture-v1"
    });
    expect(ledger.listOutbox()[0]?.processedAt).toBeDefined();
    ledger.close();
  });
});

describe("pending durability and exports", () => {
  it("uses the current pet name for a filesystem-safe export filename", () => {
    expect(createMemoryExportFileName("若叶睦", "former-name", "md")).toBe("若叶睦-memory.md");
    expect(createMemoryExportFileName("若叶/睦:*", "pet-a", "json")).toBe("若叶 睦-memory.json");
    expect(createMemoryExportFileName("CON", "pet-a", "md")).toBe("pet-a-memory.md");
  });

  it("durably backs up pending turns and restores only on an explicit request", async () => {
    const store = new MemoryPendingStore("pet-a", { memoryDirectoryPath: temporaryDirectory });
    const base = {
      schemaVersion: 1 as const,
      petId: "pet-a",
      requestId: "request-1",
      contentHash: "a".repeat(64),
      userText: "user text",
      assistantReply: "assistant text",
      occurredAt: "2026-07-13T00:00:00.000Z",
      retainSource: false,
      createdAt: "2026-07-13T00:00:01.000Z"
    };
    await store.write({ ...base, attempt: 0 });
    await store.write({
      ...base,
      attempt: 1,
      nextAttemptAt: "2026-07-13T00:01:00.000Z",
      lastErrorCode: "unavailable"
    });
    await expect(store.read("request-1")).resolves.toMatchObject({
      attempt: 1,
      nextAttemptAt: "2026-07-13T00:01:00.000Z",
      lastErrorCode: "unavailable"
    });
    const [fileName] = (await fs.readdir(path.join(temporaryDirectory, "pending"))).filter((name) => name.endsWith(".json"));
    await fs.writeFile(path.join(temporaryDirectory, "pending", fileName), "broken", "utf8");

    await expect(store.read("request-1")).rejects.toMatchObject({ code: "LEDGER_CORRUPTED" });
    await store.restoreBackup("request-1");
    await expect(store.read("request-1")).resolves.toMatchObject({ attempt: 0 });
    await store.remove("request-1");
    await expect(store.list()).resolves.toEqual([]);
  });

  it("exports readable Markdown and bounded JSON without internal fields or sources by default", async () => {
    const ledger = await MemoryLedger.open("pet-a", ledgerOptions());
    await ledger.commitAutomaticTurn(
      {
        petId: "pet-a",
        requestId: "request-1",
        userText: "private source",
        assistantReply: "private response",
        occurredAt: "2026-07-13T00:00:00.000Z",
        retainSource: true
      },
      "a".repeat(64),
      [
        {
          id: "automatic-1",
          petId: "pet-a",
          chapter: "about_you",
          memoryType: "profile",
          content: "Visible memory",
          origin: "automatic"
        }
      ]
    );
    const records = ledger.snapshot();
    const sources = ledger.getSourceTurns();
    const markdown = exportMemorySnapshot("pet-a", records, sources, { format: "markdown" });
    const json = exportMemorySnapshot("pet-a", records, sources, { format: "json" });
    const withSources = exportMemorySnapshot("pet-a", records, sources, {
      format: "json",
      includeSources: true
    });

    expect(markdown.content).toContain("Visible memory");
    expect(markdown.content).not.toContain("private source");
    expect(json.content).not.toContain("private source");
    expect(json.content).not.toMatch(/embedding|outbox|sqlite|[A-Z]:\\/i);
    expect(withSources.content).toContain("private source");
    ledger.close();
  });
});
