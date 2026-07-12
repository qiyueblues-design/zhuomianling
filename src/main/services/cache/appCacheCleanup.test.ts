import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath
  }
}));

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-cache-cleanup-"));
  electronMock.userDataPath = temporaryDirectory;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("application cache cleanup", () => {
  it("removes only the approved Chromium cache directories", async () => {
    const safeDirectories = [
      "Cache",
      "Code Cache",
      "GPUCache",
      "DawnGraphiteCache",
      "DawnWebGPUCache"
    ];

    await Promise.all(
      safeDirectories.map(async (directoryName) => {
        const filePath = path.join(temporaryDirectory, directoryName, "cached.bin");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, "cache", "utf8");
      })
    );
    await fs.mkdir(path.join(temporaryDirectory, "pets", "pet-a"), { recursive: true });
    await fs.writeFile(path.join(temporaryDirectory, "pets", "pet-a", "pet.local.json"), "{}", "utf8");
    await fs.mkdir(path.join(temporaryDirectory, "Local Storage"), { recursive: true });
    await fs.writeFile(path.join(temporaryDirectory, "ai-connections.json"), "{}", "utf8");

    const { clearSafeAppCaches } = await import("./appCacheCleanup");
    await clearSafeAppCaches();

    await Promise.all(
      safeDirectories.map((directoryName) =>
        expect(fs.access(path.join(temporaryDirectory, directoryName))).rejects.toThrow()
      )
    );
    await expect(fs.access(path.join(temporaryDirectory, "pets", "pet-a", "pet.local.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(temporaryDirectory, "Local Storage"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(temporaryDirectory, "ai-connections.json"))).resolves.toBeUndefined();
  });
});
