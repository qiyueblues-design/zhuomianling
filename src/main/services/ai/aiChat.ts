import type { WebContents } from "electron";
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiChatStreamCancelRequest,
  AiChatStreamCancelResult,
  AiChatStreamRequest,
  AiChatStreamEvent,
  AiOutputMode
} from "../../../shared/types/ai";
import { parseFinalAiReply } from "../../../shared/aiReply";
import {
  SecureStorageCorruptedError,
  SecureStorageUnavailableError
} from "../config/secureConfigStore";
import { getAiConnectionConfig, recordAiOutputCapability } from "./aiSettings";
import { recallMemoryForAi } from "../memory/memoryRecall";
import { injectMemoryContext } from "../memory/memoryPrompt";
import { captureCompletedAiTurn } from "../memory/memoryCapture";
import { AiStreamNormalizer } from "./aiStreamNormalizer";
import {
  buildAiChatRequestBody,
  buildChatCompletionsUrl,
  canFallbackAiOutputMode,
  getAiOutputModeFallbacks
} from "./aiProtocol";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

function getAiSettingsErrorMessage(error: unknown): string {
  if (
    error instanceof SecureStorageUnavailableError ||
    error instanceof SecureStorageCorruptedError
  ) {
    return error.message;
  }

  return "无法读取本机 AI 设置，请检查配置文件权限后重试。";
}

function normalizeMessages(messages: AiChatMessage[]): AiChatMessage[] {
  const normalizedMessages = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim()
    }))
    .filter((message) => message.content.length > 0);
  const systemMessages = normalizedMessages.filter((message) => message.role === "system");
  const conversationMessages = normalizedMessages.filter((message) => message.role !== "system");

  return [...systemMessages, ...conversationMessages.slice(-15)];
}

interface AiCompletionFetchResult {
  response: Response;
  mode: AiOutputMode;
  streaming: boolean;
}

type ResolvedAiConfig = NonNullable<Awaited<ReturnType<typeof getAiConnectionConfig>>>;

function getPreferredOutput(config: ResolvedAiConfig): {
  mode: AiOutputMode;
  streaming: boolean;
} {
  return {
    mode: config.outputCapability?.mode ?? "json-object",
    streaming: config.outputCapability?.streaming ?? true
  };
}

async function fetchAiCompletion(options: {
  config: ResolvedAiConfig;
  messages: AiChatMessage[];
  streaming: boolean;
  signal?: AbortSignal;
}): Promise<AiCompletionFetchResult> {
  const modes = getAiOutputModeFallbacks(getPreferredOutput(options.config).mode);
  const streamingOptions = options.streaming ? [true, false] : [false];
  let lastResponse: Response | undefined;
  let lastMode = modes[modes.length - 1];
  let lastStreaming = options.streaming;

  for (let streamingIndex = 0; streamingIndex < streamingOptions.length; streamingIndex += 1) {
    const streaming = streamingOptions[streamingIndex];
    for (let modeIndex = 0; modeIndex < modes.length; modeIndex += 1) {
      const mode = modes[modeIndex];
      const response = await fetch(buildChatCompletionsUrl(options.config.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: streaming ? "text/event-stream, application/json" : "application/json"
        },
        signal: options.signal,
        body: JSON.stringify(
          buildAiChatRequestBody({
            model: options.config.model,
            messages: options.messages,
            mode,
            stream: streaming
          })
        )
      });
      lastResponse = response;
      lastMode = mode;
      lastStreaming = streaming;

      if (response.ok || !canFallbackAiOutputMode(response.status)) {
        return { response, mode, streaming };
      }

      const hasModeFallback = modeIndex < modes.length - 1;
      const hasStreamingFallback = streamingIndex < streamingOptions.length - 1;
      if (!hasModeFallback && !hasStreamingFallback) {
        return { response, mode, streaming };
      }

      await response.body?.cancel("retrying with compatible AI output settings").catch(() => undefined);
    }
  }

  return {
    response: lastResponse as Response,
    mode: lastMode,
    streaming: lastStreaming
  };
}

function recordRuntimeCapability(
  config: ResolvedAiConfig,
  mode: AiOutputMode,
  streaming: boolean
): void {
  if (
    config.outputCapability?.mode === mode &&
    config.outputCapability.streaming === streaming &&
    config.outputCapability.confidence === "tested"
  ) {
    return;
  }

  void recordAiOutputCapability(config.petId, config.baseUrl, config.model, {
    baseUrl: config.baseUrl,
    model: config.model,
    mode,
    streaming,
    confidence: "tested",
    checkedAt: new Date().toISOString()
  }).catch(() => undefined);
}

export async function sendAiChat(request: AiChatRequest): Promise<AiChatResponse> {
  let config: Awaited<ReturnType<typeof getAiConnectionConfig>>;

  try {
    config = await getAiConnectionConfig(request.petId);
  } catch (error: unknown) {
    return {
      ok: false,
      message: getAiSettingsErrorMessage(error)
    };
  }

  if (!config?.baseUrl || !config.model || !config.apiKey) {
    return {
      ok: false,
      message: "请先在 AI 设置中保存该桌宠的服务商、模型和 API Key。"
    };
  }

  const messages = normalizeMessages(request.messages);

  if (!messages.length) {
    return {
      ok: false,
      message: "请输入聊天内容。"
    };
  }

  let response: Response;

  try {
    const fetched = await fetchAiCompletion({ config, messages, streaming: false });
    response = fetched.response;
  } catch {
    return {
      ok: false,
      message: "无法连接 AI 服务，请检查网络或本地服务状态。"
    };
  }

  let body: ChatCompletionResponse;

  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch {
    return {
      ok: false,
      message: `AI 服务返回异常内容，状态码 ${response.status}。`
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: body.error?.message ?? `AI 请求失败，状态码 ${response.status}。`
    };
  }

  const content = body.choices?.[0]?.message?.content?.trim();

  if (!content) {
    return {
      ok: false,
      message: "AI 没有返回可显示的回复。"
    };
  }

  const parsedReply = parseFinalAiReply(content);

  if (!parsedReply.reply) {
    return {
      ok: false,
      message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
    };
  }

  return {
    ok: true,
    message: "ok",
    content: parsedReply.reply,
    emotion: parsedReply.emotion,
    voiceText: parsedReply.voiceText
  };
}

function sendStreamEvent(target: WebContents, event: AiChatStreamEvent): void {
  if (!target.isDestroyed()) {
    target.send("ai-chat:stream-event", event);
  }
}

export interface AiChatStreamTimeouts {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
}

type AiChatAbortReason = NonNullable<AiChatStreamEvent["reason"]>;

interface AiChatStreamEntry {
  target: WebContents;
  streamId: string;
  requestId: string;
  petId: string;
  controller: AbortController;
  active: boolean;
  connectTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  totalTimer?: NodeJS.Timeout;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

interface AiChatOwnerState {
  streams: Map<string, AiChatStreamEntry>;
  ownerGoneListener: () => void;
}

const defaultAiChatStreamTimeouts: AiChatStreamTimeouts = {
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000
};
const aiChatOwners = new WeakMap<WebContents, AiChatOwnerState>();

function emitEntryEvent(
  entry: AiChatStreamEntry,
  event: Omit<AiChatStreamEvent, "streamId" | "requestId" | "petId">
): void {
  if (!entry.active) {
    return;
  }

  sendStreamEvent(entry.target, {
    ...event,
    streamId: entry.streamId,
    requestId: entry.requestId,
    petId: entry.petId
  });
}

function clearEntryTimers(entry: AiChatStreamEntry): void {
  clearTimeout(entry.connectTimer);
  clearTimeout(entry.idleTimer);
  clearTimeout(entry.totalTimer);
  entry.connectTimer = undefined;
  entry.idleTimer = undefined;
  entry.totalTimer = undefined;
}

function detachEntry(entry: AiChatStreamEntry, abortReason?: AiChatAbortReason): boolean {
  if (!entry.active) {
    return false;
  }

  entry.active = false;
  clearEntryTimers(entry);

  const ownerState = aiChatOwners.get(entry.target);
  ownerState?.streams.delete(entry.streamId);

  if (ownerState && ownerState.streams.size === 0) {
    entry.target.removeListener("render-process-gone", ownerState.ownerGoneListener);
    entry.target.removeListener("destroyed", ownerState.ownerGoneListener);
    aiChatOwners.delete(entry.target);
  }

  if (abortReason && !entry.controller.signal.aborted) {
    entry.controller.abort(abortReason);
  }

  if (abortReason && entry.reader) {
    void entry.reader.cancel(abortReason).catch(() => undefined);
  }

  return true;
}

function completeEntry(
  entry: AiChatStreamEntry,
  event: Omit<AiChatStreamEvent, "streamId" | "requestId" | "petId">
): void {
  emitEntryEvent(entry, event);
  detachEntry(entry);
}

function abortEntry(entry: AiChatStreamEntry, reason: AiChatAbortReason): boolean {
  if (!entry.active) {
    return false;
  }

  if (reason === "connect-timeout" || reason === "idle-timeout" || reason === "total-timeout") {
    const timeoutLabel =
      reason === "connect-timeout"
        ? "连接超时"
        : reason === "idle-timeout"
          ? "等待回复超时"
          : "总时长超时";
    emitEntryEvent(entry, {
      ok: false,
      type: "error",
      reason,
      message: `AI ${timeoutLabel}，请检查网络或服务状态后重试。`
    });
  } else if (reason !== "owner-destroyed") {
    emitEntryEvent(entry, {
      ok: false,
      type: "canceled",
      reason,
      message: reason === "replaced" ? "旧回复已由新请求替换。" : "AI 回复已取消。"
    });
  }

  return detachEntry(entry, reason);
}

function getOrCreateOwnerState(target: WebContents): AiChatOwnerState {
  const existingState = aiChatOwners.get(target);

  if (existingState) {
    return existingState;
  }

  const ownerState: AiChatOwnerState = {
    streams: new Map(),
    ownerGoneListener: () => {
      for (const entry of [...ownerState.streams.values()]) {
        abortEntry(entry, "owner-destroyed");
      }
    }
  };
  aiChatOwners.set(target, ownerState);
  target.on("render-process-gone", ownerState.ownerGoneListener);
  target.once("destroyed", ownerState.ownerGoneListener);

  return ownerState;
}

function createStreamEntry(
  target: WebContents,
  request: AiChatStreamRequest,
  streamId: string,
  timeouts: AiChatStreamTimeouts
): AiChatStreamEntry {
  const currentOwnerState = getOrCreateOwnerState(target);

  for (const existingEntry of [...currentOwnerState.streams.values()]) {
    if (existingEntry.petId === request.petId) {
      abortEntry(existingEntry, "replaced");
    }
  }

  const ownerState = getOrCreateOwnerState(target);

  const entry: AiChatStreamEntry = {
    target,
    streamId,
    requestId: request.requestId,
    petId: request.petId,
    controller: new AbortController(),
    active: true
  };
  ownerState.streams.set(streamId, entry);

  entry.connectTimer = setTimeout(() => {
    abortEntry(entry, "connect-timeout");
  }, timeouts.connectTimeoutMs);
  entry.totalTimer = setTimeout(() => {
    abortEntry(entry, "total-timeout");
  }, timeouts.totalTimeoutMs);

  return entry;
}

function resetIdleTimeout(entry: AiChatStreamEntry, idleTimeoutMs: number): void {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    abortEntry(entry, "idle-timeout");
  }, idleTimeoutMs);
}

export function cancelAiChatStreams(
  target: WebContents,
  request: AiChatStreamCancelRequest = {}
): AiChatStreamCancelResult {
  const ownerState = aiChatOwners.get(target);
  let canceled = 0;

  for (const entry of [...(ownerState?.streams.values() ?? [])]) {
    if (request.petId && entry.petId !== request.petId) {
      continue;
    }

    if (request.requestId && entry.requestId !== request.requestId) {
      continue;
    }

    if (request.streamId && entry.streamId !== request.streamId) {
      continue;
    }

    canceled += Number(abortEntry(entry, "renderer"));
  }

  return {
    ok: true,
    message: "ok",
    canceled
  };
}

function readStreamChunkDelta(line: string): { delta?: string; error?: string } {
  try {
    const parsed = JSON.parse(line) as ChatCompletionStreamChunk;

    return {
      delta: parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content,
      error: parsed.error?.message
    };
  } catch {
    return {};
  }
}

export async function startAiChatStream(
  target: WebContents,
  request: AiChatStreamRequest,
  streamId: string,
  timeoutOverrides: Partial<AiChatStreamTimeouts> = {}
): Promise<void> {
  const timeouts = {
    ...defaultAiChatStreamTimeouts,
    ...timeoutOverrides
  };
  const entry = createStreamEntry(target, request, streamId, timeouts);
  let config: Awaited<ReturnType<typeof getAiConnectionConfig>>;

  try {
    config = await getAiConnectionConfig(request.petId);
  } catch (error: unknown) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: getAiSettingsErrorMessage(error)
    });
    return;
  }

  if (!entry.active) {
    return;
  }

  if (!config?.baseUrl || !config.model || !config.apiKey) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "请先在 AI 设置中保存该桌宠的服务商、模型和 API Key。"
    });
    return;
  }

  let messages = normalizeMessages(request.messages);

  if (!messages.length) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "请输入聊天内容。"
    });
    return;
  }
  const currentUserText = [...messages].reverse().find((message) => message.role === "user")?.content;

  try {
    const recalled = await recallMemoryForAi(request.petId, messages, entry.controller.signal);
    if (!entry.active) return;
    messages = injectMemoryContext(messages, recalled.context);
  } catch {
    // Recall is optional and must never block the original chat path.
    if (!entry.active) return;
  }

  let response: Response;
  let responseMode: AiOutputMode;
  let requestedStreaming: boolean;

  try {
    const preferred = getPreferredOutput(config);
    const fetched = await fetchAiCompletion({
      config,
      messages,
      streaming: preferred.streaming,
      signal: entry.controller.signal
    });
    response = fetched.response;
    responseMode = fetched.mode;
    requestedStreaming = fetched.streaming;
  } catch {
    if (!entry.active) {
      return;
    }

    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "无法连接 AI 服务，请检查网络或本地服务状态。"
    });
    return;
  }

  if (!entry.active) {
    return;
  }

  clearTimeout(entry.connectTimer);
  entry.connectTimer = undefined;

  if (!response.ok || !response.body) {
    let message = `AI 请求失败，状态码 ${response.status}。`;

    try {
      const body = (await response.json()) as ChatCompletionResponse;
      message = body.error?.message ?? message;
    } catch {
      // Keep the status-based message.
    }

    if (!entry.active) {
      return;
    }

    completeEntry(entry, {
      ok: false,
      type: "error",
      message
    });
    return;
  }

  const contentType = response.headers?.get?.("Content-Type")?.toLowerCase() ?? "";
  if (!requestedStreaming || contentType.includes("application/json")) {
    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch {
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: "AI 服务返回异常内容。"
      });
      return;
    }

    const content = body.choices?.[0]?.message?.content?.trim();
    const parsedReply = content ? parseFinalAiReply(content) : undefined;
    if (!parsedReply?.reply) {
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
      });
      return;
    }

    completeEntry(entry, {
      ok: true,
      type: "done",
      content: parsedReply.reply,
      emotion: parsedReply.emotion,
      voiceText: parsedReply.voiceText,
      quality: parsedReply.quality === "invalid" ? undefined : parsedReply.quality
    });
    recordRuntimeCapability(config, responseMode, false);
    if (currentUserText && parsedReply.completeForMemory) {
      void captureCompletedAiTurn({
        petId: request.petId,
        requestId: request.requestId,
        userText: currentUserText,
        assistantReply: parsedReply.reply,
        occurredAt: new Date().toISOString()
      }).catch(() => undefined);
    }
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  entry.reader = reader;
  let buffer = "";
  const normalizer = new AiStreamNormalizer();
  resetIdleTimeout(entry, timeouts.idleTimeoutMs);

  const processSseLine = async (rawLine: string): Promise<boolean> => {
    const line = rawLine.trim();

    if (!line.startsWith("data:")) {
      return true;
    }

    const data = line.slice(5).trim();

    if (!data || data === "[DONE]") {
      return true;
    }

    const { delta, error } = readStreamChunkDelta(data);

    if (error) {
      await reader.cancel("AI provider returned a stream error").catch(() => undefined);
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: error
      });
      return false;
    }

    if (!delta) {
      return true;
    }

    const safeSnapshot = normalizer.append(delta);
    if (safeSnapshot.overflowed) {
      await reader.cancel("AI response exceeded the bounded parser budget").catch(() => undefined);
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: "AI 返回内容过长，已停止本次回复。"
      });
      return false;
    }

    if (safeSnapshot.changed) {
      emitEntryEvent(entry, {
        ok: true,
        type: "chunk",
        delta: safeSnapshot.replyDelta,
        content: safeSnapshot.reply,
        voiceText: safeSnapshot.voiceText
      });
    }

    return true;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (!entry.active) {
        return;
      }

      if (done) {
        break;
      }

      resetIdleTimeout(entry, timeouts.idleTimeoutMs);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        if (!(await processSseLine(rawLine))) {
          return;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer && !(await processSseLine(buffer))) {
      return;
    }
  } catch {
    if (!entry.active) {
      return;
    }

    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "AI 流式回复中断，请稍后再试。"
    });
    return;
  }

  if (!normalizer.hasContent()) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "AI 没有返回可显示的回复。"
    });
    return;
  }

  const parsedReply = normalizer.finalize();
  if (!parsedReply.reply) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
    });
    return;
  }
  completeEntry(entry, {
    ok: true,
    type: "done",
    content: parsedReply.reply,
    emotion: parsedReply.emotion,
    voiceText: parsedReply.voiceText,
    quality: parsedReply.quality === "invalid" ? undefined : parsedReply.quality
  });
  recordRuntimeCapability(config, responseMode, true);
  if (currentUserText && parsedReply.completeForMemory && parsedReply.reply) {
    void captureCompletedAiTurn({
      petId: request.petId,
      requestId: request.requestId,
      userText: currentUserText,
      assistantReply: parsedReply.reply,
      occurredAt: new Date().toISOString()
    }).catch(() => undefined);
  }
}
