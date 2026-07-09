import { createHash, createHmac } from "node:crypto";
import { app } from "electron";
import type { WebContents } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import type { PetDefinition } from "../../../shared/types/pet";
import type {
  SpeechStreamAudioChunk,
  SpeechStreamResultEvent,
  SpeechStreamStartRequest,
  SpeechStreamStartResult,
  SpeechStreamStopRequest,
  SpeechToTextRequest,
  SpeechToTextResponse
} from "../../../shared/types/speech";

interface TencentSpeechConfig {
  provider: "tencent";
  appId?: string;
  secretId: string;
  secretKey: string;
  region?: string;
  engineModelType?: string;
  sourceType?: number;
  voiceFormat?: SpeechToTextRequest["format"];
}

interface SpeechStreamSession {
  socket: WebSocket;
  webContents: WebContents;
  ended: boolean;
}

const configPath = path.resolve(process.cwd(), "config/speech.local.json");
const localPetFileName = "pet.local.json";
const service = "asr";
const host = "asr.tencentcloudapi.com";
const endpoint = `https://${host}`;
const action = "SentenceRecognition";
const version = "2019-06-14";
const realtimeHost = "asr.cloud.tencent.com";
const realtimePathPrefix = "/asr/v2";
const speechStreamSessions = new Map<string, SpeechStreamSession>();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacSha256(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function detectLanguageFromText(text: string): SpeechToTextResponse["language"] {
  const kanaCount = text.match(/[\u3040-\u30ff]/g)?.length ?? 0;
  const hanCount = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const latinCount = text.match(/[a-zA-Z]/g)?.length ?? 0;

  if (kanaCount > 0) {
    return "ja";
  }

  if (hanCount > 0 && hanCount >= latinCount) {
    return "zh";
  }

  if (latinCount > 0) {
    return "en";
  }

  return "unknown";
}

function getPetConfigPath(petId: string): string {
  return path.join(app.getPath("userData"), "pets", petId, localPetFileName);
}

async function readTencentSpeechConfig(petId?: string): Promise<TencentSpeechConfig> {
  if (petId) {
    try {
      const content = (await fs.readFile(getPetConfigPath(petId), "utf8")).replace(/^\uFEFF/, "");
      const parsed = JSON.parse(content) as PetDefinition;
      const settings = parsed.voiceInputSettings;

      if (
        settings?.provider === "tencent-asr" &&
        settings.connected &&
        settings.appId &&
        settings.secretId &&
        settings.secretKey
      ) {
        return {
          provider: "tencent",
          appId: settings.appId,
          secretId: settings.secretId,
          secretKey: settings.secretKey,
          region: "ap-guangzhou",
          engineModelType: "16k_zh",
          sourceType: 1,
          voiceFormat: "wav"
        };
      }
    } catch {
      // Fall through to legacy local config for older user setups.
    }
  }

  const content = (await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(content) as Partial<TencentSpeechConfig>;

  if (parsed.provider !== "tencent" || !parsed.secretId || !parsed.secretKey) {
    throw new Error("请在 config/speech.local.json 中填写腾讯云 SecretId 和 SecretKey。");
  }

  return {
    provider: "tencent",
    appId: parsed.appId,
    secretId: parsed.secretId,
    secretKey: parsed.secretKey,
    region: parsed.region || "ap-guangzhou",
    engineModelType: parsed.engineModelType || "16k_zh",
    sourceType: parsed.sourceType ?? 1,
    voiceFormat: parsed.voiceFormat || "wav"
  };
}

function signTencentRealtimeUrl(config: TencentSpeechConfig, sessionId: string): string {
  if (!config.appId) {
    throw new Error("实时语音识别需要填写腾讯云 AppID。");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const expired = timestamp + 24 * 60 * 60;
  const params = new URLSearchParams({
    secretid: config.secretId,
    timestamp: String(timestamp),
    expired: String(expired),
    nonce: String(Math.floor(Math.random() * 1000000000)),
    engine_model_type: config.engineModelType || "16k_zh",
    voice_format: "1",
    voice_id: sessionId,
    needvad: "1",
    filter_dirty: "0",
    filter_modal: "0",
    filter_punc: "0",
    convert_num_mode: "1",
    word_info: "0"
  });
  const sortedParams = Array.from(params.entries())
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const pathAndQuery = `${realtimePathPrefix}/${config.appId}?${sortedParams}`;
  const signSource = `${realtimeHost}${pathAndQuery}`;
  const signature = createHmac("sha1", config.secretKey).update(signSource, "utf8").digest("base64");

  return `wss://${signSource}&signature=${encodeURIComponent(signature)}`;
}

function sendStreamEvent(event: SpeechStreamResultEvent, target: WebContents): void {
  if (!target.isDestroyed()) {
    target.send("speech-stream:result", event);
  }
}

function normalizeRealtimeMessage(
  sessionId: string,
  rawMessage: string
): SpeechStreamResultEvent | undefined {
  const parsed = JSON.parse(rawMessage) as {
    code?: number;
    message?: string;
    result?: {
      voice_text_str?: string;
      slice_type?: 0 | 1 | 2;
      index?: number;
    };
    final?: number;
  };

  if (parsed.code && parsed.code !== 0) {
    return {
      sessionId,
      ok: false,
      message: parsed.message || "实时语音识别失败。",
      final: true
    };
  }

  const text = parsed.result?.voice_text_str?.trim();

  if (!text) {
    return undefined;
  }

  return {
    sessionId,
    ok: true,
    text,
    index: parsed.result?.index,
    sliceType: parsed.result?.slice_type,
    final: parsed.final === 1 || parsed.result?.slice_type === 2
  };
}

export async function startSpeechStream(
  webContents: WebContents,
  request: SpeechStreamStartRequest
): Promise<SpeechStreamStartResult> {
  let config: TencentSpeechConfig;

  try {
    config = await readTencentSpeechConfig(request.petId);
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "语音识别配置读取失败。"
    };
  }

  const sessionId = `desktop-pet-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let socket: WebSocket;

  try {
    socket = new WebSocket(signTencentRealtimeUrl(config, sessionId));
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "实时语音识别连接创建失败。"
    };
  }

  speechStreamSessions.set(sessionId, {
    socket,
    webContents,
    ended: false
  });

  socket.addEventListener("message", (event) => {
    try {
      const message =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      const normalized = normalizeRealtimeMessage(sessionId, message);

      if (normalized) {
        sendStreamEvent(normalized, webContents);
      }
    } catch {
      sendStreamEvent(
        {
          sessionId,
          ok: false,
          message: "实时语音识别结果解析失败。",
          final: true
        },
        webContents
      );
    }
  });

  socket.addEventListener("error", () => {
    if (speechStreamSessions.get(sessionId)?.ended) {
      return;
    }

    sendStreamEvent(
      {
        sessionId,
        ok: false,
        message: "实时语音识别连接异常。",
        final: true
      },
      webContents
    );
  });

  socket.addEventListener("close", () => {
    speechStreamSessions.delete(sessionId);
  });

  return await new Promise<SpeechStreamStartResult>((resolve) => {
    let settled = false;
    const settle = (result: SpeechStreamStartResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({
        ok: false,
        message: "实时语音识别连接超时。"
      });
      socket.close();
      speechStreamSessions.delete(sessionId);
    }, 8000);

    socket.addEventListener("message", (event) => {
      if (settled) {
        return;
      }

      try {
        const message =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        const parsed = JSON.parse(message) as { code?: number; message?: string };

        if (parsed.code === 0) {
          settle({
            ok: true,
            message: "实时语音识别已连接。",
            sessionId
          });
          return;
        }

        settle({
          ok: false,
          message: parsed.message || "实时语音识别握手失败。"
        });
        socket.close();
        speechStreamSessions.delete(sessionId);
      } catch {
        settle({
          ok: false,
          message: "实时语音识别握手结果解析失败。"
        });
        socket.close();
        speechStreamSessions.delete(sessionId);
      }
    });

    socket.addEventListener("error", () => {
      settle({
        ok: false,
        message: "实时语音识别连接异常。"
      });
    });

    socket.addEventListener("close", () => {
      settle({
        ok: false,
        message: "实时语音识别连接已关闭。"
      });
    });

  });
}

export function sendSpeechStreamAudio(chunk: SpeechStreamAudioChunk): void {
  const session = speechStreamSessions.get(chunk.sessionId);

  if (!session || session.ended || session.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  session.socket.send(Buffer.from(chunk.audio));
}

export function stopSpeechStream(request: SpeechStreamStopRequest): void {
  const session = speechStreamSessions.get(request.sessionId);

  if (!session || session.ended) {
    return;
  }

  session.ended = true;

  if (session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify({ type: "end" }));
  }

  setTimeout(() => {
    if (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING) {
      session.socket.close();
    }
  }, 8000);
}

function buildAuthorization(config: TencentSpeechConfig, payload: string, timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
    "content-type;host;x-tc-action",
    sha256(payload)
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest)
  ].join("\n");
  const secretDate = hmacSha256(`TC3${config.secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign, "utf8").digest("hex");

  return `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`;
}

export async function transcribeSpeech(
  request: SpeechToTextRequest
): Promise<SpeechToTextResponse> {
  const checkedAudio = request.audioBase64.trim();

  if (!checkedAudio) {
    return {
      ok: false,
      message: "没有收到录音内容。"
    };
  }

  let config: TencentSpeechConfig;

  try {
    config = await readTencentSpeechConfig(request.petId);
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "语音识别配置读取失败。"
    };
  }

  const payload = JSON.stringify({
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: config.engineModelType,
    SourceType: config.sourceType,
    VoiceFormat: request.format || config.voiceFormat,
    UsrAudioKey: `desktop-pet-${Date.now()}`,
    Data: checkedAudio
  });
  const timestamp = Math.floor(Date.now() / 1000);

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: buildAuthorization(config, payload, timestamp),
        "Content-Type": "application/json; charset=utf-8",
        Host: host,
        "X-TC-Action": action,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": version,
        "X-TC-Region": config.region ?? "ap-guangzhou"
      },
      body: payload
    });
  } catch {
    return {
      ok: false,
      message: "无法连接腾讯云语音识别服务。"
    };
  }

  const body = (await response.json()) as {
    Response?: {
      Result?: string;
      Error?: {
        Code?: string;
        Message?: string;
      };
    };
  };
  const error = body.Response?.Error;

  if (!response.ok || error) {
    return {
      ok: false,
      message: error?.Message ?? `语音识别失败，服务返回 ${response.status}。`
    };
  }

  const text = body.Response?.Result?.trim() ?? "";

  if (!text) {
    return {
      ok: false,
      message: "没有听清，请再说一次。"
    };
  }

  return {
    ok: true,
    message: "识别成功。",
    text,
    language: detectLanguageFromText(text)
  };
}
