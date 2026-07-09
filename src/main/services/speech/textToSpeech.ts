import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { PetDefinition } from "../../../shared/types/pet";
import type { TextToSpeechRequest, TextToSpeechResponse } from "../../../shared/types/speech";

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
  message?: string;
  detail?: string;
  error?: string;
}

const configPath = path.resolve(process.cwd(), "config/tts.local.json");
const localPetFileName = "pet.local.json";
const localGptSoVitsBaseUrl = "http://127.0.0.1:9880";
const warmupControllers = new Map<string, AbortController>();

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
    const pet = JSON.parse(content) as PetDefinition;
    const settings = pet.voiceModelSettings;

    if (!settings?.enabled || !settings.connected) {
      return undefined;
    }

    if (!settings.referenceAudioPath || !settings.referenceText.trim()) {
      throw new Error("请先在声音模型页选择参考音频并填写参考文本。");
    }

    return {
      baseUrl: localGptSoVitsBaseUrl,
      apiMode: "v2",
      refAudioPath: settings.referenceAudioPath,
      promptText: settings.referenceText,
      promptLang: settings.language,
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
  try {
    const body = (await response.json()) as GptSoVitsErrorBody;
    return body.message ?? body.detail ?? body.error ?? `GPT-SoVITS 请求失败，状态码 ${response.status}。`;
  } catch {
    return `GPT-SoVITS 请求失败，状态码 ${response.status}。`;
  }
}

async function synthesizeText(
  request: TextToSpeechRequest,
  options?: { abortWarmup?: boolean; signal?: AbortSignal }
): Promise<TextToSpeechResponse> {
  const text = request.text.trim();
  const petId = request.petId.trim();

  if (!text) {
    return {
      ok: false,
      message: "没有可朗读的语音文本。"
    };
  }

  if (!petId) {
    return {
      ok: false,
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
    return {
      ok: false,
      message: error instanceof Error ? error.message : "读取 GPT-SoVITS 配置失败。"
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
    return {
      ok: false,
      message: "无法连接 GPT-SoVITS，请确认本地服务已启动。"
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: await readErrorMessage(response)
    };
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  if (!audioBuffer.length) {
    return {
      ok: false,
      message: "GPT-SoVITS 没有返回音频。"
    };
  }

  return {
    ok: true,
    message: "ok",
    audioBase64: audioBuffer.toString("base64"),
    mimeType: response.headers.get("content-type") || getMimeType(petConfig.mediaType)
  };
}

export async function speakText(request: TextToSpeechRequest): Promise<TextToSpeechResponse> {
  return synthesizeText(request);
}

export async function warmUpTextToSpeech(petId: string): Promise<void> {
  const normalizedPetId = petId.trim();

  if (!normalizedPetId || warmupControllers.has(normalizedPetId)) {
    return;
  }

  const controller = new AbortController();
  warmupControllers.set(normalizedPetId, controller);

  try {
    const petConfig =
      (await readLocalPetVoiceConfig(normalizedPetId)) ??
      normalizePetConfig(normalizedPetId, await readTextToSpeechConfig());

    await synthesizeText(
      {
        petId: normalizedPetId,
        text: getWarmupText(petConfig.textLang)
      },
      {
        abortWarmup: false,
        signal: controller.signal
      }
    );
  } catch {
    // Prewarming is best-effort; normal TTS errors are reported when the user actually plays speech.
  } finally {
    if (warmupControllers.get(normalizedPetId) === controller) {
      warmupControllers.delete(normalizedPetId);
    }
  }
}

export function stopSpeechPlayback(): { ok: boolean; message: string } {
  return {
    ok: true,
    message: "ok"
  };
}
