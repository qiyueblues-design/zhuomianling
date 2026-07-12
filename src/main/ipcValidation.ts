import { assertValidPetId } from "../shared/validation/petId";
import { MEMORY_LIMITS } from "../shared/types/memory";
import {
  assertMemoryClearRequest,
  assertMemoryCreateRequest,
  assertMemoryExportRequest,
  assertMemoryGetRequest,
  assertMemoryListRequest,
  assertMemoryObjectBudget,
  assertMemoryRevisionRequest,
  assertMemorySearchRequest,
  assertMemorySettingsSaveRequest,
  assertMemoryUpdateRequest
} from "../shared/validation/memory";

interface PayloadLimits {
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
  maxTotalStringLength?: number;
  maxBinaryBytes?: number;
  maxNodes?: number;
}

interface ValidationBudget {
  nodes: number;
  totalStringLength: number;
}

const defaultLimits: Required<PayloadLimits> = {
  maxDepth: 12,
  maxArrayLength: 2048,
  maxObjectKeys: 2048,
  maxStringLength: 1_000_000,
  maxTotalStringLength: 4_000_000,
  maxBinaryBytes: 262_144,
  maxNodes: 20_000
};

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const speechSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export const validatedIpcChannels = new Set([
  "app:get-version",
  "app-window:is-shown",
  "app-window:startup-surface-ready",
  "pet-config:list-local",
  "pet-config:restore-backup",
  "pet-config:list-ui-themes",
  "pet-config:import-ui-theme",
  "pet-config:save-basic-info",
  "pet-config:save-persona",
  "pet-config:save-expression-mappings",
  "pet-config:save-event-settings",
  "pet-config:save-ui-settings",
  "pet-config:save-voice-input",
  "pet-config:pick-voice-model-file",
  "pet-config:test-voice-model-connection",
  "pet-config:disconnect-voice-model",
  "pet-config:save-voice-model",
  "pet-config:import-avatar",
  "pet-config:save-avatar-crop",
  "pet-config:delete",
  "live2d-import:select-folder",
  "live2d-import:validate-folder",
  "live2d-import:generate-entry",
  "live2d-import:create-preview-model",
  "live2d-import:import-model",
  "live2d-import:scan-imported-sources",
  "live2d-import:scan-preview-sources",
  "ai-settings:list",
  "ai-settings:get",
  "ai-settings:list-models",
  "ai-settings:save",
  "memory:get-summary",
  "memory:list",
  "memory:get",
  "memory:search",
  "memory:create",
  "memory:update",
  "memory:forget",
  "memory:undo-forget",
  "memory:clear",
  "memory:export",
  "memory:rebuild-index",
  "memory:get-settings",
  "memory:save-settings",
  "memory:get-provider-status",
  "memory:test-provider",
  "memory:get-status",
  "ai-chat:stream",
  "ai-chat:cancel",
  "speech-to-text:transcribe",
  "text-to-speech:speak",
  "text-to-speech:stop",
  "speech-stream:start",
  "speech-stream:audio",
  "speech-stream:stop",
  "window:minimize",
  "window:close",
  "pet-window:show",
  "pet-window:close",
  "pet-window:toggle-click-through",
  "pet-window:set-click-through",
  "pet-window:set-click-through-control-interactive",
  "pet-window:start-drag",
  "pet-window:move-drag",
  "pet-window:end-drag",
  "pet-window:get-state",
  "pet-window:get-payload",
  "pet-window:preview-source",
  "pet-window:consume-pending-source-preview",
  "pet-window:complete-source-preview"
]);

function fail(channel: string, message: string): never {
  throw new Error(`IPC ${channel} 参数无效：${message}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(channel: string, value: unknown, label = "请求"): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail(channel, `${label}必须是普通对象。`);
  }

  return value;
}

function assertAllowedKeys(channel: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) fail(channel, `不允许字段 ${unknown}。`);
}

function validateMemoryObject<T>(
  channel: string,
  value: unknown,
  allowed: readonly string[],
  validate: (request: T) => unknown
): Record<string, unknown> {
  const request = assertRecord(channel, value);
  assertAllowedKeys(channel, request, allowed);
  try {
    validate(request as T);
    assertMemoryObjectBudget(request);
  } catch (error) {
    fail(channel, error instanceof Error ? error.message : "记忆请求无效。");
  }
  assertSafePayload(channel, request, {
    maxArrayLength: MEMORY_LIMITS.tags,
    maxObjectKeys: 32,
    maxStringLength: MEMORY_LIMITS.contentChars,
    maxTotalStringLength: MEMORY_LIMITS.objectBudgetBytes
  });
  return request;
}

function assertManagementPageSize(channel: string, value: unknown): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MEMORY_LIMITS.managementPageSizeMax)
  ) {
    fail(channel, `pageSize 必须是 1-${MEMORY_LIMITS.managementPageSizeMax} 的整数。`);
  }
}

function assertString(
  channel: string,
  value: unknown,
  label: string,
  maxLength: number,
  options?: { allowEmpty?: boolean; pattern?: RegExp }
): string {
  if (typeof value !== "string") {
    fail(channel, `${label}必须是字符串。`);
  }

  if (!options?.allowEmpty && value.length === 0) {
    fail(channel, `${label}不能为空。`);
  }

  if (value.length > maxLength) {
    fail(channel, `${label}长度不能超过 ${maxLength}。`);
  }

  if (options?.pattern && !options.pattern.test(value)) {
    fail(channel, `${label}格式无效。`);
  }

  return value;
}

function assertOptionalString(
  channel: string,
  value: unknown,
  label: string,
  maxLength: number,
  options?: { pattern?: RegExp }
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return assertString(channel, value, label, maxLength, {
    allowEmpty: true,
    pattern: options?.pattern
  });
}

function assertPetId(channel: string, value: unknown, label = "petId"): string {
  try {
    return assertValidPetId(value);
  } catch (error: unknown) {
    fail(channel, `${label}：${error instanceof Error ? error.message : "格式无效。"}`);
  }
}

function assertRequestId(channel: string, value: unknown, label = "requestId"): string {
  return assertString(channel, value, label, 128, { pattern: requestIdPattern });
}

function assertSafePayload(
  channel: string,
  value: unknown,
  limitsOverrides: PayloadLimits = {}
): void {
  const limits = { ...defaultLimits, ...limitsOverrides };
  const budget: ValidationBudget = {
    nodes: 0,
    totalStringLength: 0
  };
  // Electron's structured clone payloads may legitimately share an object
  // instance (for example, one expression source selected by multiple
  // events). Only an object encountered on the active traversal path is a
  // circular reference; a globally seen object is not.
  const activeAncestors = new WeakSet<object>();

  const visit = (item: unknown, depth: number): void => {
    budget.nodes += 1;

    if (budget.nodes > limits.maxNodes) {
      fail(channel, "对象节点过多。");
    }

    if (depth > limits.maxDepth) {
      fail(channel, "对象嵌套过深。");
    }

    if (item === null || item === undefined || typeof item === "boolean") {
      return;
    }

    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        fail(channel, "数字必须是有限值。");
      }
      return;
    }

    if (typeof item === "string") {
      if (item.length > limits.maxStringLength) {
        fail(channel, `单个字符串长度不能超过 ${limits.maxStringLength}。`);
      }
      budget.totalStringLength += item.length;
      if (budget.totalStringLength > limits.maxTotalStringLength) {
        fail(channel, `字符串总长度不能超过 ${limits.maxTotalStringLength}。`);
      }
      return;
    }

    if (item instanceof ArrayBuffer) {
      if (item.byteLength > limits.maxBinaryBytes) {
        fail(channel, `二进制数据不能超过 ${limits.maxBinaryBytes} 字节。`);
      }
      return;
    }

    if (ArrayBuffer.isView(item)) {
      if (item.byteLength > limits.maxBinaryBytes) {
        fail(channel, `二进制数据不能超过 ${limits.maxBinaryBytes} 字节。`);
      }
      return;
    }

    if (typeof item !== "object") {
      fail(channel, "包含不支持的数据类型。");
    }

    if (activeAncestors.has(item)) {
      fail(channel, "对象不能包含循环引用。");
    }
    activeAncestors.add(item);

    try {
      if (Array.isArray(item)) {
        if (item.length > limits.maxArrayLength) {
          fail(channel, `数组长度不能超过 ${limits.maxArrayLength}。`);
        }
        for (const child of item) {
          visit(child, depth + 1);
        }
        return;
      }

      const record = assertRecord(channel, item);
      const entries = Object.entries(record);
      if (entries.length > limits.maxObjectKeys) {
        fail(channel, `对象字段数量不能超过 ${limits.maxObjectKeys}。`);
      }

      for (const [key, child] of entries) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          fail(channel, `不允许字段 ${key}。`);
        }
        visit(child, depth + 1);
      }
    } finally {
      activeAncestors.delete(item);
    }
  };

  visit(value, 0);
}

function expectArgumentCount(channel: string, args: unknown[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    fail(channel, `参数数量应为 ${min === max ? min : `${min}-${max}`}。`);
  }
}

function validatePetDraft(channel: string, value: unknown, maxStringLength = 200_000): void {
  const draft = assertRecord(channel, value);
  assertPetId(channel, draft.petId);
  assertSafePayload(channel, draft, {
    maxStringLength,
    maxTotalStringLength: Math.max(1_000_000, maxStringLength * 2)
  });
}

function validateAiChat(channel: string, value: unknown, requireRequestId: boolean): void {
  const request = assertRecord(channel, value);
  assertPetId(channel, request.petId);
  if (requireRequestId) {
    assertRequestId(channel, request.requestId);
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 128) {
    fail(channel, "messages 必须包含 1-128 条消息。");
  }
  for (const messageValue of request.messages) {
    const message = assertRecord(channel, messageValue, "消息");
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      fail(channel, "消息 role 无效。");
    }
    assertString(channel, message.content, "消息 content", 100_000, { allowEmpty: true });
  }
  assertSafePayload(channel, request, {
    maxArrayLength: 128,
    maxStringLength: 100_000,
    maxTotalStringLength: 1_000_000
  });
}

export function validateIpcArguments(channel: string, args: unknown[]): void {
  if (!validatedIpcChannels.has(channel)) {
    fail(channel, "没有注册运行时 schema。");
  }

  const noArgumentChannels = new Set([
    "app:get-version",
    "app-window:is-shown",
    "pet-config:list-local",
    "pet-config:list-ui-themes",
    "pet-config:import-ui-theme",
    "pet-config:disconnect-voice-model",
    "live2d-import:select-folder",
    "ai-settings:list",
    "window:minimize",
    "window:close",
    "pet-window:toggle-click-through",
    "pet-window:end-drag",
    "pet-window:get-state",
    "pet-window:get-payload",
    "pet-window:consume-pending-source-preview"
  ]);

  if (noArgumentChannels.has(channel)) {
    expectArgumentCount(channel, args, 0);
    return;
  }

  if (channel === "app-window:startup-surface-ready") {
    expectArgumentCount(channel, args, 0, 1);
    assertOptionalString(channel, args[0], "reason", 120);
    return;
  }

  if (
    channel === "pet-config:save-persona" ||
    channel === "pet-config:save-expression-mappings" ||
    channel === "pet-config:save-event-settings" ||
    channel === "pet-config:save-ui-settings" ||
    channel === "pet-config:save-voice-input" ||
    channel === "pet-config:test-voice-model-connection" ||
    channel === "pet-config:save-voice-model"
  ) {
    expectArgumentCount(channel, args, 1);
    validatePetDraft(channel, args[0]);
    return;
  }

  if (channel === "pet-config:save-basic-info") {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    if (draft.id !== undefined) {
      assertPetId(channel, draft.id, "id");
    }
    assertString(channel, draft.name, "name", 128);
    assertSafePayload(channel, draft, {
      maxArrayLength: 64,
      maxStringLength: 8_000_000,
      maxTotalStringLength: 10_000_000
    });
    return;
  }

  if (channel === "pet-config:pick-voice-model-file") {
    expectArgumentCount(channel, args, 1);
    if (args[0] !== "sovits" && args[0] !== "gpt" && args[0] !== "referenceAudio") {
      fail(channel, "资源类型无效。");
    }
    return;
  }

  if (channel === "pet-config:import-avatar") {
    expectArgumentCount(channel, args, 0, 1);
    if (args[0] !== undefined) {
      assertPetId(channel, args[0]);
    }
    return;
  }

  if (channel === "pet-config:save-avatar-crop") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    if (request.petId !== undefined) {
      assertPetId(channel, request.petId);
    }
    assertString(channel, request.dataUrl, "dataUrl", 16_000_000);
    assertSafePayload(channel, request, {
      maxStringLength: 16_000_000,
      maxTotalStringLength: 16_000_128
    });
    return;
  }

  if (
    channel === "pet-config:delete" ||
    channel === "pet-config:restore-backup" ||
    channel === "live2d-import:scan-imported-sources" ||
    channel === "ai-settings:get"
  ) {
    expectArgumentCount(channel, args, 1);
    assertPetId(channel, args[0]);
    return;
  }

  if (
    channel === "live2d-import:validate-folder" ||
    channel === "live2d-import:generate-entry" ||
    channel === "live2d-import:create-preview-model" ||
    channel === "live2d-import:scan-preview-sources"
  ) {
    expectArgumentCount(channel, args, 1);
    assertString(channel, args[0], "folderPath", 32_768);
    return;
  }

  if (channel === "live2d-import:import-model") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertPetId(channel, request.petId);
    assertString(channel, request.sourceFolderPath, "sourceFolderPath", 32_768);
    assertSafePayload(channel, request, { maxStringLength: 32_768 });
    return;
  }

  if (channel === "ai-settings:list-models" || channel === "ai-settings:save") {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    assertPetId(channel, draft.petId);
    assertString(channel, draft.providerName, "providerName", 128, { allowEmpty: true });
    assertString(channel, draft.baseUrl, "baseUrl", 4096, { allowEmpty: true });
    assertString(channel, draft.model, "model", 512, { allowEmpty: true });
    assertString(channel, draft.apiKey, "apiKey", 16_384, { allowEmpty: true });
    assertSafePayload(channel, draft, {
      maxArrayLength: 512,
      maxStringLength: 16_384,
      maxTotalStringLength: 262_144
    });
    return;
  }

  if (
    channel === "memory:get-summary" ||
    channel === "memory:rebuild-index" ||
    channel === "memory:get-settings" ||
    channel === "memory:get-provider-status" ||
    channel === "memory:test-provider" ||
    channel === "memory:get-status"
  ) {
    expectArgumentCount(channel, args, 1);
    assertPetId(channel, args[0]);
    return;
  }

  if (channel === "memory:list") {
    expectArgumentCount(channel, args, 1);
    const request = validateMemoryObject(
      channel,
      args[0],
      ["petId", "cursor", "pageSize", "chapters", "importantOnly", "sort", "fromTime", "toTime"],
      assertMemoryListRequest
    );
    assertManagementPageSize(channel, request.pageSize);
    return;
  }

  if (channel === "memory:search") {
    expectArgumentCount(channel, args, 1);
    const request = validateMemoryObject(
      channel,
      args[0],
      ["petId", "query", "cursor", "pageSize", "chapters", "importantOnly", "sort", "fromTime", "toTime"],
      assertMemorySearchRequest
    );
    assertManagementPageSize(channel, request.pageSize);
    return;
  }

  if (channel === "memory:get") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(channel, args[0], ["petId", "memoryId", "includeDeleted"], assertMemoryGetRequest);
    return;
  }

  if (channel === "memory:create") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(
      channel,
      args[0],
      ["petId", "chapter", "memoryType", "content", "tags", "important", "origin", "sourceTime"],
      assertMemoryCreateRequest
    );
    return;
  }

  if (channel === "memory:update") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(
      channel,
      args[0],
      ["petId", "memoryId", "expectedRevision", "chapter", "content", "tags", "important"],
      assertMemoryUpdateRequest
    );
    return;
  }

  if (channel === "memory:forget" || channel === "memory:undo-forget") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(
      channel,
      args[0],
      ["petId", "memoryId", "expectedRevision"],
      assertMemoryRevisionRequest
    );
    return;
  }

  if (channel === "memory:clear") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(channel, args[0], ["petId", "confirmPetId"], assertMemoryClearRequest);
    return;
  }

  if (channel === "memory:export") {
    expectArgumentCount(channel, args, 1);
    const request = validateMemoryObject(
      channel,
      args[0],
      ["petId", "options", "sourceExportConsent"],
      assertMemoryExportRequest
    );
    const options = assertRecord(channel, request.options, "options");
    assertAllowedKeys(channel, options, ["format", "includeSources"]);
    return;
  }

  if (channel === "memory:save-settings") {
    expectArgumentCount(channel, args, 1);
    const request = validateMemoryObject(
      channel,
      args[0],
      ["petId", "settings", "autoCaptureConsent", "sourceRetentionConsent"],
      assertMemorySettingsSaveRequest
    );
    const settings = assertRecord(channel, request.settings, "settings");
    assertAllowedKeys(channel, settings, [
      "onboardingCompleted",
      "recallEnabled",
      "autoCaptureEnabled",
      "recallLimit",
      "contextBudgetChars",
      "retainSources",
      "providerProfileId"
    ]);
    return;
  }

  if (channel === "ai-chat:stream") {
    expectArgumentCount(channel, args, 1);
    validateAiChat(channel, args[0], true);
    return;
  }

  if (channel === "ai-chat:cancel") {
    expectArgumentCount(channel, args, 0, 1);
    if (args[0] === undefined) {
      return;
    }
    const request = assertRecord(channel, args[0]);
    if (request.petId !== undefined) {
      assertPetId(channel, request.petId);
    }
    if (request.requestId !== undefined) {
      assertRequestId(channel, request.requestId);
    }
    assertOptionalString(channel, request.streamId, "streamId", 128, { pattern: requestIdPattern });
    assertSafePayload(channel, request, { maxStringLength: 128, maxTotalStringLength: 384 });
    return;
  }

  if (channel === "speech-to-text:transcribe") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    if (request.petId !== undefined) {
      assertPetId(channel, request.petId);
    }
    if (
      request.format !== "wav" &&
      request.format !== "pcm" &&
      request.format !== "mp3" &&
      request.format !== "m4a" &&
      request.format !== "ogg-opus" &&
      request.format !== "aac" &&
      request.format !== "amr"
    ) {
      fail(channel, "format 不是受支持的音频格式。");
    }
    assertString(channel, request.audioBase64, "audioBase64", 24_000_000);
    assertSafePayload(channel, request, {
      maxStringLength: 24_000_000,
      maxTotalStringLength: 24_001_000
    });
    return;
  }

  if (channel === "text-to-speech:speak") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertPetId(channel, request.petId);
    assertRequestId(channel, request.requestId);
    assertString(channel, request.text, "text", 20_000);
    assertSafePayload(channel, request, { maxStringLength: 20_000, maxTotalStringLength: 21_000 });
    return;
  }

  if (channel === "text-to-speech:stop") {
    expectArgumentCount(channel, args, 0, 1);
    if (args[0] === undefined) {
      return;
    }
    const request = assertRecord(channel, args[0]);
    if (request.petId !== undefined) {
      assertPetId(channel, request.petId);
    }
    if (request.requestId !== undefined) {
      assertRequestId(channel, request.requestId);
    }
    assertSafePayload(channel, request, { maxStringLength: 128, maxTotalStringLength: 256 });
    return;
  }

  if (channel === "speech-stream:start") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertPetId(channel, request.petId);
    assertString(channel, request.sessionId, "sessionId", 128, { pattern: speechSessionIdPattern });
    return;
  }

  if (channel === "speech-stream:audio") {
    expectArgumentCount(channel, args, 1);
    const chunk = assertRecord(channel, args[0]);
    assertString(channel, chunk.sessionId, "sessionId", 128, { pattern: speechSessionIdPattern });
    if (!(chunk.audio instanceof ArrayBuffer) || chunk.audio.byteLength > 262_144) {
      fail(channel, "audio 必须是不超过 262144 字节的 ArrayBuffer。");
    }
    return;
  }

  if (channel === "speech-stream:stop") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertString(channel, request.sessionId, "sessionId", 128, { pattern: speechSessionIdPattern });
    return;
  }

  if (channel === "pet-window:show") {
    expectArgumentCount(channel, args, 1);
    const payload = assertRecord(channel, args[0]);
    assertPetId(channel, payload.id, "id");
    assertString(channel, payload.name, "name", 128);
    assertString(channel, payload.modelPath, "modelPath", 32_768);
    assertOptionalString(channel, payload.avatar, "avatar", 2_000_000);
    assertSafePayload(channel, payload, {
      maxArrayLength: 4096,
      maxStringLength: 2_000_000,
      maxTotalStringLength: 4_000_000,
      maxNodes: 40_000
    });
    return;
  }

  if (channel === "pet-window:preview-source") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertPetId(channel, request.petId);
    const source = assertRecord(channel, request.source, "source");
    if (source.sourceKind !== "motion" && source.sourceKind !== "expression") {
      fail(channel, "sourceKind 无效。");
    }
    assertString(channel, source.sourceFileName, "sourceFileName", 1024);
    if (typeof source.runtimeName !== "string" && typeof source.runtimeName !== "number") {
      fail(channel, "runtimeName 必须是字符串或数字。");
    }
    if (typeof source.runtimeName === "string") {
      assertString(channel, source.runtimeName, "runtimeName", 1024);
    } else if (!Number.isFinite(source.runtimeName)) {
      fail(channel, "runtimeName 必须是有限数字。");
    }
    assertSafePayload(channel, request, { maxStringLength: 1024, maxTotalStringLength: 4096 });
    return;
  }

  if (channel === "pet-window:complete-source-preview") {
    expectArgumentCount(channel, args, 1);
    if (typeof args[0] !== "number" || !Number.isSafeInteger(args[0]) || args[0] < 1) {
      fail(channel, "previewId 无效。");
    }
    return;
  }

  if (channel === "pet-window:close") {
    expectArgumentCount(channel, args, 0, 1);
    if (args[0] === undefined) {
      return;
    }
    const options = assertRecord(channel, args[0]);
    if (options.playEffect !== undefined && typeof options.playEffect !== "boolean") {
      fail(channel, "playEffect 必须是布尔值。");
    }
    return;
  }

  if (
    channel === "pet-window:set-click-through" ||
    channel === "pet-window:set-click-through-control-interactive"
  ) {
    expectArgumentCount(channel, args, 1);
    if (typeof args[0] !== "boolean") {
      fail(channel, "参数必须是布尔值。");
    }
    return;
  }

  if (channel === "pet-window:start-drag" || channel === "pet-window:move-drag") {
    expectArgumentCount(channel, args, 1);
    const point = assertRecord(channel, args[0]);
    if (
      typeof point.x !== "number" ||
      !Number.isFinite(point.x) ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.y) ||
      Math.abs(point.x) > 1_000_000 ||
      Math.abs(point.y) > 1_000_000
    ) {
      fail(channel, "拖拽坐标无效。");
    }
    return;
  }

  fail(channel, "没有注册运行时 schema。");
}
