import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProtocolHandler = (request: { url: string }) => Promise<Response>;

const electronMock = vi.hoisted(() => ({
  userDataPath: "",
  encryptionAvailable: true,
  encryptString: vi.fn((value: string) => Buffer.from(value, "utf8").reverse()),
  decryptString: vi.fn((value: Buffer) => Buffer.from(value).reverse().toString("utf8")),
  netFetch: vi.fn(async () => new Response("fixture-resource", { status: 200 })),
  protocolHandlers: new Map<string, ProtocolHandler>()
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath,
    isReady: () => true
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  safeStorage: {
    isEncryptionAvailable: () => electronMock.encryptionAvailable,
    encryptString: electronMock.encryptString,
    decryptString: electronMock.decryptString
  },
  net: {
    fetch: electronMock.netFetch
  },
  protocol: {
    handle: vi.fn((scheme: string, handler: ProtocolHandler) => {
      electronMock.protocolHandlers.set(scheme, handler);
    })
  }
}));

const legacyCredentials = {
  appId: "fixture-app-id",
  secretId: "fixture-secret-id",
  secretKey: "fixture-secret-key"
};

let temporaryDirectory = "";

function getPetDirectory(petId = "pet-a"): string {
  return path.join(temporaryDirectory, "pets", petId);
}

function getPetConfigPath(petId = "pet-a"): string {
  return path.join(getPetDirectory(petId), "pet.local.json");
}

async function writeLegacyPet(petId = "pet-a"): Promise<void> {
  await fs.mkdir(getPetDirectory(petId), { recursive: true });
  await fs.writeFile(
    getPetConfigPath(petId),
    JSON.stringify(
      {
        id: petId,
        name: "Fixture Pet",
        description: "",
        modelPath: "",
        personaPrompt: "",
        capabilities: {
          chat: true,
          voiceInput: true,
          voiceOutput: false,
          subtitles: true
        },
        details: {
          role: "",
          personality: "",
          scenes: [],
          features: []
        },
        expressions: {},
        expressionDescriptions: {},
        lines: {},
        subtitleStyle: {
          tone: "soft"
        },
        voiceInputSettings: {
          provider: "tencent-asr",
          ...legacyCredentials,
          connected: true,
          autoEndEnabled: true,
          silenceSeconds: 1,
          volumeThreshold: 0.18,
          continuousConversationEnabled: false
        }
      },
      null,
      2
    ),
    "utf8"
  );
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-pet-config-"));
  electronMock.userDataPath = temporaryDirectory;
  electronMock.encryptionAvailable = true;
  electronMock.encryptString.mockClear();
  electronMock.decryptString.mockClear();
  electronMock.netFetch.mockClear();
  electronMock.netFetch.mockImplementation(
    async () => new Response("fixture-resource", { status: 200 })
  );
  electronMock.protocolHandlers.clear();
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Tencent ASR credential migration", () => {
  it("moves legacy plaintext credentials out of pet.local.json and returns only public state", async () => {
    await writeLegacyPet();
    const { listLocalPets } = await import("./petConfigStore");

    const pets = await listLocalPets();
    const pet = pets[0];
    const metadataContent = await fs.readFile(getPetConfigPath(), "utf8");
    const secureContent = await fs.readFile(
      path.join(temporaryDirectory, "secure-secrets.json"),
      "utf8"
    );

    expect(pet?.voiceInputSettings?.hasCredentials).toBe(true);
    expect(pet?.voiceInputSettings?.connected).toBe(true);
    expect(pet?.capabilities.voiceInput).toBe(true);
    expect(pet?.voiceInputSettings).not.toHaveProperty("appId");
    expect(pet?.voiceInputSettings).not.toHaveProperty("secretId");
    expect(pet?.voiceInputSettings).not.toHaveProperty("secretKey");

    for (const credential of Object.values(legacyCredentials)) {
      expect(JSON.stringify(pet)).not.toContain(credential);
      expect(metadataContent).not.toContain(credential);
      expect(secureContent).not.toContain(credential);
    }

    expect(metadataContent).not.toContain('"appId"');
    expect(metadataContent).not.toContain('"secretId"');
    expect(metadataContent).not.toContain('"secretKey"');
    expect(electronMock.encryptString).toHaveBeenCalledTimes(1);
  });

  it("treats legacy plaintext as authoritative until the verified migration completes", async () => {
    await writeLegacyPet();
    const { getSecureString, setSecureString } = await import("./secureConfigStore");
    await setSecureString(
      "tencent-asr",
      "pet-a",
      JSON.stringify({
        appId: "stale-app-id",
        secretId: "stale-secret-id",
        secretKey: "stale-secret-key"
      })
    );
    const { listLocalPets } = await import("./petConfigStore");

    await listLocalPets();
    const migrated = JSON.parse(
      (await getSecureString("tencent-asr", "pet-a")) ?? "{}"
    ) as Record<string, string>;

    expect(migrated).toEqual(legacyCredentials);
  });

  it("preserves the safely stored credential group when all three editor fields are blank", async () => {
    await writeLegacyPet();
    const { listLocalPets, saveLocalPetVoiceInput } = await import("./petConfigStore");
    const { getSecureString } = await import("./secureConfigStore");
    await listLocalPets();

    const result = await saveLocalPetVoiceInput({
      petId: "pet-a",
      appId: "",
      secretId: "",
      secretKey: "",
      connected: true,
      autoEndEnabled: true,
      silenceSeconds: 1,
      volumeThreshold: 0.18,
      continuousConversationEnabled: false
    });
    const storedCredentials = JSON.parse(
      (await getSecureString("tencent-asr", "pet-a")) ?? "{}"
    ) as Record<string, string>;
    const metadataContent = await fs.readFile(getPetConfigPath(), "utf8");

    expect(result.ok).toBe(true);
    expect(storedCredentials).toEqual(legacyCredentials);
    expect(metadataContent).not.toContain(legacyCredentials.appId);
    expect(metadataContent).not.toContain(legacyCredentials.secretId);
    expect(metadataContent).not.toContain(legacyCredentials.secretKey);
  });

  it("removes all secure secrets for a deleted pet without deleting another pet's secret", async () => {
    await writeLegacyPet();
    const { deleteLocalPet, listLocalPets } = await import("./petConfigStore");
    const { getSecureString, setSecureString } = await import("./secureConfigStore");
    await listLocalPets();
    await setSecureString("fixture-scope", "pet-a", "delete-with-pet-a");
    await setSecureString("fixture-scope", "pet-b", "keep-with-pet-b");

    const result = await deleteLocalPet("pet-a");
    const secureContent = await fs.readFile(
      path.join(temporaryDirectory, "secure-secrets.json"),
      "utf8"
    );

    expect(result.ok).toBe(true);
    await expect(fs.access(getPetDirectory())).rejects.toThrow();
    await expect(getSecureString("tencent-asr", "pet-a")).resolves.toBeUndefined();
    await expect(getSecureString("fixture-scope", "pet-a")).resolves.toBeUndefined();
    await expect(getSecureString("fixture-scope", "pet-b")).resolves.toBe("keep-with-pet-b");
    expect(secureContent).not.toContain("pet-a");
    expect(secureContent).toContain("pet-b");
  });

  it("keeps legacy plaintext on disk but redacts the DTO when safe storage is unavailable", async () => {
    await writeLegacyPet();
    electronMock.encryptionAvailable = false;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { listLocalPets, resetLocalPetVoiceRuntimeState } = await import("./petConfigStore");

    try {
      const pets = await listLocalPets();
      const pet = pets[0];
      await expect(resetLocalPetVoiceRuntimeState()).resolves.toBeUndefined();
      const metadataContent = await fs.readFile(getPetConfigPath(), "utf8");

      expect(pet?.voiceInputSettings?.hasCredentials).toBe(false);
      expect(pet?.voiceInputSettings?.connected).toBe(false);
      expect(pet?.capabilities.voiceInput).toBe(false);
      expect(pet?.voiceInputSettings).not.toHaveProperty("appId");
      expect(pet?.voiceInputSettings).not.toHaveProperty("secretId");
      expect(pet?.voiceInputSettings).not.toHaveProperty("secretKey");
      expect(metadataContent).toContain(legacyCredentials.appId);
      expect(metadataContent).toContain(legacyCredentials.secretId);
      expect(metadataContent).toContain(legacyCredentials.secretKey);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("expression mapping persistence", () => {
  it("rebuilds mappings from the current draft so an empty draft clears old mappings", async () => {
    await writeLegacyPet();
    const configPath = getPetConfigPath();
    const existing = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;

    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...existing,
          expressions: { angry: "Tap" },
          expressionDescriptions: { angry: "旧描述" },
          expressionSourceKinds: { angry: "motion" },
          expressionSourceFiles: { angry: "angry01.mtn" },
          expressionEffects: { angry: { parameters: [{ id: "ParamAngleX", value: 1 }] } },
          expressionSources: [
            { sourceFileName: "angry01.mtn", runtimeName: "Tap", sourceKind: "motion" }
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    const { saveLocalPetExpressionMappings } = await import("./petConfigStore");

    const result = await saveLocalPetExpressionMappings({
      petId: "pet-a",
      mappings: [],
      expressionSelectionMode: "semantic",
      expressionRandomScope: "all"
    });

    expect(result.ok).toBe(true);
    expect(result.pet?.expressions).toEqual({});
    expect(result.pet?.expressionDescriptions).toEqual({});
    expect(result.pet?.expressionSourceKinds).toEqual({});
    expect(result.pet?.expressionSourceFiles).toEqual({});
    expect(result.pet?.expressionEffects).toEqual({});
    expect(result.pet?.expressionSources).toEqual([
      { sourceFileName: "angry01.mtn", runtimeName: "Tap", sourceKind: "motion" }
    ]);
  });
});

describe("pet-resource protocol handler boundary", () => {
  it("rejects local config and voice paths while serving assets and Live2D resources", async () => {
    const petDirectory = getPetDirectory();
    const assetPath = path.join(petDirectory, "assets", "avatar.png");
    const modelPath = path.join(petDirectory, "live2d", "model.model3.json");
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.mkdir(path.join(petDirectory, "voice"), { recursive: true });
    await fs.writeFile(getPetConfigPath(), "{}", "utf8");
    await fs.writeFile(path.join(petDirectory, "voice", "reference.wav"), "voice", "utf8");
    await fs.writeFile(assetPath, "image", "utf8");
    await fs.writeFile(modelPath, "{}", "utf8");

    const { registerPetResourceProtocol } = await import("./petResourceProtocol");
    registerPetResourceProtocol();
    const handler = electronMock.protocolHandlers.get("pet-resource");

    expect(handler).toBeDefined();
    await expect(
      handler?.({ url: "pet-resource://local/pet-a/pet.local.json" })
    ).rejects.toThrow();
    await expect(
      handler?.({ url: "pet-resource://local/pet-a/voice/reference.wav" })
    ).rejects.toThrow();

    const assetResponse = await handler?.({
      url: "pet-resource://local/pet-a/assets/avatar.png"
    });
    const modelResponse = await handler?.({
      url: "pet-resource://local/pet-a/live2d/model.model3.json"
    });

    expect(assetResponse?.status).toBe(200);
    expect(modelResponse?.status).toBe(200);
    expect(assetResponse?.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(electronMock.netFetch).toHaveBeenCalledTimes(2);
  });
});
