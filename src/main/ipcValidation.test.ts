import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateIpcArguments, validatedIpcChannels } from "./ipcValidation";

describe("validateIpcArguments", () => {
  it("accepts a bounded AI stream request", () => {
    expect(() =>
      validateIpcArguments("ai-chat:stream", [
        {
          petId: "pet-a",
          requestId: "request-0001",
          messages: [{ role: "user", content: "你好" }]
        }
      ])
    ).not.toThrow();
  });

  it("rejects traversal and unbounded pet IDs", () => {
    expect(() => validateIpcArguments("pet-config:delete", ["../outside"])).toThrow(/桌宠 ID/);
    expect(() => validateIpcArguments("pet-config:delete", [`p${"x".repeat(64)}`])).toThrow(
      /桌宠 ID/
    );
  });

  it("rejects oversized speech chunks", () => {
    expect(() =>
      validateIpcArguments("speech-stream:audio", [
        {
          sessionId: "desktop-pet-session-0001",
          audio: new ArrayBuffer(262_145)
        }
      ])
    ).toThrow(/262144/);
  });

  it("rejects an unsupported one-shot speech format", () => {
    expect(() =>
      validateIpcArguments("speech-to-text:transcribe", [
        {
          petId: "pet-a",
          format: "exe",
          audioBase64: "AA=="
        }
      ])
    ).toThrow(/format/);
  });

  it("rejects dangerous object keys", () => {
    const payload = JSON.parse(
      '{"petId":"pet-a","requestId":"request-0001","messages":[{"role":"user","content":"ok"}],"__proto__":{"polluted":true}}'
    ) as unknown;

    expect(() => validateIpcArguments("ai-chat:stream", [payload])).toThrow(/__proto__/);
  });

  it("fails closed for an unregistered IPC channel", () => {
    expect(() => validateIpcArguments("unknown:channel", [])).toThrow(/没有注册运行时 schema/);
  });

  it("keeps every IPC registration covered by a validation schema", async () => {
    const ipcSource = await fs.readFile(new URL("./ipc.ts", import.meta.url), "utf8");
    const registeredChannels = Array.from(
      ipcSource.matchAll(/\b(?:handle|on)\("([^"]+)"/g),
      (match) => match[1]
    );

    expect(registeredChannels.length).toBeGreaterThan(40);
    expect(registeredChannels.filter((channel) => !validatedIpcChannels.has(channel))).toEqual([]);
    expect(new Set(registeredChannels)).toEqual(validatedIpcChannels);
  });
});
