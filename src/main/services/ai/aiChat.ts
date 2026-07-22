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
import type { PetDefinition } from "../../../shared/types/pet";
import { parseFinalAiReply, type NormalizedAiReply } from "../../../shared/aiReply";
import {
  SecureStorageCorruptedError,
  SecureStorageUnavailableError
} from "../config/secureConfigStore";
import { getAiConnectionConfig, recordAiOutputCapability } from "./aiSettings";
import { recallMemoryForAi } from "../memory/memoryRecall";
import { captureCompletedAiTurn } from "../memory/memoryCapture";
import { AiStreamNormalizer } from "./aiStreamNormalizer";
import {
  buildAiChatRequestBody,
  buildChatCompletionsUrl,
  canFallbackAiOutputMode,
  getAiOutputModeFallbacks
} from "./aiProtocol";
import { moodService } from "../mood/MoodService";
import { buildMoodSystemPrompt } from "../mood/moodPrompt";
import { registerMoodTextToSpeechSnapshot } from "../speech/textToSpeech";
import {
  createAiReplyContractForPet,
  getAiProtocolTierForMode,
  type AiReplyContract
} from "../../../shared/aiContract";
import { getLocalPetDefinition } from "../config/petConfigStore";
import { buildAuthoritativeAiSystemPrompt } from "./aiPrompt";

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

function normalizeConversationMessages(messages: AiChatMessage[]): AiChatMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content.trim() }))
    .filter((message) => message.content.length > 0)
    .slice(-15);
}

function normalizeAssistantContentForContract(
  content: string,
  contract: AiReplyContract
): string {
  const parsed = parseFinalAiReply(content);
  const reply = parsed.reply || content.trim();
  if (contract.tier === "text") return reply;

  const values: Record<string, unknown> = {
    reply,
    moodDelta:
      Number.isInteger(parsed.moodDelta) && Math.abs(parsed.moodDelta as number) <= 12
        ? parsed.moodDelta
        : 0
  };
  if (contract.voiceTextRequired) values.voiceText = parsed.voiceText ?? reply;
  if (contract.emotionRequired) {
    values.emotion = parsed.emotion && contract.emotionKeys.includes(parsed.emotion)
      ? parsed.emotion
      : contract.emotionKeys[0];
  }
  return JSON.stringify(Object.fromEntries(
    contract.requiredFields.map((field) => [field, values[field]])
  ));
}

function buildMessagesForMode(options: {
  conversationMessages: AiChatMessage[];
  pet: PetDefinition;
  mode: AiOutputMode;
  moodContext: string;
  memoryContext?: string;
}): { messages: AiChatMessage[]; contract: AiReplyContract } {
  const contract = createAiReplyContractForPet(
    options.pet,
    getAiProtocolTierForMode(options.mode)
  );
  const conversation = options.conversationMessages.map((message) => ({
    role: message.role,
    content: message.role === "assistant"
      ? normalizeAssistantContentForContract(message.content, contract)
      : message.content
  }));
  return {
    contract,
    messages: [
      {
        role: "system",
        content: buildAuthoritativeAiSystemPrompt({
          pet: options.pet,
          contract,
          moodContext: options.moodContext,
          memoryContext: options.memoryContext
        })
      },
      ...conversation
    ]
  };
}

interface AiCompletionFetchResult {
  response: Response;
  mode: AiOutputMode;
  streaming: boolean;
  contract: AiReplyContract;
}

type ResolvedAiConfig = NonNullable<Awaited<ReturnType<typeof getAiConnectionConfig>>>;

const runtimeOutputCapabilities = new Map<string, NonNullable<ResolvedAiConfig["outputCapability"]>>();

function getRuntimeCapabilityKey(config: ResolvedAiConfig): string {
  return `${config.petId}\0${config.baseUrl}\0${config.model}`;
}

async function rememberRuntimeCapability(
  config: ResolvedAiConfig,
  mode: AiOutputMode,
  streaming: boolean,
  confidence: "tested" | "fallback"
): Promise<void> {
  const capability = {
    baseUrl: config.baseUrl,
    model: config.model,
    mode,
    protocolTier: getAiProtocolTierForMode(mode),
    streaming,
    confidence,
    checkedAt: new Date().toISOString(),
    probeVersion: 2 as const
  };
  runtimeOutputCapabilities.set(getRuntimeCapabilityKey(config), capability);
  await recordAiOutputCapability(
    config.petId,
    config.baseUrl,
    config.model,
    capability
  ).catch(() => undefined);
}

function getPreferredOutput(config: ResolvedAiConfig): {
  mode: AiOutputMode;
  streaming: boolean;
} {
  const capability = runtimeOutputCapabilities.get(getRuntimeCapabilityKey(config)) ??
    config.outputCapability;
  return {
    mode: capability?.protocolTier === "full"
      ? capability.mode
      : "plain-text",
    streaming: capability?.streaming ?? true
  };
}

async function fetchAiCompletion(options: {
  config: ResolvedAiConfig;
  conversationMessages: AiChatMessage[];
  pet: PetDefinition;
  moodContext: string;
  memoryContext?: string;
  streaming: boolean;
  signal?: AbortSignal;
}): Promise<AiCompletionFetchResult> {
  const preferred = getPreferredOutput(options.config);
  const modes = getAiOutputModeFallbacks(preferred.mode);
  const streamingOptions = options.streaming ? [true, false] : [false];
  let lastResponse: Response | undefined;
  let lastMode = modes[modes.length - 1];
  let lastStreaming = options.streaming;
  let lastContract = createAiReplyContractForPet(options.pet, "text");

  for (let streamingIndex = 0; streamingIndex < streamingOptions.length; streamingIndex += 1) {
    const streaming = streamingOptions[streamingIndex];
    for (let modeIndex = 0; modeIndex < modes.length; modeIndex += 1) {
      const mode = modes[modeIndex];
      const prepared = buildMessagesForMode({
        conversationMessages: options.conversationMessages,
        pet: options.pet,
        mode,
        moodContext: options.moodContext,
        memoryContext: options.memoryContext
      });
      lastContract = prepared.contract;
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
            messages: prepared.messages,
            mode,
            contract: prepared.contract,
            stream: streaming
          })
        )
      });
      lastResponse = response;
      lastMode = mode;
      lastStreaming = streaming;

      if (response.ok) {
        if (mode !== preferred.mode || streaming !== preferred.streaming) {
          await rememberRuntimeCapability(options.config, mode, streaming, "fallback");
        }
        return { response, mode, streaming, contract: prepared.contract };
      }

      if (!canFallbackAiOutputMode(response.status)) {
        return { response, mode, streaming, contract: prepared.contract };
      }

      const hasModeFallback = modeIndex < modes.length - 1;
      const hasStreamingFallback = streamingIndex < streamingOptions.length - 1;
      if (!hasModeFallback && !hasStreamingFallback) {
        return { response, mode, streaming, contract: prepared.contract };
      }

      await response.body?.cancel("retrying with compatible AI output settings").catch(() => undefined);
      if (hasModeFallback) {
        // The current transport was explicitly rejected with a compatibility
        // status. Persist the next transport before retrying so a completed,
        // canceled, or malformed lower response cannot make the next turn hit
        // the same known response_format error again.
        await rememberRuntimeCapability(
          options.config,
          modes[modeIndex + 1],
          streaming,
          "fallback"
        );
      }
    }
  }

  return {
    response: lastResponse as Response,
    mode: lastMode,
    streaming: lastStreaming,
    contract: lastContract
  };
}

async function repairAiReplyFormat(options: {
  config: ResolvedAiConfig;
  conversationMessages: AiChatMessage[];
  pet: PetDefinition;
  mode: AiOutputMode;
  contract: AiReplyContract;
  moodContext: string;
  memoryContext?: string;
  visibleReply: string;
  signal?: AbortSignal;
}): Promise<NormalizedAiReply | undefined> {
  if (options.contract.tier !== "full" || options.mode === "plain-text" || !options.visibleReply.trim()) {
    return undefined;
  }
  const prepared = buildMessagesForMode({
    conversationMessages: options.conversationMessages,
    pet: options.pet,
    mode: options.mode,
    moodContext: options.moodContext,
    memoryContext: options.memoryContext
  });
  prepared.messages.push(
    { role: "assistant", content: options.visibleReply },
    {
      role: "user",
      content: [
        "上一份回复的可见正文已经确定，但机器协议不完整。",
        "只重新封装同一份 reply，不得改写、增删或翻译 reply。",
        `必须返回且只返回字段：${options.contract.requiredFields.join("、")}。`
      ].join("\n")
    }
  );
  try {
    const response = await fetch(buildChatCompletionsUrl(options.config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      signal: options.signal,
      body: JSON.stringify(buildAiChatRequestBody({
        model: options.config.model,
        messages: prepared.messages,
        mode: options.mode,
        contract: options.contract,
        stream: false,
        temperature: 0,
        maxTokens: 1200
      }))
    });
    if (!response.ok) {
      await response.body?.cancel("format repair failed").catch(() => undefined);
      return undefined;
    }
    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) return undefined;
    const repaired = parseFinalAiReply(content, options.contract);
    return repaired.quality === "structured" && repaired.reply === options.visibleReply
      ? repaired
      : undefined;
  } catch {
    return undefined;
  }
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

  void rememberRuntimeCapability(config, mode, streaming, "tested");
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

  const messages = normalizeConversationMessages(request.messages);

  if (!messages.length) {
    return {
      ok: false,
      message: "请输入聊天内容。"
    };
  }

  let response: Response;
  let responseContract: AiReplyContract;

  try {
    const pet = await getLocalPetDefinition(request.petId);
    if (!pet) {
      return { ok: false, message: "当前桌宠配置不存在。" };
    }
    const fetched = await fetchAiCompletion({
      config,
      conversationMessages: messages,
      pet,
      moodContext: buildMoodSystemPrompt("calm"),
      streaming: false
    });
    response = fetched.response;
    responseContract = fetched.contract;
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

  const parsedReply = parseFinalAiReply(content, responseContract);

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
  moodService.releaseReplySnapshot(entry.target.id, entry.petId, entry.requestId);
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
  let moodSnapshot: Awaited<ReturnType<typeof moodService.createReplySnapshot>>;
  try {
    moodSnapshot = await moodService.createReplySnapshot(target.id, request.petId, request.requestId);
    registerMoodTextToSpeechSnapshot(target, request.petId, request.requestId, moodSnapshot.rangeId);
  } catch {
    completeEntry(entry, { ok: false, type: "error", message: "无法读取桌宠心情状态，请检查本地数据后重试。" });
    return;
  }
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

  let pet: PetDefinition | undefined;
  try {
    pet = await getLocalPetDefinition(request.petId);
  } catch {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "无法读取桌宠配置，请检查本地数据后重试。"
    });
    return;
  }
  if (!pet) {
    completeEntry(entry, { ok: false, type: "error", message: "当前桌宠配置不存在。" });
    return;
  }

  const conversationMessages = normalizeConversationMessages(request.messages);

  if (!conversationMessages.length) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "请输入聊天内容。"
    });
    return;
  }
  const currentUserText = [...conversationMessages].reverse().find((message) => message.role === "user")?.content;
  const moodContext = buildMoodSystemPrompt(moodSnapshot.rangeId);
  let memoryContext: string | undefined;

  try {
    const recalled = await recallMemoryForAi(request.petId, conversationMessages, entry.controller.signal);
    if (!entry.active) return;
    memoryContext = recalled.context;
  } catch {
    // Recall is optional and must never block the original chat path.
    if (!entry.active) return;
  }

  let response: Response;
  let responseMode: AiOutputMode;
  let requestedStreaming: boolean;
  let responseContract: AiReplyContract;

  try {
    const preferred = getPreferredOutput(config);
    const fetched = await fetchAiCompletion({
      config,
      conversationMessages,
      pet,
      moodContext,
      memoryContext,
      streaming: preferred.streaming,
      signal: entry.controller.signal
    });
    response = fetched.response;
    responseMode = fetched.mode;
    requestedStreaming = fetched.streaming;
    responseContract = fetched.contract;
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
    let parsedReply = content ? parseFinalAiReply(content, responseContract) : undefined;
    if (!parsedReply?.reply) {
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
      });
      return;
    }

    if (responseContract.tier === "full" && parsedReply.quality !== "structured") {
      const repaired = await repairAiReplyFormat({
        config,
        conversationMessages,
        pet,
        mode: responseMode,
        contract: responseContract,
        moodContext,
        memoryContext,
        visibleReply: parsedReply.reply,
        signal: entry.controller.signal
      });
      if (repaired) parsedReply = repaired;
    }

    if (parsedReply.quality === "structured" && parsedReply.moodDelta !== undefined) {
      await moodService.applyAiDelta(request.petId, request.requestId, parsedReply.moodDelta);
    }
    completeEntry(entry, {
      ok: true,
      type: "done",
      content: parsedReply.reply,
      emotion: parsedReply.emotion,
      voiceText: parsedReply.voiceText,
      protocolTier: responseContract.tier,
      quality: parsedReply.quality === "invalid" ? undefined : parsedReply.quality
    });
    if (responseContract.tier === "text" || parsedReply.quality === "structured") {
      recordRuntimeCapability(config, responseMode, false);
    }
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
  const normalizer = new AiStreamNormalizer(responseContract);
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
        voiceText: safeSnapshot.voiceText,
        protocolTier: responseContract.tier
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

  let parsedReply = normalizer.finalize();
  if (!parsedReply.reply) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
    });
    return;
  }
  if (responseContract.tier === "full" && parsedReply.quality !== "structured") {
    const repaired = await repairAiReplyFormat({
      config,
      conversationMessages,
      pet,
      mode: responseMode,
      contract: responseContract,
      moodContext,
      memoryContext,
      visibleReply: parsedReply.reply,
      signal: entry.controller.signal
    });
    if (repaired) parsedReply = repaired;
  }
  if (parsedReply.quality === "structured" && parsedReply.moodDelta !== undefined) {
    await moodService.applyAiDelta(request.petId, request.requestId, parsedReply.moodDelta);
  }
  completeEntry(entry, {
    ok: true,
    type: "done",
    content: parsedReply.reply,
    emotion: parsedReply.emotion,
    voiceText: parsedReply.voiceText,
    protocolTier: responseContract.tier,
    quality: parsedReply.quality === "invalid" ? undefined : parsedReply.quality
  });
  if (responseContract.tier === "text" || parsedReply.quality === "structured") {
    recordRuntimeCapability(config, responseMode, true);
  }
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
