import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAiBaseUrl } from "../../../shared/types/ai";

const electronMock = vi.hoisted(() => ({
  userDataPath: "",
  encryptionAvailable: true,
  encryptString: vi.fn((value: string) => Buffer.from(value, "utf8").reverse()),
  decryptString: vi.fn((value: Buffer) => Buffer.from(value).reverse().toString("utf8"))
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath,
    isReady: () => true
  },
  safeStorage: {
    isEncryptionAvailable: () => electronMock.encryptionAvailable,
    encryptString: electronMock.encryptString,
    decryptString: electronMock.decryptString
  }
}));

let temporaryDirectory = "";
let fetchMock: ReturnType<typeof vi.fn>;

function createModelsResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function createProbeResponse(content = '{"reply":"probe-ok"}'): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }
  );
}

async function writeLegacySettings(apiKey = "legacy-secret"): Promise<void> {
  await fs.writeFile(
    path.join(temporaryDirectory, "ai-connections.json"),
    JSON.stringify({
      connections: {
        "pet-a": {
          petId: "pet-a",
          providerName: "Provider A",
          baseUrl: "https://old.example.com/",
          model: "model-a",
          models: [{ id: "model-a", name: "model-a" }],
          apiKey,
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    }),
    "utf8"
  );
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-ai-settings-"));
  electronMock.userDataPath = temporaryDirectory;
  electronMock.encryptionAvailable = true;
  electronMock.encryptString.mockClear();
  electronMock.decryptString.mockClear();
  fetchMock = vi.fn(async () => createModelsResponse());
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("AI API key storage", () => {
  it("canonicalizes endpoint bindings consistently", () => {
    expect(normalizeAiBaseUrl(" HTTPS://API.Example.COM:443/v1///#fragment ")).toBe(
      "https://api.example.com/v1"
    );
    expect(normalizeAiBaseUrl("http://Example.COM:80/")).toBe("http://example.com");
  });

  it("migrates a legacy plaintext key and removes it from public metadata", async () => {
    await writeLegacySettings();
    const {
      getAiConnectionConfig,
      getAiConnectionSummary,
      migrateLegacyAiConnections
    } = await import("./aiSettings");

    await migrateLegacyAiConnections();
    await migrateLegacyAiConnections();
    const summary = await getAiConnectionSummary("pet-a");
    const resolved = await getAiConnectionConfig("pet-a");
    const metadataContent = await fs.readFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      "utf8"
    );
    const secureContent = await fs.readFile(
      path.join(temporaryDirectory, "secure-secrets.json"),
      "utf8"
    );

    expect(summary?.hasApiKey).toBe(true);
    expect(resolved?.apiKey).toBe("legacy-secret");
    expect(metadataContent).not.toContain("apiKey");
    expect(metadataContent).not.toContain("legacy-secret");
    expect(secureContent).not.toContain("legacy-secret");
    expect(secureContent).not.toContain("https://old.example.com");
  });

  it("only reuses a saved key for the same normalized Base URL", async () => {
    await writeLegacySettings();
    const { listAiModels } = await import("./aiSettings");

    const sameEndpoint = await listAiModels({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://old.example.com",
      model: "model-a",
      apiKey: ""
    });

    expect(sameEndpoint.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer legacy-secret"
    );

    fetchMock.mockClear();
    const changedEndpoint = await listAiModels({
      petId: "pet-a",
      providerName: "Provider B",
      baseUrl: "https://new.example.com",
      model: "model-a",
      apiKey: ""
    });

    expect(changedEndpoint.ok).toBe(false);
    expect(changedEndpoint.code).toBe("API_KEY_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();

    const explicitNewKey = await listAiModels({
      petId: "pet-a",
      providerName: "Provider B",
      baseUrl: "https://new.example.com",
      model: "model-a",
      apiKey: "new-secret"
    });

    expect(explicitNewKey.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer new-secret"
    );
  });

  it("preserves concurrent saves for different pets without writing plaintext keys", async () => {
    const { saveAiConnection } = await import("./aiSettings");

    await Promise.all([
      saveAiConnection({
        petId: "pet-a",
        providerName: "Provider A",
        baseUrl: "https://a.example.com",
        model: "model-a",
        apiKey: "secret-a"
      }),
      saveAiConnection({
        petId: "pet-b",
        providerName: "Provider B",
        baseUrl: "https://b.example.com",
        model: "model-b",
        apiKey: "secret-b"
      })
    ]);

    const metadataContent = await fs.readFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      "utf8"
    );
    const metadata = JSON.parse(metadataContent) as {
      connections: Record<string, Record<string, unknown>>;
    };

    expect(Object.keys(metadata.connections).sort()).toEqual(["pet-a", "pet-b"]);
    expect(metadata.connections["pet-a"]).not.toHaveProperty("apiKey");
    expect(metadata.connections["pet-b"]).not.toHaveProperty("apiKey");
    expect(metadataContent).not.toContain("secret-a");
    expect(metadataContent).not.toContain("secret-b");
  });

  it("fails closed when a legacy key cannot be encrypted", async () => {
    await writeLegacySettings();
    electronMock.encryptionAvailable = false;
    const { listAiModels } = await import("./aiSettings");

    const result = await listAiModels({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://old.example.com",
      model: "model-a",
      apiKey: ""
    });
    const legacyContent = await fs.readFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      "utf8"
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("SECURE_STORAGE_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(legacyContent).toContain("legacy-secret");
  });

  it("keeps legacy AI metadata intact when its atomic rename fails", async () => {
    await writeLegacySettings();
    const settingsPath = path.join(temporaryDirectory, "ai-connections.json");
    const originalContent = await fs.readFile(settingsPath, "utf8");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(settingsPath)) {
        throw Object.assign(new Error("fixture AI rename failure"), { code: "EIO" });
      }

      return originalRename(source, target);
    });
    const { migrateLegacyAiConnections } = await import("./aiSettings");

    try {
      await expect(migrateLegacyAiConnections()).rejects.toThrow("fixture AI rename failure");
      expect(await fs.readFile(settingsPath, "utf8")).toBe(originalContent);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("does not contact the API when a new key cannot be stored safely", async () => {
    electronMock.encryptionAvailable = false;
    const { saveAiConnection } = await import("./aiSettings");

    const result = await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://new.example.com",
      model: "model-a",
      apiKey: "new-secret"
    });

    expect(result.test.ok).toBe(false);
    expect(result.test.code).toBe("SECURE_STORAGE_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not contact the API when encryption throws despite being available", async () => {
    electronMock.encryptString.mockImplementationOnce(() => {
      throw new Error("fixture encryption failure");
    });
    const { saveAiConnection } = await import("./aiSettings");

    const result = await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://new.example.com",
      model: "model-a",
      apiKey: "new-secret"
    });

    expect(result.test.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists a v3 capability for the exact endpoint and model without exposing the key", async () => {
    fetchMock
      .mockResolvedValueOnce(createModelsResponse())
      .mockResolvedValueOnce(createProbeResponse());
    const {
      getAiConnectionConfig,
      getAiConnectionSummary,
      saveAiConnection
    } = await import("./aiSettings");

    const saved = await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1/",
      model: "model-a",
      apiKey: "private-key"
    });
    const summary = await getAiConnectionSummary("pet-a");
    const resolved = await getAiConnectionConfig("pet-a");
    const metadataContent = await fs.readFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      "utf8"
    );
    const metadata = JSON.parse(metadataContent) as {
      version: number;
      connections: Record<string, { outputCapability?: Record<string, unknown> }>;
    };

    expect(saved.config.outputCapability).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      mode: "json-schema",
      streaming: true,
      confidence: "tested"
    });
    expect(summary?.outputCapability).toEqual(saved.config.outputCapability);
    expect(resolved?.outputCapability).toEqual(saved.config.outputCapability);
    expect(metadata.version).toBe(3);
    expect(metadata.connections["pet-a"]?.outputCapability).toEqual(saved.config.outputCapability);
    expect(metadataContent).not.toContain("private-key");
  });

  it("discards a stored capability when its endpoint or model tuple is stale", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 3,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Provider A",
            baseUrl: "https://api.example.com/v1",
            model: "model-new",
            models: [{ id: "model-new", name: "model-new" }],
            outputCapability: {
              baseUrl: "https://api.example.com/v1",
              model: "model-old",
              mode: "json-schema",
              streaming: true,
              confidence: "tested",
              checkedAt: "2026-07-15T00:00:00.000Z"
            },
            updatedAt: "2026-07-15T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const { getAiConnectionSummary } = await import("./aiSettings");

    await expect(getAiConnectionSummary("pet-a")).resolves.toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "model-new",
      outputCapability: undefined
    });
  });

  it("upgrades a v2 connection without capability metadata and keeps it usable", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 2,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Legacy Provider",
            baseUrl: "https://legacy.example.com/v1/",
            model: "legacy-model",
            models: [{ id: "legacy-model", name: "Legacy Model" }],
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const { getAiConnectionSummary } = await import("./aiSettings");

    const summary = await getAiConnectionSummary("pet-a");
    const rewritten = JSON.parse(
      await fs.readFile(path.join(temporaryDirectory, "ai-connections.json"), "utf8")
    ) as { version: number; connections: Record<string, Record<string, unknown>> };

    expect(summary).toMatchObject({
      petId: "pet-a",
      providerName: "Legacy Provider",
      baseUrl: "https://legacy.example.com/v1",
      model: "legacy-model",
      models: [{ id: "legacy-model", name: "Legacy Model" }],
      outputCapability: undefined
    });
    expect(rewritten.version).toBe(3);
    expect(rewritten.connections["pet-a"]).not.toHaveProperty("outputCapability");
  });

  it("uses only a fixed probe conversation and does not create memory data", async () => {
    await writeLegacySettings();
    fetchMock.mockResolvedValueOnce(createProbeResponse());
    const { testAiOutputCapability } = await import("./aiSettings");

    const result = await testAiOutputCapability({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://old.example.com",
      model: "model-a",
      apiKey: ""
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const entries = await fs.readdir(temporaryDirectory, { recursive: true });

    expect(result.ok).toBe(true);
    expect(requestBody.messages).toEqual([
      {
        role: "system",
        content: "这是连接能力测试。不要输出推理、Markdown 或解释；请只返回包含 reply 字段的 JSON。"
      },
      { role: "user", content: "将 reply 设置为 probe-ok。" }
    ]);
    expect(entries.some((entry) => /memory|ledger|pending/i.test(entry))).toBe(false);
  });
});
