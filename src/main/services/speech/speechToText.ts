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
import { getSecureString, setSecureString } from "../config/secureConfigStore";

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
  closeTimer?: ReturnType<typeof setTimeout>;
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
const startingSpeechStreamOwners = new Map<string, WebContents>();
const cancelledSpeechStreamStarts = new Set<string>();
const pendingSpeechStreamCancels = new Map<string, ReturnType<typeof setTimeout>>();
const boundSpeechStreamOwners = new WeakSet<WebContents>();
const tencentAsrSecretScope = "tencent-asr";
const speechStreamPendingCancelTtlMs = 15_000;
const speechStreamPendingCancelLimit = 256;
const speechStreamSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

interface TencentAsrCredentials {
  appId: string;
  secretId: string;
  secretKey: string;
}

export function isValidSpeechStreamSessionId(value: unknown): value is string {
  return typeof value === "string" && speechStreamSessionIdPattern.test(value);
}

function clearPendingSpeechStreamCancel(sessionId: string): boolean {
  const timer = pendingSpeechStreamCancels.get(sessionId);

  if (!timer) {
    return false;
  }

  clearTimeout(timer);
  pendingSpeechStreamCancels.delete(sessionId);
  return true;
}

function rememberPendingSpeechStreamCancel(sessionId: string): void {
  if (!isValidSpeechStreamSessionId(sessionId)) {
    return;
  }

  clearPendingSpeechStreamCancel(sessionId);

  while (pendingSpeechStreamCancels.size >= speechStreamPendingCancelLimit) {
    const oldestSessionId = pendingSpeechStreamCancels.keys().next().value as string | undefined;

    if (!oldestSessionId) {
      break;
    }

    clearPendingSpeechStreamCancel(oldestSessionId);
  }

  const timer = setTimeout(() => {
    if (pendingSpeechStreamCancels.get(sessionId) === timer) {
      pendingSpeechStreamCancels.delete(sessionId);
    }
  }, speechStreamPendingCancelTtlMs);
  timer.unref();
  pendingSpeechStreamCancels.set(sessionId, timer);
}

function isSpeechStreamStartCancelled(sessionId: string, webContents: WebContents): boolean {
  return (
    webContents.isDestroyed() ||
    cancelledSpeechStreamStarts.has(sessionId) ||
    clearPendingSpeechStreamCancel(sessionId)
  );
}

function closeSocketImmediately(socket: WebSocket): void {
  if (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    socket.close();
  } catch {
    // A socket can race from CONNECTING to CLOSED between the state check and close.
  }
}

function closeSpeechStreamSessionImmediately(
  sessionId: string,
  session: SpeechStreamSession
): void {
  session.ended = true;

  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
    session.closeTimer = undefined;
  }

  if (speechStreamSessions.get(sessionId) === session) {
    speechStreamSessions.delete(sessionId);
  }

  closeSocketImmediately(session.socket);
}

function closeSpeechStreamsForOwner(webContents: WebContents): void {
  for (const [sessionId, owner] of startingSpeechStreamOwners) {
    if (owner === webContents) {
      cancelledSpeechStreamStarts.add(sessionId);
    }
  }

  for (const [sessionId, session] of speechStreamSessions) {
    if (session.webContents === webContents) {
      closeSpeechStreamSessionImmediately(sessionId, session);
    }
  }
}

function bindSpeechStreamOwner(webContents: WebContents): void {
  if (boundSpeechStreamOwners.has(webContents)) {
    return;
  }

  boundSpeechStreamOwners.add(webContents);
  const cleanup = (): void => {
    closeSpeechStreamsForOwner(webContents);
  };
  webContents.on("render-process-gone", cleanup);
  webContents.once("destroyed", cleanup);
}

function cancelledSpeechStreamStartResult(): SpeechStreamStartResult {
  return {
    ok: false,
    message: "实时语音识别连接已取消。"
  };
}

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
  const targetPetId = petId.trim();

  if (!targetPetId || targetPetId === "." || targetPetId === ".." || /[\\/\0]/.test(targetPetId)) {
    throw new Error("无效的桌宠 ID。");
  }

  const petsRootPath = path.resolve(app.getPath("userData"), "pets");
  const petDirectoryPath = path.resolve(petsRootPath, targetPetId);
  const relativePath = path.relative(petsRootPath, petDirectoryPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("无效的桌宠配置路径。");
  }

  return path.join(petDirectoryPath, localPetFileName);
}

function parseTencentAsrCredentials(value: string | undefined): TencentAsrCredentials | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<TencentAsrCredentials>;
    const appId = typeof parsed.appId === "string" ? parsed.appId.trim() : "";
    const secretId = typeof parsed.secretId === "string" ? parsed.secretId.trim() : "";
    const secretKey = typeof parsed.secretKey === "string" ? parsed.secretKey.trim() : "";

    return appId && secretId && secretKey ? { appId, secretId, secretKey } : undefined;
  } catch {
    return undefined;
  }
}

function areTencentAsrCredentialsEqual(
  left: TencentAsrCredentials | undefined,
  right: TencentAsrCredentials
): boolean {
  return Boolean(
    left &&
      left.appId === right.appId &&
      left.secretId === right.secretId &&
      left.secretKey === right.secretKey
  );
}

async function migrateLegacySpeechConfig(
  petId: string,
  existingCredentials?: TencentAsrCredentials
): Promise<TencentAsrCredentials | undefined> {
  let content: string;

  try {
    content = (await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, "");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return existingCredentials;
    }

    throw error;
  }

  const parsed = JSON.parse(content) as Partial<TencentSpeechConfig>;
  const credentials = parseTencentAsrCredentials(JSON.stringify(parsed));

  if (parsed.provider !== "tencent" || !credentials) {
    return existingCredentials;
  }

  if (existingCredentials && !areTencentAsrCredentialsEqual(existingCredentials, credentials)) {
    // This pet already owns a different credential set. Preserve the legacy
    // file so a pet that still depended on the old global fallback can migrate it.
    return existingCredentials;
  }

  if (!existingCredentials) {
    await setSecureString(tencentAsrSecretScope, petId, JSON.stringify(credentials));
  }

  const verifiedCredentials = parseTencentAsrCredentials(
    await getSecureString(tencentAsrSecretScope, petId)
  );

  if (!areTencentAsrCredentialsEqual(verifiedCredentials, credentials)) {
    throw new Error("腾讯云语音凭据迁移后的安全存储校验失败。");
  }

  try {
    await fs.rm(configPath);
  } catch {
    // Retry on the next request and refuse networking while plaintext cleanup
    // is incomplete. The encrypted copy remains valid and no data is lost.
    throw new Error("旧版腾讯云明文配置已加密，但无法删除原文件；请检查文件权限后重试。");
  }

  return credentials;
}

async function readTencentSpeechConfig(petId?: string): Promise<TencentSpeechConfig> {
  const targetPetId = petId?.trim();

  if (!targetPetId) {
    throw new Error("语音识别请求缺少桌宠 ID。");
  }

  let settings: PetDefinition["voiceInputSettings"];

  try {
    const content = (await fs.readFile(getPetConfigPath(targetPetId), "utf8")).replace(/^\uFEFF/, "");
    settings = (JSON.parse(content) as PetDefinition).voiceInputSettings;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (settings && (settings.provider !== "tencent-asr" || !settings.connected)) {
    throw new Error("当前桌宠尚未启用腾讯云语音识别。");
  }

  let credentials = parseTencentAsrCredentials(
    await getSecureString(tencentAsrSecretScope, targetPetId)
  );
  credentials = await migrateLegacySpeechConfig(targetPetId, credentials);

  if (!credentials) {
    throw new Error("请先在语音输入设置中填写并保存腾讯云凭据。");
  }

  return {
    provider: "tencent",
    ...credentials,
    region: "ap-guangzhou",
    engineModelType: "16k_zh",
    sourceType: 1,
    voiceFormat: "wav"
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
  const sessionId = request.sessionId;

  if (!isValidSpeechStreamSessionId(sessionId)) {
    return {
      ok: false,
      message: "实时语音识别会话 ID 无效。"
    };
  }

  bindSpeechStreamOwner(webContents);

  if (speechStreamSessions.has(sessionId) || startingSpeechStreamOwners.has(sessionId)) {
    return {
      ok: false,
      message: "实时语音识别会话 ID 已在使用。"
    };
  }

  if (clearPendingSpeechStreamCancel(sessionId) || webContents.isDestroyed()) {
    return cancelledSpeechStreamStartResult();
  }

  startingSpeechStreamOwners.set(sessionId, webContents);

  try {
    let config: TencentSpeechConfig;

    try {
      config = await readTencentSpeechConfig(request.petId);
    } catch (error: unknown) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "语音识别配置读取失败。"
      };
    }

    if (isSpeechStreamStartCancelled(sessionId, webContents)) {
      return cancelledSpeechStreamStartResult();
    }

    let socket: WebSocket;

    try {
      socket = new WebSocket(signTencentRealtimeUrl(config, sessionId));
    } catch (error: unknown) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "实时语音识别连接创建失败。"
      };
    }

    if (isSpeechStreamStartCancelled(sessionId, webContents)) {
      closeSocketImmediately(socket);
      return cancelledSpeechStreamStartResult();
    }

    const session: SpeechStreamSession = {
      socket,
      webContents,
      ended: false
    };
    speechStreamSessions.set(sessionId, session);

    if (isSpeechStreamStartCancelled(sessionId, webContents)) {
      closeSpeechStreamSessionImmediately(sessionId, session);
      return cancelledSpeechStreamStartResult();
    }

    socket.addEventListener("message", (event) => {
      if (speechStreamSessions.get(sessionId) !== session) {
        return;
      }

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
      const currentSession = speechStreamSessions.get(sessionId);

      if (currentSession !== session || currentSession.ended) {
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
      if (session.closeTimer) {
        clearTimeout(session.closeTimer);
        session.closeTimer = undefined;
      }

      if (speechStreamSessions.get(sessionId) === session) {
        speechStreamSessions.delete(sessionId);
      }
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
        closeSpeechStreamSessionImmediately(sessionId, session);
      }, 8000);
      timer.unref();

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
            if (speechStreamSessions.get(sessionId) !== session || session.ended) {
              settle(cancelledSpeechStreamStartResult());
              closeSpeechStreamSessionImmediately(sessionId, session);
              return;
            }

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
          closeSpeechStreamSessionImmediately(sessionId, session);
        } catch {
          settle({
            ok: false,
            message: "实时语音识别握手结果解析失败。"
          });
          closeSpeechStreamSessionImmediately(sessionId, session);
        }
      });

      socket.addEventListener("error", () => {
        settle({
          ok: false,
          message: "实时语音识别连接异常。"
        });
        closeSpeechStreamSessionImmediately(sessionId, session);
      });

      socket.addEventListener("close", () => {
        settle({
          ok: false,
          message: session.ended
            ? "实时语音识别连接已取消。"
            : "实时语音识别连接已关闭。"
        });
      });
    });
  } finally {
    if (startingSpeechStreamOwners.get(sessionId) === webContents) {
      startingSpeechStreamOwners.delete(sessionId);
    }
    cancelledSpeechStreamStarts.delete(sessionId);
    clearPendingSpeechStreamCancel(sessionId);
  }
}

export function sendSpeechStreamAudio(chunk: SpeechStreamAudioChunk): void {
  const session = speechStreamSessions.get(chunk.sessionId);

  if (!session || session.ended || session.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  session.socket.send(Buffer.from(chunk.audio));
}

export function stopSpeechStream(request: SpeechStreamStopRequest): void {
  const sessionId = request.sessionId;

  if (!isValidSpeechStreamSessionId(sessionId)) {
    return;
  }

  const session = speechStreamSessions.get(sessionId);

  if (!session) {
    if (startingSpeechStreamOwners.has(sessionId)) {
      cancelledSpeechStreamStarts.add(sessionId);
    } else {
      rememberPendingSpeechStreamCancel(sessionId);
    }
    return;
  }

  if (session.ended) {
    return;
  }

  if (session.socket.readyState === WebSocket.CONNECTING) {
    closeSpeechStreamSessionImmediately(sessionId, session);
    return;
  }

  session.ended = true;

  if (session.socket.readyState === WebSocket.OPEN) {
    try {
      session.socket.send(JSON.stringify({ type: "end" }));
    } catch {
      closeSpeechStreamSessionImmediately(sessionId, session);
      return;
    }
  } else {
    closeSpeechStreamSessionImmediately(sessionId, session);
    return;
  }

  session.closeTimer = setTimeout(() => {
    if (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING) {
      closeSpeechStreamSessionImmediately(sessionId, session);
    }
  }, 8000);
  session.closeTimer.unref();
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
