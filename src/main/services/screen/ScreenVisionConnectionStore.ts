import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAiBaseUrl } from "../../../shared/types/ai";
import type {
  ScreenVisionConnectionDraft,
  ScreenVisionConnectionSummary,
  ScreenVisionProviderProtocol,
  VisionCapability,
  VisionCapabilityFingerprint
} from "../../../shared/types/screen";
import { assertValidPetId } from "../../../shared/validation/petId";
import { writeJsonFileAtomically } from "../config/durableJsonFile";
import { withPetConfigWriteLock } from "../config/petConfigWriteQueue";
import {
  deleteSecureString,
  getSecureString,
  setSecureString,
  type SecureStorageCorruptedError,
  type SecureStorageUnavailableError
} from "../config/secureConfigStore";

const settingsFileName = "screen-vision-connections.json";
const secretScope = "screen-vision-api-key";

interface StoredIndependentConnection {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  models: Array<{ id: string; name: string }>;
  capability?: VisionCapability;
  updatedAt: string;
}

interface StoredScreenVisionPet {
  chatCapability?: VisionCapability;
  independent?: StoredIndependentConnection;
}

interface ScreenVisionSettingsFile {
  version: 1;
  pets: Record<string, StoredScreenVisionPet>;
}

export type ScreenVisionStorageError = SecureStorageCorruptedError | SecureStorageUnavailableError;

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), settingsFileName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeModels(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return [];
  const models: Array<{ id: string; name: string }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    const id = item.id.trim().slice(0, 512);
    if (models.some((model) => model.id === id)) continue;
    models.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 512) : id
    });
  }
  return models.slice(0, 512);
}

function normalizeFingerprint(value: unknown): VisionCapabilityFingerprint | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.normalizedBaseUrl !== "string" ||
    typeof value.model !== "string" ||
    (value.providerProtocol !== "openai-compatible" && value.providerProtocol !== "gemini-native") ||
    (value.visionInputFormat !== "image_url-data-url" && value.visionInputFormat !== "inline_data") ||
    value.probeVersion !== 1
  ) return undefined;
  return {
    normalizedBaseUrl: normalizeAiBaseUrl(value.normalizedBaseUrl),
    model: value.model.trim().slice(0, 512),
    providerProtocol: value.providerProtocol,
    visionInputFormat: value.visionInputFormat,
    probeVersion: 1
  };
}

function normalizeCapability(value: unknown): VisionCapability | undefined {
  if (!isRecord(value)) return undefined;
  if (value.visionInput !== "tested" && value.visionInput !== "unsupported" && value.visionInput !== "unknown") return undefined;
  if (typeof value.checkedAt !== "string" || value.probeVersion !== 1) return undefined;
  const fingerprint = normalizeFingerprint(value.fingerprint);
  if (!fingerprint) return undefined;
  return { visionInput: value.visionInput, checkedAt: value.checkedAt, fingerprint, probeVersion: 1 };
}

function normalizeIndependent(value: unknown, petId: string): StoredIndependentConnection | undefined {
  if (!isRecord(value) || typeof value.baseUrl !== "string" || typeof value.model !== "string") return undefined;
  const baseUrl = normalizeAiBaseUrl(value.baseUrl);
  const model = value.model.trim();
  if (!baseUrl || !model) return undefined;
  return {
    petId,
    providerName: typeof value.providerName === "string" && value.providerName.trim() ? value.providerName.trim().slice(0, 128) : "OpenAI Compatible",
    baseUrl,
    model,
    models: normalizeModels(value.models),
    capability: normalizeCapability(value.capability),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
}

function parseSettings(value: unknown): ScreenVisionSettingsFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.pets)) {
    throw new Error("视觉连接配置损坏，请明确恢复或重新配置。 ");
  }
  const pets: Record<string, StoredScreenVisionPet> = {};
  for (const [petId, rawPet] of Object.entries(value.pets)) {
    if (!isRecord(rawPet)) continue;
    const normalizedPet: StoredScreenVisionPet = {};
    const chatCapability = normalizeCapability(rawPet.chatCapability);
    if (chatCapability) normalizedPet.chatCapability = chatCapability;
    const independent = normalizeIndependent(rawPet.independent, petId);
    if (independent) normalizedPet.independent = independent;
    pets[petId] = normalizedPet;
  }
  return { version: 1, pets };
}

async function readSettings(): Promise<ScreenVisionSettingsFile> {
  try {
    return parseSettings(JSON.parse(await fs.readFile(getSettingsPath(), "utf8")) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, pets: {} };
    throw error;
  }
}

let mutationQueue: Promise<void> = Promise.resolve();
function runSettingsMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(mutation, mutation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function getVisionProviderProtocol(baseUrl: string, providerName = ""): ScreenVisionProviderProtocol {
  try {
    const url = new URL(normalizeAiBaseUrl(baseUrl));
    if (url.hostname.toLowerCase() === "generativelanguage.googleapis.com" && !url.pathname.includes("/openai")) {
      return "gemini-native";
    }
  } catch {
    // Invalid drafts are rejected by the caller before a network request.
  }
  return /gemini/i.test(providerName) && !normalizeAiBaseUrl(baseUrl).includes("/openai")
    ? "gemini-native"
    : "openai-compatible";
}

export function createVisionCapabilityFingerprint(
  baseUrl: string,
  model: string,
  providerName = ""
): VisionCapabilityFingerprint {
  const providerProtocol = getVisionProviderProtocol(baseUrl, providerName);
  return {
    normalizedBaseUrl: normalizeAiBaseUrl(baseUrl),
    model: model.trim(),
    providerProtocol,
    visionInputFormat: providerProtocol === "gemini-native" ? "inline_data" : "image_url-data-url",
    probeVersion: 1
  };
}

export function isVisionCapabilityCurrent(
  capability: VisionCapability | undefined,
  baseUrl: string,
  model: string,
  providerName = ""
): boolean {
  if (!capability || capability.probeVersion !== 1) return false;
  const expected = createVisionCapabilityFingerprint(baseUrl, model, providerName);
  return JSON.stringify(capability.fingerprint) === JSON.stringify(expected);
}

async function getPetRecord(petIdValue: string): Promise<StoredScreenVisionPet> {
  const petId = assertValidPetId(petIdValue);
  const settings = await readSettings();
  return settings.pets[petId] ?? {};
}

export async function getChatVisionCapability(petId: string): Promise<VisionCapability | undefined> {
  return (await getPetRecord(petId)).chatCapability;
}

/** Caller must hold the pet configuration write lock. */
export async function saveChatVisionCapabilityWhilePetConfigLocked(
  petIdValue: string,
  capability: VisionCapability
): Promise<void> {
  const petId = assertValidPetId(petIdValue);
  await runSettingsMutation(async () => {
    const settings = await readSettings();
    settings.pets[petId] = { ...(settings.pets[petId] ?? {}), chatCapability: capability };
    await writeJsonFileAtomically(getSettingsPath(), settings);
  });
}

export async function saveChatVisionCapability(petIdValue: string, capability: VisionCapability): Promise<void> {
  const petId = assertValidPetId(petIdValue);
  await withPetConfigWriteLock(petId, () => saveChatVisionCapabilityWhilePetConfigLocked(petId, capability));
}

/** Caller must hold the pet configuration write lock. */
export async function clearChatVisionCapabilityWhilePetConfigLocked(petIdValue: string): Promise<void> {
  const petId = assertValidPetId(petIdValue);
  await runSettingsMutation(async () => {
    const settings = await readSettings();
    const pet = settings.pets[petId];
    if (!pet?.chatCapability) return;
    delete pet.chatCapability;
    await writeJsonFileAtomically(getSettingsPath(), settings);
  });
}

export async function clearChatVisionCapability(petIdValue: string): Promise<void> {
  const petId = assertValidPetId(petIdValue);
  await withPetConfigWriteLock(petId, () => clearChatVisionCapabilityWhilePetConfigLocked(petId));
}

export async function getIndependentVisionSummary(petIdValue: string): Promise<ScreenVisionConnectionSummary | undefined> {
  const petId = assertValidPetId(petIdValue);
  const record = (await getPetRecord(petId)).independent;
  if (!record) return undefined;
  const apiKey = await getSecureString(secretScope, petId, record.baseUrl);
  return {
    petId,
    providerName: record.providerName,
    baseUrl: record.baseUrl,
    model: record.model,
    models: record.models,
    hasApiKey: Boolean(apiKey),
    capability: record.capability,
    updatedAt: record.updatedAt
  };
}

export async function getIndependentVisionConfig(petIdValue: string): Promise<(StoredIndependentConnection & { apiKey: string }) | undefined> {
  const petId = assertValidPetId(petIdValue);
  const record = (await getPetRecord(petId)).independent;
  if (!record) return undefined;
  return { ...record, apiKey: (await getSecureString(secretScope, petId, record.baseUrl)) ?? "" };
}

export async function resolveIndependentVisionApiKey(
  draftValue: Pick<ScreenVisionConnectionDraft, "petId" | "baseUrl" | "apiKey">
): Promise<{ apiKey?: string; endpointChanged: boolean }> {
  const petId = assertValidPetId(draftValue.petId);
  const baseUrl = normalizeAiBaseUrl(draftValue.baseUrl);
  const suppliedKey = draftValue.apiKey.trim();
  if (suppliedKey) return { apiKey: suppliedKey, endpointChanged: false };

  const previous = (await getPetRecord(petId)).independent;
  const endpointChanged = Boolean(previous && previous.baseUrl !== baseUrl);
  if (!previous || endpointChanged) return { endpointChanged };

  return {
    apiKey: await getSecureString(secretScope, petId, previous.baseUrl),
    endpointChanged: false
  };
}

export async function saveIndependentVisionConnection(
  draftValue: ScreenVisionConnectionDraft,
  capability: VisionCapability
): Promise<ScreenVisionConnectionSummary> {
  const petId = assertValidPetId(draftValue.petId);
  const baseUrl = normalizeAiBaseUrl(draftValue.baseUrl);
  const model = draftValue.model.trim();
  const providerName = draftValue.providerName.trim() || "OpenAI Compatible";
  const resolution = await resolveIndependentVisionApiKey(draftValue);
  const resolvedApiKey = resolution.apiKey;
  if (!baseUrl || !model || !resolvedApiKey) throw new Error("请填写独立视觉模型的连接信息。 ");
  if (!isVisionCapabilityCurrent(capability, baseUrl, model, providerName) || capability.visionInput !== "tested") {
    throw new Error("请先完成当前独立视觉模型的图片理解测试。 ");
  }

  return withPetConfigWriteLock(petId, () => runSettingsMutation(async () => {
    const settings = await readSettings();
    const previous = settings.pets[petId]?.independent;
    const previousKey = previous ? await getSecureString(secretScope, petId, previous.baseUrl) : undefined;
    await setSecureString(secretScope, petId, resolvedApiKey, baseUrl);
    const next: StoredIndependentConnection = {
      petId,
      providerName,
      baseUrl,
      model,
      models: normalizeModels(draftValue.models),
      capability,
      updatedAt: new Date().toISOString()
    };
    try {
      settings.pets[petId] = { ...(settings.pets[petId] ?? {}), independent: next };
      await writeJsonFileAtomically(getSettingsPath(), settings);
    } catch (error) {
      if (previousKey && previous) await setSecureString(secretScope, petId, previousKey, previous.baseUrl);
      else await deleteSecureString(secretScope, petId);
      throw error;
    }
    return {
      ...next,
      hasApiKey: true
    };
  }));
}

/** Caller must hold the pet configuration write lock. */
export async function deleteScreenVisionConnectionWhilePetConfigLocked(petIdValue: string): Promise<void> {
  const petId = assertValidPetId(petIdValue);
  await runSettingsMutation(async () => {
    const settings = await readSettings();
    if (settings.pets[petId]) {
      delete settings.pets[petId];
      await writeJsonFileAtomically(getSettingsPath(), settings);
    }
    await deleteSecureString(secretScope, petId);
  });
}

export async function deleteScreenVisionConnection(petIdValue: string): Promise<void> {
  const petId = assertValidPetId(petIdValue);
  await withPetConfigWriteLock(petId, () => deleteScreenVisionConnectionWhilePetConfigLocked(petId));
}
