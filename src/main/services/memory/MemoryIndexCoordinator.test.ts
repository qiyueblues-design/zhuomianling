import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRebuildRequest, MemoryRebuildResponse } from "../../../shared/types/memory";
import { FakeMemoryBackend } from "./FakeMemoryBackend";
import { MemoryBackendError } from "./MemoryBackend";
import { MemoryIndexCoordinator } from "./MemoryIndexCoordinator";
import { MemoryLedger } from "./MemoryLedger";

let temporaryDirectory = "";

class DirectoryFakeBackend extends FakeMemoryBackend {
  failRebuild = false;

  constructor(private readonly indexDirectoryForPet: (petId: string) => string) {
    super();
  }

  override async rebuild(
    request: MemoryRebuildRequest,
    signal: AbortSignal
  ): Promise<MemoryRebuildResponse> {
    const target = path.join(this.indexDirectoryForPet(request.petId), request.targetId);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "validated.marker"), request.records.map(({ id }) => id).join("\n"));
    if (this.failRebuild) {
      throw new MemoryBackendError("index-dirty", "Injected rebuild failure.");
    }
    return super.rebuild(request, signal);
  }
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-index-test-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("MemoryIndexCoordinator", () => {
  it("rolls back failed staging work and advances outbox only after a validated swap", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    const created = await ledger.create({
      petId: "pet-a",
      chapter: "about_you",
      memoryType: "profile",
      content: "stable authority record"
    });
    const current = path.join(indexDirectoryForPet("pet-a"), "current");
    await fs.mkdir(current, { recursive: true });
    await fs.writeFile(path.join(current, "old.marker"), "old");
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({
      backend,
      indexDirectoryForPet,
      modelFingerprint: "fixture-model-v1"
    });
    const signal = new AbortController().signal;
    try {
      backend.failRebuild = true;
      await expect(coordinator.rebuild(ledger, signal)).rejects.toMatchObject({ code: "index-dirty" });
      expect(await fs.readFile(path.join(current, "old.marker"), "utf8")).toBe("old");
      expect((await fs.readdir(indexDirectoryForPet("pet-a"))).some((name) => name.startsWith("staging-"))).toBe(false);
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: true, lastAppliedSequence: 0 });

      backend.failRebuild = false;
      await expect(coordinator.rebuild(ledger, signal)).resolves.toEqual({ rebuilt: true, appliedCount: 1 });
      expect(await fs.readFile(path.join(current, "validated.marker"), "utf8")).toBe(created.memory.id);
      await expect(fs.access(path.join(indexDirectoryForPet("pet-a"), "backup"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(ledger.getIndexMetadata()).toMatchObject({
        dirty: false,
        lastAppliedSequence: created.outboxSequence,
        modelFingerprint: "fixture-model-v1"
      });

      const updated = await ledger.update({
        petId: "pet-a",
        memoryId: created.memory.id,
        expectedRevision: created.memory.revision,
        content: "updated authority record"
      });
      await expect(coordinator.synchronize(ledger, signal)).resolves.toEqual({ rebuilt: false, appliedCount: 1 });
      expect(backend.snapshot("pet-a")).toEqual([updated.memory]);
      expect(ledger.getIndexMetadata().lastAppliedSequence).toBe(updated.outboxSequence);
    } finally {
      ledger.close();
    }
  });

  it("rebuilds automatically on model fingerprint changes and removes stale staging work", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    const created = await ledger.create({
      petId: "pet-a",
      chapter: "preferences_habits",
      memoryType: "behavior",
      content: "model migration authority"
    });
    const root = indexDirectoryForPet("pet-a");
    await fs.mkdir(path.join(root, "current"), { recursive: true });
    await fs.writeFile(path.join(root, "current", "old.marker"), "old-model");
    await fs.mkdir(path.join(root, "staging-interrupted"), { recursive: true });
    await fs.writeFile(path.join(root, "staging-interrupted", "partial.marker"), "partial");
    await ledger.setIndexState("pet-a", false, "fixture-model-v1");
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({
      backend,
      indexDirectoryForPet,
      modelFingerprint: "fixture-model-v2"
    });
    try {
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({
        rebuilt: true,
        appliedCount: 1
      });
      expect(await fs.readFile(path.join(root, "current", "validated.marker"), "utf8")).toBe(created.memory.id);
      expect((await fs.readdir(root)).some((name) => name.startsWith("staging-"))).toBe(false);
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: false, modelFingerprint: "fixture-model-v2" });
    } finally {
      ledger.close();
    }
  });

  it("recovers backup when an interrupted Windows swap left current missing", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    const root = indexDirectoryForPet("pet-a");
    await fs.mkdir(path.join(root, "backup"), { recursive: true });
    await fs.writeFile(path.join(root, "backup", "recovery.marker"), "recovered");
    await ledger.setIndexState("pet-a", false, "fixture-model-v1");
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({ backend, indexDirectoryForPet, modelFingerprint: "fixture-model-v1" });
    try {
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({
        rebuilt: false,
        appliedCount: 0
      });
      expect(await fs.readFile(path.join(root, "current", "recovery.marker"), "utf8")).toBe("recovered");
      await expect(fs.access(path.join(root, "backup"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      ledger.close();
    }
  });

  it("rolls current back when authority metadata cannot commit after the directory swap", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    await ledger.create({
      petId: "pet-a",
      chapter: "about_you",
      memoryType: "profile",
      content: "new authority"
    });
    const root = indexDirectoryForPet("pet-a");
    await fs.mkdir(path.join(root, "current"), { recursive: true });
    await fs.writeFile(path.join(root, "current", "old.marker"), "old-current");
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({ backend, indexDirectoryForPet, modelFingerprint: "fixture-model-v2" });
    const originalSetIndexState = ledger.setIndexState.bind(ledger);
    ledger.setIndexState = async (petId, dirty, fingerprint) => {
      if (!dirty) throw new Error("injected metadata commit failure");
      return originalSetIndexState(petId, dirty, fingerprint);
    };
    try {
      await expect(coordinator.rebuild(ledger, new AbortController().signal)).rejects.toThrow("injected metadata commit failure");
      expect(await fs.readFile(path.join(root, "current", "old.marker"), "utf8")).toBe("old-current");
      expect((await fs.readdir(root)).some((name) => name.startsWith("staging-"))).toBe(false);
      expect(ledger.getIndexMetadata().dirty).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("physically purges a synchronized clear without retaining a derived backup", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    await ledger.create({ petId: "pet-a", chapter: "about_you", memoryType: "profile", content: "clear-one" });
    await ledger.create({ petId: "pet-a", chapter: "important_events", memoryType: "event", content: "clear-two" });
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({ backend, indexDirectoryForPet, modelFingerprint: "fixture-model-v1" });
    const signal = new AbortController().signal;
    try {
      await coordinator.synchronize(ledger, signal);
      await ledger.clear("pet-a");
      await expect(coordinator.synchronize(ledger, signal)).resolves.toEqual({ rebuilt: true, appliedCount: 0 });
      expect(ledger.snapshot(true)).toEqual([]);
      expect(ledger.listOutbox()).toEqual([]);
      expect(backend.snapshot("pet-a")).toEqual([]);
      await expect(fs.access(path.join(indexDirectoryForPet("pet-a"), "backup"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      ledger.close();
    }
  });
});
