import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataPath: ""
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath,
    isReady: () => true
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8")
  }
}));

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-secure-store-"));
  electronMock.userDataPath = temporaryDirectory;
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("secure config durable persistence", () => {
  it("preserves the previous encrypted file when its atomic rename fails", async () => {
    const settingsPath = path.join(temporaryDirectory, "secure-secrets.json");
    const { getSecureString, setSecureString } = await import("./secureConfigStore");
    await setSecureString("scope", "pet-a", "secret-a");
    const originalContent = await fs.readFile(settingsPath, "utf8");
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(settingsPath)) {
        throw Object.assign(new Error("fixture secure rename failure"), { code: "EIO" });
      }

      return originalRename(source, target);
    });

    await expect(setSecureString("scope", "pet-b", "secret-b")).rejects.toThrow(
      "fixture secure rename failure"
    );

    expect(await fs.readFile(settingsPath, "utf8")).toBe(originalContent);
    await expect(getSecureString("scope", "pet-a")).resolves.toBe("secret-a");
    await expect(getSecureString("scope", "pet-b")).resolves.toBeUndefined();
  });
});
