import type { WebContents } from "electron";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertIpcSenderAllowed } from "./ipcAccess";

const mainSender = {} as WebContents;
const petSender = {} as WebContents;
const unknownSender = {} as WebContents;

describe("assertIpcSenderAllowed", () => {
  it("keeps configuration and import IPC main-window only", () => {
    expect(() =>
      assertIpcSenderAllowed("pet-config:delete", "main", mainSender, mainSender, false)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("pet-config:delete", "main", petSender, mainSender, true)
    ).toThrow(/不允许/);
  });

  it("keeps AI, TTS, and drag IPC pet-window only", () => {
    expect(() =>
      assertIpcSenderAllowed("ai-chat:stream", "pet", petSender, mainSender, true)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("ai-chat:stream", "pet", mainSender, mainSender, false)
    ).toThrow(/不允许/);
  });

  it("allows shared close/state calls but rejects unknown senders", () => {
    expect(() =>
      assertIpcSenderAllowed("pet-window:close", "both", petSender, mainSender, true)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("pet-window:close", "both", mainSender, mainSender, false)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("pet-window:close", "both", unknownSender, mainSender, false)
    ).toThrow(/不允许/);
  });

  it("keeps the registered sensitive channel access map fail-closed", async () => {
    const ipcSource = await fs.readFile(new URL("./ipc.ts", import.meta.url), "utf8");
    const accessByChannel = new Map(
      Array.from(
        ipcSource.matchAll(/\b(?:handle|on)\("([^"]+)", "(main|pet|both)"/g),
        (match) => [match[1], match[2]] as const
      )
    );

    expect(accessByChannel.size).toBeGreaterThan(40);
    for (const channel of [
      "pet-config:delete",
      "pet-config:save-basic-info",
      "live2d-import:import-model",
      "ai-settings:save"
    ]) {
      expect(accessByChannel.get(channel)).toBe("main");
    }
    for (const channel of [
      "ai-chat:stream",
      "ai-chat:cancel",
      "text-to-speech:speak",
      "speech-stream:start",
      "pet-window:start-drag"
    ]) {
      expect(accessByChannel.get(channel)).toBe("pet");
    }
    expect(accessByChannel.get("pet-window:close")).toBe("both");
    expect(accessByChannel.get("pet-window:get-state")).toBe("both");
  });
});
