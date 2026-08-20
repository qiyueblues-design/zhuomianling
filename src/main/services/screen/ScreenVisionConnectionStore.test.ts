import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisionCapability } from "../../../shared/types/screen";
import { withPetConfigWriteLock } from "../config/petConfigWriteQueue";

let userData = "";

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    isReady: () => true
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => Buffer.from(value).toString("utf8")
  }
}));

import {
  deleteScreenVisionConnectionWhilePetConfigLocked,
  getChatVisionCapability,
  saveChatVisionCapability,
  saveChatVisionCapabilityWhilePetConfigLocked
} from "./ScreenVisionConnectionStore";

const capability: VisionCapability = {
  visionInput: "tested",
  checkedAt: "2026-08-21T00:00:00.000Z",
  fingerprint: {
    normalizedBaseUrl: "https://vision.example.test/v1",
    model: "vision-model",
    providerProtocol: "openai-compatible",
    visionInputFormat: "image_url-data-url",
    probeVersion: 1
  },
  probeVersion: 1
};

describe("screen vision connection store lock boundaries", () => {
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), "zmling-screen-vision-"));
  });

  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  it("saves a capability while the caller already owns the pet lock", async () => {
    await withPetConfigWriteLock("pet-a", () =>
      saveChatVisionCapabilityWhilePetConfigLocked("pet-a", capability)
    );

    await expect(getChatVisionCapability("pet-a")).resolves.toEqual(capability);
  });

  it("keeps the public save path locked and deletes through the locked path", async () => {
    await saveChatVisionCapability("pet-a", capability);

    await withPetConfigWriteLock("pet-a", () =>
      deleteScreenVisionConnectionWhilePetConfigLocked("pet-a")
    );

    await expect(getChatVisionCapability("pet-a")).resolves.toBeUndefined();
  });
});
