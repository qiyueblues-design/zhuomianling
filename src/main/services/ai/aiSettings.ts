import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeAiBaseUrl,
  type AiConnectionConfig,
  type AiConnectionDraft,
  type AiModelListResult,
  type AiConnectionSaveResult,
  type AiConnectionSummary,
  type AiConnectionTestResult,
  type AiOutputCapability,
  type AiOutputCapabilityTestResult,
  type AiModelOption
} from "../../../shared/types/ai";
export { normalizeAiBaseUrl } from "../../../shared/types/ai";
import {
  assertSecureStorageAvailable,
  deleteSecureString,
  getSecureString,
  SecureStorageCorruptedError,
  SecureStorageUnavailableError,
  setSecureString
} from "../config/secureConfigStore";
import { writeJsonFileAtomically } from "../config/durableJsonFile";
import { probeAiOutputCapability } from "./aiCapabilityProbe";

interface AiSettingsFile {
  version: 3;
  connections: Record<string, AiConnectionConfig>;
}

interface ParsedAiSettingsFile {
  settings: AiSettingsFile;
  legacySecrets: Array<{
    petId: string;
    baseUrl: string;
    apiKey: string;
  }>;
  needsRewrite: boolean;
}

interface ResolvedAiConnectionConfig extends AiConnectionConfig {
  apiKey: string;
}

const settingsFileName = "ai-connections.json";
const aiApiKeyScope = "ai-api-key";

let settingsMutationQueue: Promise<void> = Promise.resolve();
let migrationPromise: Promise<void> | undefined;
const petMutationQueues = new Map<string, Promise<void>>();

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), settingsFileName);
}

function normalizeModelOptions(models: unknown): AiModelOption[] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models.flatMap((model) => {
    if (!model || typeof model !== "object") {
      return [];
    }

    const candidate = model as { id?: unknown; name?: unknown };

    if (typeof candidate.id !== "string" || !candidate.id.trim()) {
      return [];
    }

    const id = candidate.id.trim();
    return [
      {
        id,
        name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : id
      }
    ];
  });
}

function normalizeOutputCapability(
  value: unknown,
  baseUrl: string,
  model: string
): AiOutputCapability | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const capabilityBaseUrl =
    typeof candidate.baseUrl === "string" ? normalizeAiBaseUrl(candidate.baseUrl) : "";
  const capabilityModel = typeof candidate.model === "string" ? candidate.model.trim() : "";
  if (capabilityBaseUrl !== baseUrl || capabilityModel !== model) return undefined;
  if (
    candidate.mode !== "json-schema" &&
    candidate.mode !== "json-object" &&
    candidate.mode !== "plain-text"
  ) {
    return undefined;
  }
  if (typeof candidate.streaming !== "boolean") return undefined;
  if (candidate.confidence !== "tested" && candidate.confidence !== "fallback") return undefined;
  if (typeof candidate.checkedAt !== "string" || !candidate.checkedAt) return undefined;

  return {
    baseUrl: capabilityBaseUrl,
    model: capabilityModel,
    mode: candidate.mode,
    streaming: candidate.streaming,
    confidence: candidate.confidence,
    checkedAt: candidate.checkedAt
  };
}

function normalizeStoredConfig(petId: string, value: unknown): AiConnectionConfig {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const baseUrl = typeof candidate.baseUrl === "string" ? normalizeAiBaseUrl(candidate.baseUrl) : "";
  const model = typeof candidate.model === "string" ? candidate.model.trim() : "";

  return {
    petId: typeof candidate.petId === "string" && candidate.petId.trim() ? candidate.petId.trim() : petId,
    providerName:
      typeof candidate.providerName === "string" && candidate.providerName.trim()
        ? candidate.providerName.trim()
        : "OpenAI Compatible",
    baseUrl,
    model,
    models: normalizeModelOptions(candidate.models),
    outputCapability: normalizeOutputCapability(candidate.outputCapability, baseUrl, model),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt
        ? candidate.updatedAt
        : new Date(0).toISOString()
  };
}

function parseSettingsFile(value: unknown): ParsedAiSettingsFile {
  if (!value || typeof value !== "object") {
    throw new Error("AI settings file is invalid.");
  }

  const candidate = value as { version?: unknown; connections?: unknown };

  if (candidate.connections !== undefined && (!candidate.connections || typeof candidate.connections !== "object")) {
    throw new Error("AI settings connections are invalid.");
  }

  const rawConnections = (candidate.connections ?? {}) as Record<string, unknown>;
  const connections: Record<string, AiConnectionConfig> = {};
  const legacySecrets: ParsedAiSettingsFile["legacySecrets"] = [];
  let needsRewrite = candidate.version !== 3;

  for (const [connectionId, rawConnection] of Object.entries(rawConnections)) {
    const normalizedConnection = normalizeStoredConfig(connectionId, rawConnection);
    connections[connectionId] = normalizedConnection;

    if (!rawConnection || typeof rawConnection !== "object") {
      continue;
    }

    const legacyConnection = rawConnection as Record<string, unknown>;

    if (Object.prototype.hasOwnProperty.call(legacyConnection, "apiKey")) {
      needsRewrite = true;

      if (typeof legacyConnection.apiKey === "string" && legacyConnection.apiKey.trim()) {
        legacySecrets.push({
          petId: normalizedConnection.petId,
          baseUrl: normalizedConnection.baseUrl,
          apiKey: legacyConnection.apiKey.trim()
        });
      }
    }
  }

  return {
    settings: {
      version: 3,
      connections
    },
    legacySecrets,
    needsRewrite
  };
}

async function readSettingsFile(): Promise<ParsedAiSettingsFile> {
  try {
    const content = await fs.readFile(getSettingsPath(), "utf8");
    return parseSettingsFile(JSON.parse(content) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        settings: {
          version: 3,
          connections: {}
        },
        legacySecrets: [],
        needsRewrite: false
      };
    }

    throw error;
  }
}

async function writeSettingsFile(settings: AiSettingsFile): Promise<void> {
  await writeJsonFileAtomically(getSettingsPath(), settings);
}

function runSettingsMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = settingsMutationQueue.then(mutation, mutation);
  settingsMutationQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

function runPetMutation<T>(petId: string, mutation: () => Promise<T>): Promise<T> {
  const previous = petMutationQueues.get(petId) ?? Promise.resolve();
  const result = previous.then(mutation, mutation);
  const queueTail = result.then(
    () => undefined,
    () => undefined
  );
  petMutationQueues.set(petId, queueTail);
  void queueTail.finally(() => {
    if (petMutationQueues.get(petId) === queueTail) {
      petMutationQueues.delete(petId);
    }
  });

  return result;
}

export async function migrateLegacyAiConnections(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runSettingsMutation(async () => {
      const parsed = await readSettingsFile();

      if (!parsed.needsRewrite) {
        return;
      }

      for (const legacySecret of parsed.legacySecrets) {
        await setSecureString(
          aiApiKeyScope,
          legacySecret.petId,
          legacySecret.apiKey,
          legacySecret.baseUrl
        );

        const migratedValue = await getSecureString(
          aiApiKeyScope,
          legacySecret.petId,
          legacySecret.baseUrl
        );

        if (migratedValue !== legacySecret.apiKey) {
          throw new SecureStorageCorruptedError();
        }
      }

      // The plaintext file is only replaced after every migrated secret can be
      // decrypted again. A failed migration therefore leaves the legacy file intact.
      await writeSettingsFile(parsed.settings);
    }).catch((error: unknown) => {
      migrationPromise = undefined;
      throw error;
    });
  }

  await migrationPromise;
}

async function readSettings(): Promise<AiSettingsFile> {
  await migrateLegacyAiConnections();
  return (await readSettingsFile()).settings;
}

function normalizeDraft(draft: AiConnectionDraft): AiConnectionDraft {
  return {
    petId: draft.petId.trim(),
    providerName: draft.providerName.trim() || "OpenAI Compatible",
    baseUrl: normalizeAiBaseUrl(draft.baseUrl),
    model: draft.model.trim(),
    apiKey: draft.apiKey.trim(),
    models: normalizeModelOptions(draft.models)
  };
}

async function toSummary(config: AiConnectionConfig): Promise<AiConnectionSummary> {
  const apiKey = await getSecureString(aiApiKeyScope, config.petId, config.baseUrl);

  return {
    petId: config.petId,
    providerName: config.providerName,
    baseUrl: config.baseUrl,
    model: config.model,
    models: config.models ?? [],
    outputCapability: config.outputCapability,
    hasApiKey: Boolean(apiKey),
    updatedAt: config.updatedAt
  };
}

function toUnsavedSummary(draft: AiConnectionDraft): AiConnectionSummary {
  return {
    petId: draft.petId,
    providerName: draft.providerName,
    baseUrl: draft.baseUrl,
    model: draft.model,
    models: draft.models ?? [],
    hasApiKey: false
  };
}

function getSettingsFailure(
  error: unknown,
  checkedAt: string
): Pick<AiConnectionTestResult, "ok" | "message" | "checkedAt" | "code"> {
  if (error instanceof SecureStorageUnavailableError) {
    return {
      ok: false,
      message: error.message,
      checkedAt,
      code: "SECURE_STORAGE_UNAVAILABLE"
    };
  }

  if (error instanceof SecureStorageCorruptedError) {
    return {
      ok: false,
      message: error.message,
      checkedAt,
      code: "SECURE_STORAGE_CORRUPTED"
    };
  }

  return {
    ok: false,
    message: "无法读取或保存本机 AI 设置，请检查配置文件权限。",
    checkedAt,
    code: "INVALID_AI_SETTINGS"
  };
}

function getMissingApiKeyResult(
  checkedAt: string,
  endpointChanged: boolean
): AiModelListResult {
  return {
    ok: false,
    message: endpointChanged
      ? "Base URL 已更改，请重新输入 API Key；旧密钥不会用于新的服务地址。"
      : "请填写桌宠、Base URL 和 API Key。",
    checkedAt,
    code: "API_KEY_REQUIRED",
    models: []
  };
}

async function resolveApiKey(
  draft: AiConnectionDraft,
  existingConfig: AiConnectionConfig | undefined
): Promise<{ apiKey?: string; endpointChanged: boolean }> {
  if (draft.apiKey) {
    return {
      apiKey: draft.apiKey,
      endpointChanged: false
    };
  }

  const endpointChanged = Boolean(
    existingConfig && existingConfig.baseUrl !== normalizeAiBaseUrl(draft.baseUrl)
  );

  if (!existingConfig || endpointChanged) {
    return {
      endpointChanged
    };
  }

  return {
    apiKey: await getSecureString(aiApiKeyScope, draft.petId, existingConfig.baseUrl),
    endpointChanged: false
  };
}

function buildModelsUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/`);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (normalizedPath && normalizedPath !== "") {
    url.pathname = `${normalizedPath}/models`;
    return url.toString();
  }

  url.pathname = `${normalizedPath}/v1/models`;
  return url.toString();
}

function getModelName(model: unknown): string {
  if (typeof model === "string") {
    return model;
  }

  if (model && typeof model === "object" && "id" in model && typeof model.id === "string") {
    return model.id;
  }

  return "";
}

async function fetchAiModels(
  draft: AiConnectionDraft,
  apiKey: string,
  checkedAt: string
): Promise<AiModelListResult> {
  let response: Response;

  try {
    response = await fetch(buildModelsUrl(draft.baseUrl), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
  } catch {
    return {
      ok: false,
      message: "无法连接到 Base URL，请检查地址或本地服务是否启动。",
      checkedAt,
      models: []
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `连接失败，服务返回 ${response.status}。`,
      checkedAt,
      models: []
    };
  }

  let body: { data?: unknown[] };

  try {
    body = (await response.json()) as { data?: unknown[] };
  } catch {
    return {
      ok: false,
      message: "连接成功，但服务返回的模型列表格式无效。",
      checkedAt,
      models: []
    };
  }

  const models =
    body.data
      ?.map((model) => {
        const id = getModelName(model);

        return id
          ? {
              id,
              name: id
            }
          : undefined;
      })
      .filter((model): model is { id: string; name: string } => Boolean(model)) ?? [];

  if (!models.length) {
    return {
      ok: false,
      message: "连接成功，但没有获取到可选择的模型列表。",
      checkedAt,
      models: []
    };
  }

  return {
    ok: true,
    message: "连接成功，请选择要使用的模型。",
    checkedAt,
    models
  };
}

export async function listAiConnectionSummaries(): Promise<AiConnectionSummary[]> {
  const settings = await readSettings();
  return Promise.all(Object.values(settings.connections).map(toSummary));
}

export async function getAiConnectionSummary(
  petId: string
): Promise<AiConnectionSummary | undefined> {
  const normalizedPetId = petId.trim();
  const settings = await readSettings();
  const config = settings.connections[normalizedPetId];
  return config ? toSummary(config) : undefined;
}

export async function getAiConnectionConfig(
  petId: string
): Promise<ResolvedAiConnectionConfig | undefined> {
  const normalizedPetId = petId.trim();
  const settings = await readSettings();
  const config = settings.connections[normalizedPetId];

  if (!config) {
    return undefined;
  }

  const apiKey = await getSecureString(aiApiKeyScope, config.petId, config.baseUrl);

  return {
    ...config,
    apiKey: apiKey ?? ""
  };
}

export async function listAiModels(draft: AiConnectionDraft): Promise<AiModelListResult> {
  const normalized = normalizeDraft(draft);
  const checkedAt = new Date().toISOString();

  if (!normalized.petId || !normalized.baseUrl) {
    return getMissingApiKeyResult(checkedAt, false);
  }

  let settings: AiSettingsFile;
  let resolution: Awaited<ReturnType<typeof resolveApiKey>>;

  try {
    settings = await readSettings();
    resolution = await resolveApiKey(normalized, settings.connections[normalized.petId]);
  } catch (error: unknown) {
    return {
      ...getSettingsFailure(error, checkedAt),
      models: []
    };
  }

  if (!resolution.apiKey) {
    return getMissingApiKeyResult(checkedAt, resolution.endpointChanged);
  }

  return fetchAiModels(normalized, resolution.apiKey, checkedAt);
}

export async function testAiConnection(draft: AiConnectionDraft): Promise<AiConnectionTestResult> {
  const modelsResult = await listAiModels(draft);

  return {
    ok: modelsResult.ok,
    message: modelsResult.ok ? "连接成功，设置已保存。" : modelsResult.message,
    checkedAt: modelsResult.checkedAt,
    code: modelsResult.code
  };
}

function getCapabilityMessage(capability: AiOutputCapability): string {
  if (capability.confidence === "fallback") {
    return "聊天能力探测未完成，将使用兼容模式。";
  }
  const modeLabel =
    capability.mode === "json-schema"
      ? "结构化回复"
      : capability.mode === "json-object"
        ? "JSON 回复"
        : "兼容文本";
  return `${modeLabel} · ${capability.streaming ? "支持流式" : "完整回复模式"}`;
}

export async function testAiOutputCapability(
  draft: AiConnectionDraft
): Promise<AiOutputCapabilityTestResult> {
  const normalized = normalizeDraft(draft);
  const checkedAt = new Date().toISOString();

  if (!normalized.petId || !normalized.baseUrl || !normalized.model) {
    return {
      ok: false,
      message: "请先填写 Base URL 并选择模型。",
      checkedAt,
      code: "INVALID_AI_SETTINGS"
    };
  }

  return runPetMutation(normalized.petId, async () => {
    let settings: AiSettingsFile;
    let resolution: Awaited<ReturnType<typeof resolveApiKey>>;
    try {
      settings = await readSettings();
      resolution = await resolveApiKey(normalized, settings.connections[normalized.petId]);
    } catch (error: unknown) {
      return getSettingsFailure(error, checkedAt);
    }

    if (!resolution.apiKey) {
      return getMissingApiKeyResult(checkedAt, resolution.endpointChanged);
    }

    const probe = await probeAiOutputCapability({
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      apiKey: resolution.apiKey,
      checkedAt
    });

    const existing = settings.connections[normalized.petId];
    if (existing?.baseUrl === normalized.baseUrl && existing.model === normalized.model) {
      await runSettingsMutation(async () => {
        const latest = (await readSettingsFile()).settings;
        const current = latest.connections[normalized.petId];
        if (current?.baseUrl === normalized.baseUrl && current.model === normalized.model) {
          current.outputCapability = probe.capability;
          await writeSettingsFile(latest);
        }
      });
    }

    return {
      ok: probe.tested,
      message: getCapabilityMessage(probe.capability),
      checkedAt,
      capability: probe.capability
    };
  });
}

export async function recordAiOutputCapability(
  petId: string,
  expectedBaseUrl: string,
  expectedModel: string,
  capability: AiOutputCapability
): Promise<void> {
  await runPetMutation(petId, async () => {
    await runSettingsMutation(async () => {
      const settings = (await readSettingsFile()).settings;
      const current = settings.connections[petId];
      if (
        !current ||
        current.baseUrl !== normalizeAiBaseUrl(expectedBaseUrl) ||
        current.model !== expectedModel.trim()
      ) {
        return;
      }
      current.outputCapability = capability;
      await writeSettingsFile(settings);
    });
  });
}

export async function saveAiConnection(
  draft: AiConnectionDraft
): Promise<AiConnectionSaveResult> {
  const normalized = normalizeDraft(draft);

  if (!normalized.petId) {
    const checkedAt = new Date().toISOString();
    return {
      config: toUnsavedSummary(normalized),
      test: {
        ok: false,
        message: "请先选择要配置的桌宠。",
        checkedAt,
        code: "INVALID_AI_SETTINGS"
      }
    };
  }

  return runPetMutation(normalized.petId, async () => {
    const checkedAt = new Date().toISOString();
    let settings: AiSettingsFile;
    let resolution: Awaited<ReturnType<typeof resolveApiKey>>;

    try {
      settings = await readSettings();
      resolution = await resolveApiKey(normalized, settings.connections[normalized.petId]);
    } catch (error: unknown) {
      return {
        config: toUnsavedSummary(normalized),
        test: getSettingsFailure(error, checkedAt)
      };
    }

    if (!normalized.baseUrl || !resolution.apiKey) {
      return {
        config: toUnsavedSummary(normalized),
        test: getMissingApiKeyResult(checkedAt, resolution.endpointChanged)
      };
    }

    const existingConfig = settings.connections[normalized.petId];

    try {
      assertSecureStorageAvailable();
      // Encrypt and persist before contacting the endpoint. This proves that
      // the new key can be stored safely; a broken encryption backend must
      // never discover the key only after it has already been sent.
      await setSecureString(
        aiApiKeyScope,
        normalized.petId,
        resolution.apiKey,
        normalized.baseUrl
      );
    } catch (error: unknown) {
      return {
        config: toUnsavedSummary(normalized),
        test: getSettingsFailure(error, checkedAt)
      };
    }

    const modelsResult = await fetchAiModels(normalized, resolution.apiKey, checkedAt);
    const capabilityProbe = modelsResult.ok && normalized.model
      ? await probeAiOutputCapability({
          baseUrl: normalized.baseUrl,
          model: normalized.model,
          apiKey: resolution.apiKey,
          checkedAt
        })
      : undefined;
    const config: AiConnectionConfig = {
      petId: normalized.petId,
      providerName: normalized.providerName,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      models: normalized.models?.length ? normalized.models : existingConfig?.models ?? [],
      outputCapability: capabilityProbe?.capability,
      updatedAt: new Date().toISOString()
    };
    const test: AiConnectionTestResult = {
      ok: modelsResult.ok,
      message: modelsResult.ok
        ? `连接成功，设置已保存。${capabilityProbe ? ` ${getCapabilityMessage(capabilityProbe.capability)}` : ""}`
        : modelsResult.message,
      checkedAt: modelsResult.checkedAt,
      code: modelsResult.code
    };

    try {
      await runSettingsMutation(async () => {
        const latestSettings = (await readSettingsFile()).settings;

        // The bound secret was stored before networking. If the process stops
        // before metadata is replaced, the binding check makes the partial
        // update fail closed for a changed endpoint.
        latestSettings.connections[normalized.petId] = config;
        await writeSettingsFile(latestSettings);
      });
    } catch (error: unknown) {
      return {
        config: toUnsavedSummary(normalized),
        test: getSettingsFailure(error, checkedAt)
      };
    }

    return {
      config: {
        petId: config.petId,
        providerName: config.providerName,
        baseUrl: config.baseUrl,
        model: config.model,
        models: config.models ?? [],
        outputCapability: config.outputCapability,
        hasApiKey: true,
        updatedAt: config.updatedAt
      },
      test
    };
  });
}

export async function deleteAiConnection(petId: string): Promise<void> {
  const normalizedPetId = petId.trim();

  if (!normalizedPetId) {
    return;
  }

  await runPetMutation(normalizedPetId, async () => {
    await migrateLegacyAiConnections();
    await runSettingsMutation(async () => {
      const settings = (await readSettingsFile()).settings;
      await deleteSecureString(aiApiKeyScope, normalizedPetId);

      if (!(normalizedPetId in settings.connections)) {
        return;
      }

      delete settings.connections[normalizedPetId];
      await writeSettingsFile(settings);
    });
  });
}
