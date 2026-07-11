import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeBufferFileAtomically,
  writeTextFileAtomically
} from "./durableJsonFile";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-atomic-file-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("durable atomic file writes", () => {
  it("creates parent directories and durably writes text and binary content", async () => {
    const textPath = path.join(temporaryDirectory, "nested", "config.yaml");
    const bufferPath = path.join(temporaryDirectory, "nested", "avatar.png");
    const imageBytes = Buffer.from([0, 1, 2, 127, 255]);

    await writeTextFileAtomically(textPath, "fixture: true\n");
    await writeBufferFileAtomically(bufferPath, imageBytes);

    expect(await fs.readFile(textPath, "utf8")).toBe("fixture: true\n");
    expect(await fs.readFile(bufferPath)).toEqual(imageBytes);
  });

  it("keeps the previous file and removes its temp file when rename fails", async () => {
    const targetPath = path.join(temporaryDirectory, "settings.json");
    await writeTextFileAtomically(targetPath, "old content");
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(targetPath)) {
        throw Object.assign(new Error("fixture rename failure"), { code: "EIO" });
      }

      return originalRename(source, target);
    });

    await expect(writeTextFileAtomically(targetPath, "new content")).rejects.toThrow(
      "fixture rename failure"
    );

    expect(await fs.readFile(targetPath, "utf8")).toBe("old content");
    expect((await fs.readdir(temporaryDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual(
      []
    );
  });
});
