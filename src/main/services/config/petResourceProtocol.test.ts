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
  net: {
    fetch: vi.fn()
  },
  protocol: {
    handle: vi.fn()
  }
}));

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-pet-resource-"));
  electronMock.userDataPath = temporaryDirectory;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("pet-resource local path boundary", () => {
  it("allows only assets and live2d descendants", async () => {
    const { resolvePetResourcePathForProtocol } = await import("./petResourceProtocol");

    const avatar = resolvePetResourcePathForProtocol(
      "pet-resource://local/pet-a/assets/avatar.png"
    );
    const model = resolvePetResourcePathForProtocol(
      "pet-resource://local/pet-a/live2d/model.model3.json"
    );

    expect(avatar.filePath).toBe(
      path.join(temporaryDirectory, "pets", "pet-a", "assets", "avatar.png")
    );
    expect(model.filePath).toBe(
      path.join(temporaryDirectory, "pets", "pet-a", "live2d", "model.model3.json")
    );
  });

  it("rejects pet config, voice files, and traversal segments", async () => {
    const { resolvePetResourcePathForProtocol } = await import("./petResourceProtocol");

    expect(() =>
      resolvePetResourcePathForProtocol("pet-resource://local/pet-a/pet.local.json")
    ).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol("pet-resource://local/pet-a/voice/config.yaml")
    ).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(
        "pet-resource://local/pet-a/live2d/%2e%2e/pet.local.json"
      )
    ).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(
        "pet-resource://local/pet-a/live2d/..%2fpet.local.json"
      )
    ).toThrow();
  });

  it("rejects a resource-root link that escapes the pet directory", async () => {
    const { resolvePetResourcePathForProtocol, resolveRealResourcePathForProtocol } = await import(
      "./petResourceProtocol"
    );
    const petDirectory = path.join(temporaryDirectory, "pets", "pet-a");
    const outsideDirectory = path.join(temporaryDirectory, "outside-live2d");
    await fs.mkdir(petDirectory, { recursive: true });
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(path.join(outsideDirectory, "model.model3.json"), "{}", "utf8");
    await fs.symlink(
      outsideDirectory,
      path.join(petDirectory, "live2d"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const resource = resolvePetResourcePathForProtocol(
      "pet-resource://local/pet-a/live2d/model.model3.json"
    );

    await expect(resolveRealResourcePathForProtocol(resource)).rejects.toThrow(
      "symbolic link escaped"
    );
  });
});

describe("pet-resource preview boundary", () => {
  it("allows Live2D file types and rejects local config or unrelated files", async () => {
    const { registerPetResourcePreviewRoot, resolvePetResourcePathForProtocol } = await import(
      "./petResourceProtocol"
    );
    const token = registerPetResourcePreviewRoot(temporaryDirectory);

    expect(() =>
      resolvePetResourcePathForProtocol(
        `pet-resource://preview/${token}/model/model.model3.json`
      )
    ).not.toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(
        `pet-resource://preview/${token}/model/speech.local.json`
      )
    ).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(`pet-resource://preview/${token}/model/notes.txt`)
    ).toThrow();
  });
});
