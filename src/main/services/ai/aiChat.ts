import type { WebContents } from "electron";
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiChatStreamCancelRequest,
  AiChatStreamCancelResult,
  AiChatStreamRequest,
  AiChatStreamEvent
} from "../../../shared/types/ai";
import { parseFinalAiReply } from "../../../shared/aiReply";
import {
  SecureStorageCorruptedError,
  SecureStorageUnavailableError
} from "../config/secureConfigStore";
import { getAiConnectionConfig } from "./aiSettings";
import { recallMemoryForAi } from "../memory/memoryRecall";
import { injectMemoryContext } from "../memory/memoryPrompt";
import { captureCompletedAiTurn } from "../memory/memoryCapture";

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
    };
    message?: {
      content?: string;
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

function buildChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/`);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (normalizedPath && normalizedPath !== "") {
    url.pathname = `${normalizedPath}/chat/completions`;
    return url.toString();
  }

  url.pathname = "/v1/chat/completions";
  return url.toString();
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
    response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.8,
        max_tokens: 1200,
        response_format: {
          type: "json_object"
        }
      })
    });
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

  return {
    ok: true,
    message: "ok",
    content: parsedReply.reply,
    rawContent: content,
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

  try {
    response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      signal: entry.controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.8,
        max_tokens: 1200,
        response_format: {
          type: "json_object"
        },
        stream: true
      })
    });
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

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  entry.reader = reader;
  let buffer = "";
  let content = "";
  resetIdleTimeout(entry, timeouts.idleTimeoutMs);

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
        const line = rawLine.trim();

        if (!line.startsWith("data:")) {
          continue;
        }

        const data = line.slice(5).trim();

        if (!data || data === "[DONE]") {
          continue;
        }

        const { delta, error } = readStreamChunkDelta(data);

        if (error) {
          completeEntry(entry, {
            ok: false,
            type: "error",
            message: error
          });
          return;
        }

        if (!delta) {
          continue;
        }

        content += delta;
        emitEntryEvent(entry, {
          ok: true,
          type: "chunk",
          delta,
          content
        });
      }
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

  if (!content.trim()) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "AI 没有返回可显示的回复。"
    });
    return;
  }

  const parsedReply = parseFinalAiReply(content);
  completeEntry(entry, {
    ok: true,
    type: "done",
    content
  });
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
