import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AiConnectionConfig,
  AiConnectionDraft,
  AiModelListResult,
  AiConnectionSaveResult,
  AiConnectionSummary,
  AiConnectionTestResult
} from "../../../shared/types/ai";

interface AiSettingsFile {
  connections: Record<string, AiConnectionConfig>;
}

const settingsFileName = "ai-connections.json";

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), settingsFileName);
}

function toSummary(config: AiConnectionConfig): AiConnectionSummary {
  return {
    petId: config.petId,
    providerName: config.providerName,
    baseUrl: config.baseUrl,
    model: config.model,
    models: config.models ?? [],
    hasApiKey: Boolean(config.apiKey),
    updatedAt: config.updatedAt
  };
}

function normalizeDraft(draft: AiConnectionDraft): AiConnectionDraft {
  return {
    petId: draft.petId.trim(),
    providerName: draft.providerName.trim() || "OpenAI Compatible",
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
    model: draft.model.trim(),
    apiKey: draft.apiKey.trim(),
    models: draft.models ?? []
  };
}

async function readSettings(): Promise<AiSettingsFile> {
  try {
    const content = await fs.readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(content) as AiSettingsFile;

    return {
      connections: parsed.connections ?? {}
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { connections: {} };
    }

    throw error;
  }
}

async function writeSettings(settings: AiSettingsFile): Promise<void> {
  const settingsPath = getSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
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

export async function listAiConnectionSummaries(): Promise<AiConnectionSummary[]> {
  const settings = await readSettings();

  return Object.values(settings.connections).map(toSummary);
}

export async function getAiConnectionSummary(
  petId: string
): Promise<AiConnectionSummary | undefined> {
  const settings = await readSettings();
  const config = settings.connections[petId];

  return config ? toSummary(config) : undefined;
}

export async function getAiConnectionConfig(
  petId: string
): Promise<AiConnectionConfig | undefined> {
  const settings = await readSettings();

  return settings.connections[petId];
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

export async function listAiModels(draft: AiConnectionDraft): Promise<AiModelListResult> {
  const normalized = normalizeDraft(draft);
  const settings = await readSettings();
  const existingConfig = settings.connections[normalized.petId];
  const apiKey = normalized.apiKey || existingConfig?.apiKey || "";
  const checkedAt = new Date().toISOString();

  if (!normalized.petId || !normalized.baseUrl || !apiKey) {
    return {
      ok: false,
      message: "请填写桌宠、Base URL 和 API Key。",
      checkedAt,
      models: []
    };
  }

  let response: Response;

  try {
    response = await fetch(buildModelsUrl(normalized.baseUrl), {
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

  const body = (await response.json()) as { data?: unknown[] };
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

export async function testAiConnection(draft: AiConnectionDraft): Promise<AiConnectionTestResult> {
  const modelsResult = await listAiModels(draft);

  return {
    ok: modelsResult.ok,
    message: modelsResult.ok ? "连接成功，设置已保存。" : modelsResult.message,
    checkedAt: modelsResult.checkedAt
  };
}

export async function saveAiConnection(
  draft: AiConnectionDraft
): Promise<AiConnectionSaveResult> {
  const normalized = normalizeDraft(draft);
  const settings = await readSettings();
  const existingConfig = settings.connections[normalized.petId];
  const config: AiConnectionConfig = {
    ...normalized,
    apiKey: normalized.apiKey || existingConfig?.apiKey || "",
    models: normalized.models?.length ? normalized.models : existingConfig?.models ?? [],
    updatedAt: new Date().toISOString()
  };
  const test = await testAiConnection(config);

  settings.connections[normalized.petId] = config;
  await writeSettings(settings);

  return {
    config: toSummary(config),
    test
  };
}

export async function deleteAiConnection(petId: string): Promise<void> {
  const settings = await readSettings();

  if (!(petId in settings.connections)) {
    return;
  }

  delete settings.connections[petId];
  await writeSettings(settings);
}
