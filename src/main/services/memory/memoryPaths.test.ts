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
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-memory-path-"));
  electronMock.userDataPath = temporaryDirectory;
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("memory path containment", () => {
  it("creates memory only inside an existing canonical pet directory", async () => {
    const petDirectory = path.join(temporaryDirectory, "pets", "pet-a");
    await fs.mkdir(petDirectory, { recursive: true });
    const { ensureSafeMemoryPaths } = await import("./memoryPaths");

    const paths = await ensureSafeMemoryPaths("pet-a");

    expect(await fs.realpath(paths.directory)).toBe(
      await fs.realpath(path.join(petDirectory, "memory"))
    );
    await expect(ensureSafeMemoryPaths("missing-pet")).rejects.toThrow();
    await expect(fs.access(path.join(temporaryDirectory, "pets", "missing-pet"))).rejects.toThrow();
  });

  it("rejects a memory junction that escapes the pet directory", async () => {
    const petDirectory = path.join(temporaryDirectory, "pets", "pet-a");
    const outsideDirectory = path.join(temporaryDirectory, "outside");
    await fs.mkdir(petDirectory, { recursive: true });
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.symlink(outsideDirectory, path.join(petDirectory, "memory"), "junction");
    const { ensureSafeMemoryPaths } = await import("./memoryPaths");

    await expect(ensureSafeMemoryPaths("pet-a")).rejects.toThrow();
    expect(await fs.readdir(outsideDirectory)).toEqual([]);
  });
});
