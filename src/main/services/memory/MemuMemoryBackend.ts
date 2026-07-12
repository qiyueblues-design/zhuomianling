import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  MemoryConversationTurn,
  MemoryForgetRequest,
  MemoryMemorizeResponse,
  MemoryProviderStatus,
  MemoryRebuildRequest,
  MemoryRebuildResponse,
  MemoryRetrieveRequest,
  MemoryRetrieveResponse,
  MemoryUpsertRequest
} from "../../../shared/types/memory";
import {
  assertMemoryConversationTurn,
  assertMemoryMemorizeResponse,
  assertMemoryRecord,
  assertMemoryRecordInput,
  assertMemoryRetrieveRequest,
  assertMemoryRetrieveResponse
} from "../../../shared/validation/memory";
import { assertValidPetId } from "../../../shared/validation/petId";
import { MemoryBackendError, type MemoryBackend } from "./MemoryBackend";
import { MemorySidecarClient, MemorySidecarClientError } from "./MemorySidecarClient";

const expectedMemuVersion = "1.5.1";
const defaultModelFingerprint = "memu-py-1.5.1:desktop-hash-embedding-v1";
const rebuildBatchSize = 20;

type IndexDirectoryResolver = (petId: string) => string | Promise<string>;

export interface MemuMemoryBackendOptions {
  client: MemorySidecarClient;
  indexDirectoryForPet: IndexDirectoryResolver;
  modelFingerprint?: string;
}

export interface MemoryNormalizationProviderConfig {
  petId: string;
  profileId: string;
  baseUrl: string;
  chatModel: string;
  apiKey: string;
}

interface RebuildFinishDto {
  indexedCount: number;
  contentFingerprint: string;
  modelFingerprint: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapSidecarError(error: unknown): MemoryBackendError {
  if (error instanceof MemoryBackendError) return error;
  if (error instanceof MemorySidecarClientError) {
    const code = ["canceled", "timeout", "unavailable", "invalid-config", "index-dirty"].includes(error.code)
      ? error.code as "canceled" | "timeout" | "unavailable" | "invalid-config" | "index-dirty"
      : "internal";
    return new MemoryBackendError(code, error.message, error.code !== "invalid-request");
  }
  return new MemoryBackendError("internal", "The memU memory adapter failed.");
}

function assertApplied(value: unknown): void {
  if (!isObject(value) || value.applied !== true || Object.keys(value).some((key) => key !== "applied")) {
    throw new MemoryBackendError("internal", "The memU adapter returned an invalid mutation response.", false);
  }
}

function assertRebuildFinish(value: unknown, fingerprint: string): RebuildFinishDto {
  if (
    !isObject(value) ||
    !Number.isInteger(value.indexedCount) ||
    (value.indexedCount as number) < 0 ||
    typeof value.contentFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contentFingerprint) ||
    value.modelFingerprint !== fingerprint ||
    Object.keys(value).some((key) => !["indexedCount", "contentFingerprint", "modelFingerprint"].includes(key))
  ) {
    throw new MemoryBackendError("index-dirty", "The rebuilt memU index failed validation.");
  }
  return value as unknown as RebuildFinishDto;
}

function validTargetId(value: string): boolean {
  return value === "current" || /^staging-[A-Za-z0-9_-]{1,96}$/.test(value);
}

function toSidecarMemory<T extends Record<string, unknown>>(memory: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(memory).filter(([, value]) => value !== undefined));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, sortJsonValue(item)])
    );
  }
  return value;
}

function authorityContentFingerprint(records: Array<Record<string, unknown>>): string {
  const canonical = [...records]
    .sort((left, right) => Buffer.compare(Buffer.from(String(left.id), "utf8"), Buffer.from(String(right.id), "utf8")))
    .map((record) => JSON.stringify(sortJsonValue(record)))
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class MemuMemoryBackend implements MemoryBackend {
  readonly modelFingerprint: string;
  private readonly normalizationProfiles = new Map<string, string>();

  constructor(private readonly options: MemuMemoryBackendOptions) {
    this.modelFingerprint = options.modelFingerprint ?? defaultModelFingerprint;
  }

  private async indexPath(petId: string, targetId = "current"): Promise<string> {
    assertValidPetId(petId);
    if (!validTargetId(targetId)) {
      throw new MemoryBackendError("internal", "Invalid derived index target.", false);
    }
    const configured = path.resolve(await this.options.indexDirectoryForPet(petId));
    if (path.basename(configured) !== "index") {
      throw new MemoryBackendError("internal", "Memory index resolver returned an unsafe directory.", false);
    }
    await fs.mkdir(configured, { recursive: true });
    const stat = await fs.lstat(configured);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MemoryBackendError("unavailable", "Memory index directory is unsafe.", false);
    }
    const root = await fs.realpath(configured);
    const target = path.join(root, targetId);
    await fs.mkdir(target, { recursive: true });
    const targetStat = await fs.lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new MemoryBackendError("unavailable", "Memory index target is unsafe.", false);
    }
    const realTarget = await fs.realpath(target);
    if (path.dirname(realTarget) !== root) {
      throw new MemoryBackendError("unavailable", "Memory index target escaped its root.", false);
    }
    return realTarget;
  }

  async health(signal: AbortSignal): Promise<MemoryProviderStatus> {
    try {
      const handshake = await this.options.client.ensureStarted();
      if (handshake.memuVersion !== expectedMemuVersion) {
        return { state: "invalid-config", message: "The locked memU 1.5.1 runtime is unavailable." };
      }
      const result = await this.options.client.request("health", {}, { deadlineMs: 1_200, signal });
      if (!isObject(result) || result.status !== "ready") {
        throw new MemoryBackendError("unavailable", "Memory sidecar health check failed.");
      }
      return { state: "ready" };
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async retrieve(request: MemoryRetrieveRequest, signal: AbortSignal): Promise<MemoryRetrieveResponse> {
    assertMemoryRetrieveRequest(request);
    try {
      const result = await this.options.client.request<MemoryRetrieveResponse>(
        "retrieve",
        { indexPath: await this.indexPath(request.petId), query: request.query, limit: request.limit },
        { petId: request.petId, deadlineMs: 1_200, signal }
      );
      assertMemoryRetrieveResponse(result, request.petId);
      return result;
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async configureNormalizationProvider(
    config: MemoryNormalizationProviderConfig,
    signal: AbortSignal
  ): Promise<void> {
    assertValidPetId(config.petId);
    if (!config.profileId.trim() || config.profileId.length > 128 || !config.apiKey || config.apiKey.length > 4096) {
      throw new MemoryBackendError("invalid-config", "Memory normalization provider is invalid.", false);
    }
    try {
      const result = await this.options.client.request("configureMemoryProvider", {
        profileId: config.profileId,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        chatModel: config.chatModel,
        provider: "openai-compatible"
      }, { deadlineMs: 5_000, signal });
      if (!isObject(result) || result.configured !== true || result.profileId !== config.profileId) {
        throw new MemoryBackendError("invalid-config", "Memory normalization provider was not accepted.", false);
      }
      this.normalizationProfiles.set(config.petId, config.profileId);
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async memorize(turn: MemoryConversationTurn, signal: AbortSignal): Promise<MemoryMemorizeResponse> {
    assertMemoryConversationTurn(turn);
    const profileId = this.normalizationProfiles.get(turn.petId);
    if (!profileId) {
      throw new MemoryBackendError("invalid-config", "Memory normalization provider is not configured.", false);
    }
    try {
      const result = await this.options.client.request<MemoryMemorizeResponse>(
        "memorize",
        {
          indexPath: await this.indexPath(turn.petId),
          turn: {
            requestId: turn.requestId,
            userText: turn.userText,
            assistantReply: turn.assistantReply,
            occurredAt: turn.occurredAt,
            retainSource: turn.retainSource
          },
          profileId
        },
        { petId: turn.petId, deadlineMs: 60_000, signal }
      );
      assertMemoryMemorizeResponse(result, turn.petId);
      return result;
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async testNormalizationProvider(petId: string, signal: AbortSignal): Promise<void> {
    assertValidPetId(petId);
    const profileId = this.normalizationProfiles.get(petId);
    if (!profileId) {
      throw new MemoryBackendError("invalid-config", "Memory normalization provider is not configured.", false);
    }
    try {
      const result = await this.options.client.request(
        "testMemoryProvider",
        { indexPath: await this.indexPath(petId), profileId },
        { petId, deadlineMs: 60_000, signal }
      );
      if (!isObject(result) || result.ready !== true || Object.keys(result).some((key) => key !== "ready")) {
        throw new MemoryBackendError("internal", "Memory provider test returned an invalid response.", false);
      }
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async upsert(request: MemoryUpsertRequest, signal: AbortSignal): Promise<void> {
    assertValidPetId(request.petId);
    assertMemoryRecordInput(request.memory);
    if (request.memory.petId !== request.petId) {
      throw new MemoryBackendError("internal", "Memory upsert crossed pet boundaries.", false);
    }
    try {
      assertApplied(await this.options.client.request(
        "upsert",
        { indexPath: await this.indexPath(request.petId), memory: toSidecarMemory(request.memory as unknown as Record<string, unknown>) },
        { petId: request.petId, deadlineMs: 10_000, signal }
      ));
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async forget(request: MemoryForgetRequest, signal: AbortSignal): Promise<void> {
    assertValidPetId(request.petId);
    if (!request.memoryId || request.memoryId.length > 128) {
      throw new MemoryBackendError("internal", "Invalid memory ID.", false);
    }
    try {
      assertApplied(await this.options.client.request(
        "forget",
        { indexPath: await this.indexPath(request.petId), memoryId: request.memoryId },
        { petId: request.petId, deadlineMs: 10_000, signal }
      ));
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async rebuild(request: MemoryRebuildRequest, signal: AbortSignal): Promise<MemoryRebuildResponse> {
    assertValidPetId(request.petId);
    if (!/^staging-[A-Za-z0-9_-]{1,96}$/.test(request.targetId)) {
      throw new MemoryBackendError("internal", "Rebuild requires a staging target.", false);
    }
    const ids = new Set<string>();
    for (const record of request.records) {
      assertMemoryRecord(record);
      if (record.petId !== request.petId || record.deletedAt || ids.has(record.id)) {
        throw new MemoryBackendError("internal", "Rebuild snapshot is invalid.", false);
      }
      ids.add(record.id);
    }
    try {
      const indexPath = await this.indexPath(request.petId, request.targetId);
      const serializedSnapshot = request.records.map((record) =>
        toSidecarMemory(record as unknown as Record<string, unknown>)
      );
      const expectedContentFingerprint = authorityContentFingerprint(serializedSnapshot);
      const call = <T>(method: string, params: Record<string, unknown>, deadlineMs = 10_000) =>
        this.options.client.request<T>(method, { indexPath, ...params }, { petId: request.petId, deadlineMs, signal });
      const began = await call<unknown>("rebuildBegin", {});
      if (!isObject(began) || began.started !== true) {
        throw new MemoryBackendError("index-dirty", "The memU rebuild did not start.");
      }
      for (let index = 0; index < request.records.length; index += rebuildBatchSize) {
        const records = request.records.slice(index, index + rebuildBatchSize);
        const serializedRecords = serializedSnapshot.slice(index, index + rebuildBatchSize);
        const appended = await call<unknown>("rebuildAppend", { records: serializedRecords }, 60_000);
        if (!isObject(appended) || appended.appendedCount !== records.length) {
          throw new MemoryBackendError("index-dirty", "The memU rebuild batch was not confirmed.");
        }
      }
      const finished = assertRebuildFinish(
        await call("rebuildFinish", { expectedCount: request.records.length, expectedContentFingerprint }, 60_000),
        this.modelFingerprint
      );
      if (finished.indexedCount !== request.records.length || finished.contentFingerprint !== expectedContentFingerprint) {
        throw new MemoryBackendError("index-dirty", "The memU rebuild count is inconsistent.");
      }
      return { indexedCount: finished.indexedCount };
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async closePet(petId: string, signal: AbortSignal): Promise<void> {
    assertValidPetId(petId);
    try {
      const result = await this.options.client.request("closePet", {}, { petId, deadlineMs: 10_000, signal });
      if (!isObject(result) || typeof result.closed !== "boolean") {
        throw new MemoryBackendError("internal", "The memU adapter did not close its pet index.", false);
      }
    } catch (error) {
      throw mapSidecarError(error);
    }
  }

  async close(signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted) throw new MemoryBackendError("canceled", "Memory backend close was canceled.");
      await this.options.client.shutdown();
    } catch (error) {
      throw mapSidecarError(error);
    }
  }
}
