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
      expect(await fs.readFile(path.join(indexDirectoryForPet("pet-a"), "backup", "old.marker"), "utf8")).toBe("old");
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
});
