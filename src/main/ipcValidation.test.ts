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

  it("accepts only bounded finite desktop scale settings", () => {
    const validDraft = {
      petId: "pet-a",
      theme: "soft",
      desktopScale: 1.25
    };
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [validDraft]))
      .not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: 0.7
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: 1.5
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: 0.69
    }])).toThrow(/desktopScale/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: 1.51
    }])).toThrow(/desktopScale/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: Number.NaN
    }])).toThrow(/desktopScale/);
  });

  it("accepts only supported GPT-SoVITS model versions", () => {
    expect(() => validateIpcArguments("pet-config:save-voice-model", [{
      petId: "pet-a",
      modelVersion: "v4"
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-config:test-voice-model-connection", [{
      petId: "pet-a",
      modelVersion: "v5"
    }])).toThrow(/modelVersion/);
  });

  it("accepts a bounded AI output probe and rejects oversized connection fields", () => {
    expect(() =>
      validateIpcArguments("ai-settings:test-output", [
        {
          petId: "pet-a",
          providerName: "Custom",
          baseUrl: "https://api.example.com/v1",
          model: "model-a",
          apiKey: "secret"
        }
      ])
    ).not.toThrow();
    expect(() =>
      validateIpcArguments("ai-settings:test-output", [
        {
          petId: "pet-a",
          providerName: "Custom",
          baseUrl: `https://example.com/${"x".repeat(4096)}`,
          model: "model-a",
          apiKey: "secret"
        }
      ])
    ).toThrow(/4096/);
  });

  it("accepts bounded memory management requests and explicit destructive confirmations", () => {
    expect(() => validateIpcArguments("memory:list", [{ petId: "pet-a", pageSize: 5 }])).not.toThrow();
    expect(() => validateIpcArguments("memory:get-source-conversation", [{
      petId: "pet-a",
      memoryId: "memory-1"
    }])).not.toThrow();
    expect(() => validateIpcArguments("memory:create", [{
      petId: "pet-a",
      chapter: "about_you",
      memoryType: "profile",
      content: "A bounded manual memory",
      tags: ["manual"]
    }])).not.toThrow();
    expect(() => validateIpcArguments("memory:clear", [{
      petId: "pet-a",
      confirmPetId: "pet-a"
    }])).not.toThrow();
  });

  it("rejects oversized, unknown-field, and mismatched memory management payloads", () => {
    expect(() => validateIpcArguments("memory:list", [{ petId: "pet-a", pageSize: 6 }])).toThrow(/1-5/);
    expect(() => validateIpcArguments("memory:create", [{
      petId: "pet-a",
      chapter: "about_you",
      memoryType: "profile",
      content: "x".repeat(8_193)
    }])).toThrow(/8192/);
    expect(() => validateIpcArguments("memory:get", [{
      petId: "pet-a",
      memoryId: "memory-1",
      databasePath: "C:\\private\\ledger.sqlite3"
    }])).toThrow(/databasePath/);
    expect(() => validateIpcArguments("memory:get-source-conversation", [{
      petId: "pet-a",
      memoryId: "memory-1",
      requestId: "private-source-request"
    }])).toThrow(/requestId/);
    expect(() => validateIpcArguments("memory:clear", [{
      petId: "pet-a",
      confirmPetId: "pet-b"
    }])).toThrow(/confirmation|确认|match/i);
  });

  it("accepts a shared expression source across event settings", () => {
    const source = {
      sourceKind: "expression",
      sourceFileName: "smile.exp3.json",
      runtimeName: "smile"
    };

    expect(() =>
      validateIpcArguments("pet-config:save-event-settings", [
        {
          petId: "pet-a",
          events: [
            { event: "idle", source, lines: [] },
            { event: "close", source, lines: [] }
          ]
        }
      ])
    ).not.toThrow();
  });

  it("still rejects a real circular payload", () => {
    const payload: Record<string, unknown> = {
      petId: "pet-a",
      requestId: "request-0001",
      messages: [{ role: "user", content: "ok" }]
    };
    payload.self = payload;

    expect(() => validateIpcArguments("ai-chat:stream", [payload])).toThrow(/循环引用/);
  });

  it("validates a bounded desktop source preview request", () => {
    expect(() =>
      validateIpcArguments("pet-window:preview-source", [
        {
          petId: "pet-a",
          source: {
            sourceKind: "motion",
            sourceFileName: "angry01.mtn",
            runtimeName: "Tap"
          }
        }
      ])
    ).not.toThrow();
    expect(() =>
      validateIpcArguments("pet-window:preview-source", [
        {
          petId: "pet-a",
          source: { sourceKind: "motion", sourceFileName: "angry01.mtn" }
        }
      ])
    ).toThrow(/runtimeName/);
  });

  it("fails closed for an unregistered IPC channel", () => {
    expect(() => validateIpcArguments("unknown:channel", [])).toThrow(/没有注册运行时 schema/);
  });

  it("only accepts fixed renderer startup timing stages", () => {
    expect(() =>
      validateIpcArguments("app-window:startup-timing", ["splash-hidden"])
    ).not.toThrow();
    expect(() =>
      validateIpcArguments("app-window:startup-timing", ["C:\\private\\config.json"])
    ).toThrow(/startup stage/);
    expect(() =>
      validateIpcArguments("app-window:startup-timing", ["splash-hidden", "extra"])
    ).toThrow(/参数数量/);
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
