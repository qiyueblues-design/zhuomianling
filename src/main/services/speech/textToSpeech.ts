import { app, type WebContents } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { PetDefinition } from "../../../shared/types/pet";
import { normalizeLegacyPetDefinition } from "../../../shared/validation/petDefinition";
import { resolveLegacyVoiceModelPaths } from "../config/legacyVoiceModelPath";
import type {
  TextToSpeechRequest,
  TextToSpeechResponse,
  TextToSpeechStopRequest,
  TextToSpeechStopResponse
} from "../../../shared/types/speech";
import {
  VoiceResourceValidationError,
  sanitizeVoiceDiagnosticText,
  toUserFacingGptSoVitsError,
  validateReadableVoiceFile
} from "./voiceResourceValidation";

interface GptSoVitsPetConfig {
  baseUrl: string;
  apiMode?: "v2" | "beta";
  refAudioPath: string;
  promptText: string;
  promptLang?: string;
  textLang?: string;
  textSplitMethod?: string;
  mediaType?: "wav" | "mp3" | "ogg" | "aac";
}

interface GptSoVitsConfig {
  provider: "gpt-sovits";
  pets: Record<string, GptSoVitsPetConfig | undefined>;
}

interface GptSoVitsErrorBody {
  message?: unknown;
  detail?: unknown;
  error?: unknown;
}

const configPath = path.resolve(process.cwd(), "config/tts.local.json");
const localPetFileName = "pet.local.json";
const localGptSoVitsBaseUrl = "http://127.0.0.1:9880";
const textToSpeechTimeoutMs = 45_000;
const maximumGptSoVitsErrorBodyChars = 16_000;
const warmupControllers = new Map<string, AbortController>();

type TextToSpeechAbortReason = "renderer" | "owner-destroyed" | "replaced" | "timeout";

interface TextToSpeechRequestEntry {
  target: WebContents;
  key: string;
  requestId: string;
  petId: string;
  controller: AbortController;
  active: boolean;
  timeout?: NodeJS.Timeout;
}

interface TextToSpeechOwnerState {
  requests: Map<string, TextToSpeechRequestEntry>;
  ownerGoneListener: () => void;
}

const textToSpeechOwners = new WeakMap<WebContents, TextToSpeechOwnerState>();

function getTextToSpeechRequestKey(petId: string, requestId: string): string {
  return JSON.stringify([petId, requestId]);
}

function getAbortResponse(signal: AbortSignal, requestId: string): TextToSpeechResponse {
  const timedOut = signal.reason === "timeout";

  return {
    ok: false,
    requestId,
    code: timedOut ? "TIMEOUT" : "CANCELED",
    message: timedOut ? "语音生成超时，请检查本地服务后重试。" : "语音生成已取消。"
  };
}

function detachTextToSpeechEntry(
  entry: TextToSpeechRequestEntry,
  abortReason?: TextToSpeechAbortReason
): boolean {
  if (!entry.active) {
    return false;
  }

  entry.active = false;
  clearTimeout(entry.timeout);
  entry.timeout = undefined;

  const ownerState = textToSpeechOwners.get(entry.target);
  ownerState?.requests.delete(entry.key);

  if (ownerState && ownerState.requests.size === 0) {
    entry.target.removeListener("render-process-gone", ownerState.ownerGoneListener);
    entry.target.removeListener("destroyed", ownerState.ownerGoneListener);
    textToSpeechOwners.delete(entry.target);
  }

  if (abortReason && !entry.controller.signal.aborted) {
    entry.controller.abort(abortReason);
  }

  return true;
}

function getOrCreateTextToSpeechOwnerState(target: WebContents): TextToSpeechOwnerState {
  const existingState = textToSpeechOwners.get(target);

  if (existingState) {
    return existingState;
  }

  const ownerState: TextToSpeechOwnerState = {
    requests: new Map(),
    ownerGoneListener: () => {
      for (const entry of [...ownerState.requests.values()]) {
        detachTextToSpeechEntry(entry, "owner-destroyed");
      }
    }
  };
  textToSpeechOwners.set(target, ownerState);
  target.on("render-process-gone", ownerState.ownerGoneListener);
  target.once("destroyed", ownerState.ownerGoneListener);

  return ownerState;
}

function createTextToSpeechEntry(
  target: WebContents,
  request: TextToSpeechRequest,
  timeoutMs: number
): TextToSpeechRequestEntry {
  const currentOwnerState = getOrCreateTextToSpeechOwnerState(target);
  const requestKey = getTextToSpeechRequestKey(request.petId, request.requestId);
  const existingEntry = currentOwnerState.requests.get(requestKey);

  if (existingEntry) {
    detachTextToSpeechEntry(existingEntry, "replaced");
  }

  const ownerState = getOrCreateTextToSpeechOwnerState(target);
  const entry: TextToSpeechRequestEntry = {
    target,
    key: requestKey,
    requestId: request.requestId,
    petId: request.petId,
    controller: new AbortController(),
    active: true
  };
  ownerState.requests.set(requestKey, entry);
  entry.timeout = setTimeout(() => {
    detachTextToSpeechEntry(entry, "timeout");
  }, timeoutMs);

  return entry;
}

function buildTtsUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/tts`;
  return url.toString();
}

function buildBetaTtsUrl(baseUrl: string): string {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function getMimeType(mediaType: string): string {
  switch (mediaType) {
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "wav":
    default:
      return "audio/wav";
  }
}

function getWarmupText(language: string): string {
  switch (language) {
    case "ja":
      return "うん。";
    case "en":
      return "Mm.";
    case "zh":
    default:
      return "嗯。";
  }
}

function getPetConfigPath(petId: string): string {
  return path.join(app.getPath("userData"), "pets", petId, localPetFileName);
}

async function readLocalPetVoiceConfig(petId: string): Promise<Required<GptSoVitsPetConfig> | undefined> {
  try {
    const content = await fs.readFile(getPetConfigPath(petId), "utf8");
    let pet = normalizeLegacyPetDefinition(JSON.parse(content) as PetDefinition);
    let settings = pet.voiceModelSettings;

    if (!settings?.enabled || !settings.connected) {
      return undefined;
    }

    pet = (await resolveLegacyVoiceModelPaths(pet)).pet;
    settings = pet.voiceModelSettings;

    if (!settings?.referenceAudioPath || !settings.referenceText?.trim()) {
      throw new Error("请先在声音模型页选择参考音频并填写参考文本。");
    }

    return {
      baseUrl: localGptSoVitsBaseUrl,
      apiMode: "v2",
      refAudioPath: settings.referenceAudioPath,
      promptText: settings.referenceText,
      promptLang: settings.referenceLanguage ?? settings.language,
      textLang: settings.language,
      textSplitMethod: "cut5",
      mediaType: "wav"
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function readTextToSpeechConfig(): Promise<GptSoVitsConfig> {
  const content = (await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(content) as Partial<GptSoVitsConfig>;

  if (parsed.provider !== "gpt-sovits" || !parsed.pets) {
    throw new Error("请在 config/tts.local.json 中填写 GPT-SoVITS 本地配置。");
  }

  return {
    provider: "gpt-sovits",
    pets: parsed.pets
  };
}

function normalizePetConfig(
  petId: string,
  config: GptSoVitsConfig
): Required<GptSoVitsPetConfig> {
  const petConfig = config.pets[petId];

  if (!petConfig) {
    throw new Error(`config/tts.local.json 中缺少 ${petId} 的 GPT-SoVITS 配置。`);
  }

  if (!petConfig.baseUrl || !petConfig.refAudioPath || !petConfig.promptText) {
    throw new Error(`请补全 ${petId} 的 baseUrl、refAudioPath 和 promptText。`);
  }

  return {
    baseUrl: petConfig.baseUrl.trim().replace(/\/+$/, ""),
    apiMode: petConfig.apiMode || "v2",
    refAudioPath: petConfig.refAudioPath,
    promptText: petConfig.promptText,
    promptLang: petConfig.promptLang || "ja",
    textLang: petConfig.textLang || "ja",
    textSplitMethod: petConfig.textSplitMethod || "cut5",
    mediaType: petConfig.mediaType || "wav"
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  let rawBody = "";

  try {
    rawBody = (await response.text()).slice(0, maximumGptSoVitsErrorBodyChars);
  } catch {
    return `GPT-SoVITS 请求失败，状态码 ${response.status}。`;
  }

  let detail: unknown = rawBody;

  try {
    const body = JSON.parse(rawBody) as GptSoVitsErrorBody;
    detail = body.message ?? body.detail ?? body.error ?? rawBody;
  } catch {
    // Non-JSON error bodies are handled as plain text below.
  }

  if (typeof detail === "string") {
    return toUserFacingGptSoVitsError(detail, response.status);
  }

  if (detail !== undefined) {
    try {
      const serialized = JSON.stringify(detail);
      if (serialized && serialized !== "{}" && serialized !== "[]") {
        return toUserFacingGptSoVitsError(serialized, response.status);
      }
    } catch {
      // Fall through to the bounded status-based message below.
    }
  }

  return `GPT-SoVITS 请求失败，状态码 ${response.status}。`;
}

function toVoiceConfigurationMessage(error: unknown): string {
  if (error instanceof VoiceResourceValidationError) {
    return error.message;
  }

  const rawMessage = error instanceof Error ? error.message : "";
  if (/ENOENT|no such file or directory/i.test(rawMessage)) {
    return "未找到声音模型配置，请回到声音模型页重新保存并连接。";
  }

  return sanitizeVoiceDiagnosticText(rawMessage, 600) || "读取 GPT-SoVITS 配置失败。";
}

async function synthesizeText(
  request: TextToSpeechRequest,
  options?: { abortWarmup?: boolean; signal?: AbortSignal }
): Promise<TextToSpeechResponse> {
  const text = request.text.trim();
  const petId = request.petId.trim();
  const requestId = request.requestId;

  if (options?.signal?.aborted) {
    return getAbortResponse(options.signal, requestId);
  }

  if (!text) {
    return {
      ok: false,
      requestId,
      message: "没有可朗读的语音文本。"
    };
  }

  if (!petId) {
    return {
      ok: false,
      requestId,
      message: "缺少桌宠 ID。"
    };
  }

  if (options?.abortWarmup ?? true) {
    const warmupController = warmupControllers.get(petId);

    if (warmupController) {
      warmupController.abort();
      warmupControllers.delete(petId);
    }
  }

  let petConfig: Required<GptSoVitsPetConfig>;

  try {
    petConfig =
      (await readLocalPetVoiceConfig(petId)) ??
      normalizePetConfig(petId, await readTextToSpeechConfig());
  } catch (error) {
    if (options?.signal?.aborted) {
      return getAbortResponse(options.signal, requestId);
    }

    return {
      ok: false,
      requestId,
      code: "INVALID_CONFIG",
      message: toVoiceConfigurationMessage(error)
    };
  }

  if (options?.signal?.aborted) {
    return getAbortResponse(options.signal, requestId);
  }

  try {
    await validateReadableVoiceFile(petConfig.refAudioPath, "referenceAudio");
  } catch (error) {
    if (options?.signal?.aborted) {
      return getAbortResponse(options.signal, requestId);
    }

    return {
      ok: false,
      requestId,
      code: "INVALID_CONFIG",
      message: toVoiceConfigurationMessage(error)
    };
  }

  let response: Response;

  try {
    response = await fetch(
      petConfig.apiMode === "beta" ? buildBetaTtsUrl(petConfig.baseUrl) : buildTtsUrl(petConfig.baseUrl),
      {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: getMimeType(petConfig.mediaType)
      },
      signal: options?.signal,
      body: JSON.stringify({
        ...(petConfig.apiMode === "beta"
          ? {
              text,
              text_language: petConfig.textLang,
              refer_wav_path: petConfig.refAudioPath,
              prompt_text: petConfig.promptText,
              prompt_language: petConfig.promptLang
            }
          : {
              text,
              text_lang: petConfig.textLang,
              ref_audio_path: petConfig.refAudioPath,
              prompt_text: petConfig.promptText,
              prompt_lang: petConfig.promptLang,
              text_split_method: petConfig.textSplitMethod,
              media_type: petConfig.mediaType,
              streaming_mode: false
            })
      })
      }
    );
  } catch {
    if (options?.signal?.aborted) {
      return getAbortResponse(options.signal, requestId);
    }

    return {
      ok: false,
      requestId,
      message: "无法连接 GPT-SoVITS，请确认本地服务已启动。"
    };
  }

  if (!response.ok) {
    const message = await readErrorMessage(response);

    if (options?.signal?.aborted) {
      return getAbortResponse(options.signal, requestId);
    }

    return {
      ok: false,
      requestId,
      message
    };
  }

  let audioBuffer: Buffer;

  try {
    audioBuffer = Buffer.from(await response.arrayBuffer());
  } catch {
    if (options?.signal?.aborted) {
      return getAbortResponse(options.signal, requestId);
    }

    return {
      ok: false,
      requestId,
      message: "读取 GPT-SoVITS 音频失败，请稍后再试。"
    };
  }

  if (options?.signal?.aborted) {
    return getAbortResponse(options.signal, requestId);
  }

  if (!audioBuffer.length) {
    return {
      ok: false,
      requestId,
      message: "GPT-SoVITS 没有返回音频。"
    };
  }

  return {
    ok: true,
    message: "ok",
    requestId,
    audioBase64: audioBuffer.toString("base64"),
    mimeType: response.headers.get("content-type") || getMimeType(petConfig.mediaType)
  };
}

export async function speakText(
  target: WebContents,
  request: TextToSpeechRequest,
  timeoutMs = textToSpeechTimeoutMs
): Promise<TextToSpeechResponse> {
  const entry = createTextToSpeechEntry(target, request, timeoutMs);

  try {
    return await synthesizeText(request, {
      signal: entry.controller.signal
    });
  } finally {
    detachTextToSpeechEntry(entry);
  }
}

export async function warmUpTextToSpeech(petId: string): Promise<void> {
  const normalizedPetId = petId.trim();

  if (!normalizedPetId || warmupControllers.has(normalizedPetId)) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort("timeout");
  }, textToSpeechTimeoutMs);
  warmupControllers.set(normalizedPetId, controller);

  try {
    const petConfig =
      (await readLocalPetVoiceConfig(normalizedPetId)) ??
      normalizePetConfig(normalizedPetId, await readTextToSpeechConfig());

    await synthesizeText(
      {
        petId: normalizedPetId,
        text: getWarmupText(petConfig.textLang),
        requestId: `warmup-${normalizedPetId}-${Date.now()}`
      },
      {
        abortWarmup: false,
        signal: controller.signal
      }
    );
  } catch {
    // Prewarming is best-effort; normal TTS errors are reported when the user actually plays speech.
  } finally {
    clearTimeout(timeout);

    if (warmupControllers.get(normalizedPetId) === controller) {
      warmupControllers.delete(normalizedPetId);
    }
  }
}

export function stopSpeechPlayback(
  target: WebContents,
  request: TextToSpeechStopRequest = {}
): TextToSpeechStopResponse {
  const ownerState = textToSpeechOwners.get(target);
  const affectedPetIds = new Set<string>();
  let canceled = 0;

  for (const entry of [...(ownerState?.requests.values() ?? [])]) {
    if (request.petId && entry.petId !== request.petId) {
      continue;
    }

    if (request.requestId && entry.requestId !== request.requestId) {
      continue;
    }

    affectedPetIds.add(entry.petId);
    canceled += Number(detachTextToSpeechEntry(entry, "renderer"));
  }

  if (request.petId) {
    affectedPetIds.add(request.petId);
  }

  for (const petId of affectedPetIds) {
    const warmupController = warmupControllers.get(petId);

    if (warmupController) {
      warmupController.abort("renderer");
      warmupControllers.delete(petId);
      canceled += 1;
    }
  }

  return {
    ok: true,
    message: "ok",
    canceled
  };
}
