import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataPath: ""
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  net: {
    fetch: vi.fn()
  },
  protocol: {
    handle: vi.fn()
  }
}));

let temporaryDirectory = "";

function getPetDirectory(petId = "pet-a"): string {
  return path.join(temporaryDirectory, "pets", petId);
}

function getLive2DDirectory(petId = "pet-a"): string {
  return path.join(getPetDirectory(petId), "live2d");
}

async function writePetConfig(petId = "pet-a"): Promise<void> {
  await fs.mkdir(getPetDirectory(petId), { recursive: true });
  await fs.writeFile(
    path.join(getPetDirectory(petId), "pet.local.json"),
    JSON.stringify(
      {
        id: petId,
        name: "Fixture Pet",
        description: "fixture",
        modelPath: `pet-resource://local/${petId}/live2d/model.model3.json`,
        personaPrompt: "keep this unless replacement succeeds",
        personaSettings: {
          speakingStyle: "keep persona settings"
        },
        defaultVoice: "keep-default-voice",
        voiceModelSettings: {
          enabled: false,
          connected: false
        },
        capabilities: {
          chat: true,
          voiceOutput: false,
          subtitles: true
        },
        details: {
          role: "fixture",
          personality: "fixture",
          scenes: [],
          features: []
        },
        expressions: {
          happy: "happy"
        },
        expressionDescriptions: {
          happy: "happy"
        },
        lines: {
          click: ["old line"]
        },
        live2dSettings: {
          format: "cubism4-5",
          entryFileName: "model.model3.json",
          textureCount: 0,
          motionCount: 0,
          expressionCount: 0
        }
      },
      null,
      2
    ),
    "utf8"
  );
}

async function writeModel(
  directoryPath: string,
  identity: string,
  options: { mocReference?: string; writeMoc?: boolean } = {}
): Promise<void> {
  const mocReference = options.mocReference ?? "model.moc3";
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(
    path.join(directoryPath, "model.model3.json"),
    JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: mocReference,
        Textures: []
      }
    }),
    "utf8"
  );
  await fs.writeFile(path.join(directoryPath, "identity.txt"), identity, "utf8");

  if (options.writeMoc !== false) {
    const mocPath = path.resolve(directoryPath, mocReference);
    await fs.mkdir(path.dirname(mocPath), { recursive: true });
    await fs.writeFile(mocPath, `moc-${identity}`, "utf8");
  }
}

async function readInstalledIdentity(petId = "pet-a"): Promise<string> {
  return fs.readFile(path.join(getLive2DDirectory(petId), "identity.txt"), "utf8");
}

async function listPetDirectoryNames(petId = "pet-a"): Promise<string[]> {
  return fs.readdir(getPetDirectory(petId));
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-live2d-import-"));
  electronMock.userDataPath = temporaryDirectory;
  vi.resetModules();
  await writePetConfig();
  await writeModel(getLive2DDirectory(), "old");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("atomic Live2D model replacement", () => {
  it("keeps the old model when copying into staging fails", async () => {
    const sourceDirectory = path.join(temporaryDirectory, "source-copy-failure");
    await writeModel(sourceDirectory, "new");
    const copySpy = vi.spyOn(fs, "cp").mockRejectedValueOnce(new Error("fixture copy failure"));
    const { importLive2DModel } = await import("./live2dImportService");

    const result = await importLive2DModel({
      petId: "pet-a",
      sourceFolderPath: sourceDirectory
    });

    expect(copySpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(await readInstalledIdentity()).toBe("old");
    expect(await listPetDirectoryNames()).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.live2d-(?:staging|backup)-/)])
    );
  });

  it("keeps the old model when the staged copy fails dependency validation", async () => {
    const sourceDirectory = path.join(temporaryDirectory, "source-invalid");
    await writeModel(sourceDirectory, "invalid", {
      mocReference: "../escaped/model.moc3"
    });
    const { importLive2DModel } = await import("./live2dImportService");

    const result = await importLive2DModel({
      petId: "pet-a",
      sourceFolderPath: sourceDirectory
    });

    expect(result.ok).toBe(false);
    expect(result.scan?.ok).toBe(false);
    expect(result.scan?.missingFiles).toContain("../escaped/model.moc3");
    expect(await readInstalledIdentity()).toBe("old");
  });

  it("restores the old directory when installing staging fails after backup rename", async () => {
    const sourceDirectory = path.join(temporaryDirectory, "source-switch-failure");
    await writeModel(sourceDirectory, "new");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(
      async (oldPath, newPath) => {
        if (
          path.basename(oldPath.toString()).startsWith(".live2d-staging-") &&
          path.basename(newPath.toString()) === "live2d"
        ) {
          throw new Error("fixture install rename failure");
        }

        return originalRename(oldPath, newPath);
      }
    );
    const { importLive2DModel } = await import("./live2dImportService");

    const result = await importLive2DModel({
      petId: "pet-a",
      sourceFolderPath: sourceDirectory
    });

    expect(result.ok).toBe(false);
    expect(await readInstalledIdentity()).toBe("old");
    expect(renameSpy).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]live2d$/),
      expect.stringMatching(/[\\/]\.live2d-backup-/)
    );
    expect(await listPetDirectoryNames()).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.live2d-(?:staging|backup)-/)])
    );
  });

  it("replaces the model and removes its recognized backup after success", async () => {
    const sourceDirectory = path.join(temporaryDirectory, "source-success");
    const unrelatedDirectory = path.join(getPetDirectory(), ".live2d-backup-manual");
    await writeModel(sourceDirectory, "new");
    await fs.mkdir(unrelatedDirectory);
    await fs.writeFile(path.join(unrelatedDirectory, "keep.txt"), "keep", "utf8");
    const { importLive2DModel } = await import("./live2dImportService");

    const result = await importLive2DModel({
      petId: "pet-a",
      sourceFolderPath: sourceDirectory
    });
    const storedPet = JSON.parse(
      await fs.readFile(path.join(getPetDirectory(), "pet.local.json"), "utf8")
    ) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(await readInstalledIdentity()).toBe("new");
    expect(storedPet.personaPrompt).toBe("keep this unless replacement succeeds");
    expect(storedPet.personaSettings).toEqual({ speakingStyle: "keep persona settings" });
    expect(storedPet.defaultVoice).toBe("keep-default-voice");
    expect(storedPet.voiceModelSettings).toMatchObject({ enabled: false, connected: false });
    expect(storedPet).not.toHaveProperty("expressions");
    expect(storedPet.lines).toEqual({ click: ["old line"] });
    expect(await fs.readFile(path.join(unrelatedDirectory, "keep.txt"), "utf8")).toBe("keep");
    expect(await listPetDirectoryNames()).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.live2d-(?:staging|backup)-[0-9a-f-]{36}$/)])
    );
  });

  it("rolls back the directory and configuration when the atomic config commit fails", async () => {
    const sourceDirectory = path.join(temporaryDirectory, "source-config-failure");
    await writeModel(sourceDirectory, "new");
    const originalRename = fs.rename.bind(fs);
    let configCommitFailed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (
        !configCommitFailed &&
        path.basename(oldPath.toString()).startsWith(".pet.local.json.") &&
        path.basename(newPath.toString()) === "pet.local.json"
      ) {
        configCommitFailed = true;
        throw new Error("fixture atomic config rename failure");
      }

      return originalRename(oldPath, newPath);
    });
    const { importLive2DModel } = await import("./live2dImportService");

    const result = await importLive2DModel({
      petId: "pet-a",
      sourceFolderPath: sourceDirectory
    });
    const storedPet = JSON.parse(
      await fs.readFile(path.join(getPetDirectory(), "pet.local.json"), "utf8")
    ) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(configCommitFailed).toBe(true);
    expect(await readInstalledIdentity()).toBe("old");
    expect(storedPet.personaPrompt).toBe("keep this unless replacement succeeds");
    expect(storedPet).toHaveProperty("expressions");
  });

  it("serializes concurrent imports for the same pet", async () => {
    const firstSource = path.join(temporaryDirectory, "source-concurrent-a");
    const secondSource = path.join(temporaryDirectory, "source-concurrent-b");
    await writeModel(firstSource, "first");
    await writeModel(secondSource, "second");
    const originalCopy = fs.cp.bind(fs);
    let activeCopies = 0;
    let maximumActiveCopies = 0;
    const copySpy = vi.spyOn(fs, "cp").mockImplementation(
      async (source, destination, options) => {
        activeCopies += 1;
        maximumActiveCopies = Math.max(maximumActiveCopies, activeCopies);
        await new Promise((resolve) => setTimeout(resolve, 20));

        try {
          return await originalCopy(source, destination, options);
        } finally {
          activeCopies -= 1;
        }
      }
    );
    const { importLive2DModel } = await import("./live2dImportService");

    const [firstResult, secondResult] = await Promise.all([
      importLive2DModel({
        petId: "pet-a",
        sourceFolderPath: firstSource
      }),
      importLive2DModel({
        petId: "pet-a",
        sourceFolderPath: secondSource
      })
    ]);

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(copySpy).toHaveBeenCalledTimes(2);
    expect(maximumActiveCopies).toBe(1);
    expect(await readInstalledIdentity()).toBe("second");
  });

  it("recovers a recognized interrupted backup and removes only recognized staging residue", async () => {
    const backupDirectory = path.join(
      getPetDirectory(),
      ".live2d-backup-11111111-1111-4111-8111-111111111111"
    );
    const staleStagingDirectory = path.join(
      getPetDirectory(),
      ".live2d-staging-22222222-2222-4222-8222-222222222222"
    );
    const sourceDirectory = path.join(temporaryDirectory, "source-after-recovery");
    await fs.rename(getLive2DDirectory(), backupDirectory);
    await writeModel(staleStagingDirectory, "partial");
    await writeModel(sourceDirectory, "new");
    vi.spyOn(fs, "cp").mockRejectedValueOnce(new Error("stop after recovery"));
    const { importLive2DModel } = await import("./live2dImportService");

    const result = await importLive2DModel({
      petId: "pet-a",
      sourceFolderPath: sourceDirectory
    });

    expect(result.ok).toBe(false);
    expect(await readInstalledIdentity()).toBe("old");
    await expect(fs.access(backupDirectory)).rejects.toThrow();
    await expect(fs.access(staleStagingDirectory)).rejects.toThrow();
  });

  it("rejects an invalid pet ID before resolving any pet path", async () => {
    const sourceDirectory = path.join(temporaryDirectory, "source-invalid-pet-id");
    await writeModel(sourceDirectory, "new");
    const { importLive2DModel } = await import("./live2dImportService");

    const result = await importLive2DModel({
      petId: "../pet-a",
      sourceFolderPath: sourceDirectory
    });

    expect(result.ok).toBe(false);
    expect(await readInstalledIdentity()).toBe("old");
  });
});
