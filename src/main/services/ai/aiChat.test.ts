import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxAiReplyTextCharacters } from "../../../shared/aiReply";

const recallMock = vi.hoisted(() => vi.fn());
const captureMock = vi.hoisted(() => vi.fn());
const aiSettingsMock = vi.hoisted(() => ({
  config: {
    petId: "pet-a",
    baseUrl: "https://ai.example.com/v1",
    model: "model-a",
    apiKey: "secret",
    outputCapability: undefined as
      | {
          baseUrl: string;
          model: string;
          mode: "json-schema" | "json-object" | "plain-text";
          streaming: boolean;
          confidence: "tested" | "fallback";
          checkedAt: string;
        }
      | undefined
  },
  record: vi.fn(async () => undefined)
}));

vi.mock("./aiSettings", () => ({
  recordAiOutputCapability: aiSettingsMock.record,
  getAiConnectionConfig: vi.fn(async (petId: string) => ({ ...aiSettingsMock.config, petId }))
}));

vi.mock("../config/secureConfigStore", () => ({
  SecureStorageCorruptedError: class SecureStorageCorruptedError extends Error {},
  SecureStorageUnavailableError: class SecureStorageUnavailableError extends Error {}
}));

vi.mock("../memory/memoryRecall", () => ({
  recallMemoryForAi: recallMock
}));

vi.mock("../memory/memoryCapture", () => ({
  captureCompletedAiTurn: captureMock
}));

class FakeWebContents extends EventEmitter {
  destroyed = false;
  readonly send = vi.fn();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroyOwner(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }

  crashOwner(): void {
    this.emit("render-process-gone");
  }
}

class ControlledReader {
  readonly cancel = vi.fn(async () => undefined);
  private readonly pending: Array<
    (result: ReadableStreamReadResult<Uint8Array>) => void
  > = [];
  private readonly queued: Array<ReadableStreamReadResult<Uint8Array>> = [];

  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const queuedResult = this.queued.shift();

    if (queuedResult) {
      return Promise.resolve(queuedResult);
    }

    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  push(text: string): void {
    this.resolve({
      done: false,
      value: new TextEncoder().encode(text)
    });
  }

  end(): void {
    this.resolve({
      done: true,
      value: undefined
    });
  }

  private resolve(result: ReadableStreamReadResult<Uint8Array>): void {
    const resolve = this.pending.shift();

    if (resolve) {
      resolve(result);
      return;
    }

    this.queued.push(result);
  }
}

function asWebContents(owner: FakeWebContents): WebContents {
  return owner as unknown as WebContents;
}

function createRequest(requestId: string) {
  return {
    petId: "pet-a",
    requestId,
    messages: [{ role: "user" as const, content: "hello" }]
  };
}

function createStreamingResponse(reader: ControlledReader): Response {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => reader
    }
  } as unknown as Response;
}

function createSseDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function createAbortablePendingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;

      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    })
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  recallMock.mockReset();
  recallMock.mockResolvedValue({ recalledCount: 0 });
  captureMock.mockReset();
  captureMock.mockResolvedValue(true);
  aiSettingsMock.config.outputCapability = undefined;
  aiSettingsMock.record.mockClear();
});

describe("AI chat stream lifecycle", () => {
  it("falls back from JSON Schema to JSON Object and records the working capability", async () => {
    aiSettingsMock.config.outputCapability = {
      baseUrl: "https://ai.example.com/v1",
      model: "model-a",
      mode: "json-schema",
      streaming: true,
      confidence: "tested",
      checkedAt: "2026-07-15T00:00:00.000Z"
    };
    const reader = new ControlledReader();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unsupported schema", { status: 400 }))
      .mockResolvedValueOnce(createStreamingResponse(reader));
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(
      asWebContents(owner),
      createRequest("request-schema-fallback"),
      "stream-schema-fallback"
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).response_format.type)
      .toBe("json_schema");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).response_format.type)
      .toBe("json_object");
    reader.push(createSseDelta('{"reply":"compatible"}'));
    reader.end();
    await pending;

    expect(aiSettingsMock.record).toHaveBeenCalledWith(
      "pet-a",
      "https://ai.example.com/v1",
      "model-a",
      expect.objectContaining({ mode: "json-object", streaming: true, confidence: "tested" })
    );
  });

  it("uses a tested non-streaming capability without emitting unsafe chunks", async () => {
    aiSettingsMock.config.outputCapability = {
      baseUrl: "https://ai.example.com/v1",
      model: "model-a",
      mode: "json-schema",
      streaming: false,
      confidence: "tested",
      checkedAt: "2026-07-15T00:00:00.000Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"reply":"完整回复","voiceText":"最终语音"}' } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();

    await startAiChatStream(
      asWebContents(owner),
      createRequest("request-non-stream"),
      "stream-non-stream"
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).stream).toBe(false);
    const events = owner.send.mock.calls.map((call) => call[1]);
    expect(events.some((event) => event?.type === "chunk")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      content: "完整回复",
      voiceText: "最终语音"
    }));
    expect(captureMock).toHaveBeenCalledWith(expect.objectContaining({
      assistantReply: "完整回复"
    }));
  });

  it("does not retry authentication, rate-limit, or server failures as format errors", async () => {
    for (const status of [401, 429, 500]) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: `failure-${status}` } }), {
          status,
          headers: { "Content-Type": "application/json" }
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      const { startAiChatStream } = await import("./aiChat");
      await startAiChatStream(
        asWebContents(new FakeWebContents()),
        createRequest(`request-status-${status}`),
        `stream-status-${status}`
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("emits done before queuing only the current user text and parsed visible reply", async () => {
    const reader = new ControlledReader();
    const fetchMock = vi.fn().mockResolvedValue(createStreamingResponse(reader));
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(asWebContents(owner), {
      petId: "pet-a",
      requestId: "request-capture",
      messages: [
        { role: "system", content: "persona-secret" },
        { role: "user", content: "older-user" },
        { role: "assistant", content: "older-assistant" },
        { role: "user", content: "current-user" }
      ]
    }, "stream-capture");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    reader.push('data: {"choices":[{"delta":{"content":"{\\"reply\\":\\"visible-reply\\",\\"emotion\\":\\"happy\\",\\"voiceText\\":\\"voice-only\\"}"}}]}\n\n');
    reader.end();
    await pending;
    const doneOrder = owner.send.mock.invocationCallOrder.find((_, index) =>
      owner.send.mock.calls[index][1]?.type === "done"
    );
    expect(captureMock).toHaveBeenCalledWith(expect.objectContaining({
      petId: "pet-a",
      requestId: "request-capture",
      userText: "current-user",
      assistantReply: "visible-reply",
      occurredAt: expect.any(String)
    }));
    expect(doneOrder).toBeLessThan(captureMock.mock.invocationCallOrder[0]);
    expect(JSON.stringify(captureMock.mock.calls[0][0])).not.toContain("persona-secret");
    expect(JSON.stringify(captureMock.mock.calls[0][0])).not.toContain("voice-only");
  });

  it("does not capture partial structured output", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(asWebContents(owner), createRequest("request-partial"), "stream-partial");
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());
    reader.push('data: {"choices":[{"delta":{"content":"{\\"reply\\":\\"partial\\""}}]}\n\n');
    reader.end();
    await pending;
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("captures only the final visible reply from a Grok-style reasoning and repeated JSON response", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(
      asWebContents(owner),
      createRequest("request-grok-style"),
      "stream-grok-style"
    );
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());
    reader.push(createSseDelta("<think>内部推理不能进入记忆</think>\n"));
    reader.push(
      createSseDelta(
        '{"reply":"草稿回复"}\n{"reply":"最终可见回复","emotion":"happy","voiceText":"最终语音"}'
      )
    );
    reader.end();
    await pending;

    expect(captureMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-grok-style",
      assistantReply: "最终可见回复"
    }));
    expect(JSON.stringify(captureMock.mock.calls[0][0])).not.toContain("内部推理");
    expect(JSON.stringify(captureMock.mock.calls[0][0])).not.toContain("最终语音");
    const sentEvents = owner.send.mock.calls.map((call) => call[1]);
    expect(JSON.stringify(sentEvents)).not.toContain("内部推理");
    expect(JSON.stringify(sentEvents)).not.toContain("<think>");
    expect(JSON.stringify(sentEvents)).not.toContain('\\"reply\\"');
    expect(sentEvents).toContainEqual(expect.objectContaining({
      type: "done",
      content: "最终可见回复",
      voiceText: "最终语音",
      emotion: "happy",
      quality: "structured"
    }));
  });

  it("normalizes multiple Grok think blocks, independent reasoning fields, and split Markdown JSON", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(
      asWebContents(owner),
      createRequest("request-grok-multi-think"),
      "stream-grok-multi-think"
    );
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());

    reader.push(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hidden-reasoning-content" } }] })}\n\n`
    );
    reader.push(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "hidden-reasoning" } }] })}\n\n`
    );
    reader.push(
      `data: ${JSON.stringify({ choices: [{ message: { reasoning: "hidden-message-reasoning" } }] })}\n\n`
    );
    reader.push(createSseDelta("<think>第一段内部推理</think>\n<think>第二段"));
    reader.push(createSseDelta('内部推理</think>\n```json\n{"reply":"分'));
    reader.push(createSseDelta('片安全回复","voiceText":"安全语音"}\n```'));
    reader.end();
    await pending;

    const events = owner.send.mock.calls.map((call) => call[1]);
    const serializedEvents = JSON.stringify(events);
    for (const forbidden of [
      "hidden-reasoning-content",
      "hidden-reasoning",
      "hidden-message-reasoning",
      "第一段内部推理",
      "第二段内部推理",
      "<think>",
      "```json",
      '\\"reply\\"'
    ]) {
      expect(serializedEvents).not.toContain(forbidden);
    }
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      content: "分片安全回复",
      voiceText: "安全语音",
      quality: "structured"
    }));
    expect(captureMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-grok-multi-think",
      assistantReply: "分片安全回复"
    }));
    const serializedMemory = JSON.stringify(captureMock.mock.calls[0]?.[0]);
    expect(serializedMemory).not.toContain("reasoning");
    expect(serializedMemory).not.toContain("内部推理");
    expect(serializedMemory).not.toContain("安全语音");
  });

  it("never rewrites an already emitted reply when later JSON changes it", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(
      asWebContents(owner),
      createRequest("request-rewritten-json"),
      "stream-rewritten-json"
    );
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());
    reader.push(createSseDelta('{"reply":"先显示的回复"}'));
    reader.push(createSseDelta('\n{"reply":"后来改写的回复","voiceText":"改写语音"}'));
    reader.end();
    await pending;

    const sentEvents = owner.send.mock.calls.map((call) => call[1]);
    expect(sentEvents).toContainEqual(expect.objectContaining({
      type: "chunk",
      content: "先显示的回复"
    }));
    expect(sentEvents).toContainEqual(expect.objectContaining({
      type: "done",
      content: "先显示的回复",
      quality: "recovered"
    }));
    expect(JSON.stringify(sentEvents)).not.toContain("后来改写的回复");
    expect(JSON.stringify(sentEvents)).not.toContain("改写语音");
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("ignores provider reasoning fields and emits only safe visible content", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(
      asWebContents(owner),
      createRequest("request-reasoning-field"),
      "stream-reasoning-field"
    );
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());
    reader.push(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hidden-chain" } }] })}\n\n`
    );
    reader.push(createSseDelta('{"reply":"safe-answer"}'));
    reader.end();
    await pending;

    const sentEvents = owner.send.mock.calls.map((call) => call[1]);
    expect(JSON.stringify(sentEvents)).not.toContain("hidden-chain");
    expect(sentEvents).toContainEqual(expect.objectContaining({
      type: "chunk",
      content: "safe-answer"
    }));
    expect(sentEvents).toContainEqual(expect.objectContaining({
      type: "done",
      content: "safe-answer"
    }));
  });

  it("processes a final SSE data line without a trailing newline", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(
      asWebContents(owner),
      createRequest("request-final-line"),
      "stream-final-line"
    );
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());
    reader.push(createSseDelta('{"reply":"no-newline"}').trimEnd());
    reader.end();
    await pending;

    expect(owner.send).toHaveBeenCalledWith(
      "ai-chat:stream-event",
      expect.objectContaining({ type: "done", content: "no-newline" })
    );
  });

  it("cancels an oversized visible stream before sending the unsafe chunk", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(
      asWebContents(owner),
      createRequest("request-oversized"),
      "stream-oversized"
    );
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());
    reader.push(createSseDelta("x".repeat(maxAiReplyTextCharacters + 1)));
    await pending;

    expect(reader.cancel).toHaveBeenCalled();
    expect(owner.send).toHaveBeenCalledWith(
      "ai-chat:stream-event",
      expect.objectContaining({
        type: "error",
        message: "AI 返回内容过长，已停止本次回复。"
      })
    );
    expect(owner.send.mock.calls.some((call) => call[1]?.type === "chunk")).toBe(false);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("rejects a reasoning-only final response instead of completing or capturing it", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(
      asWebContents(owner),
      createRequest("request-reasoning-only"),
      "stream-reasoning-only"
    );
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());
    reader.push(createSseDelta("<think>只有内部推理，没有最终回答</think>"));
    reader.end();
    await pending;

    expect(owner.send).toHaveBeenCalledWith(
      "ai-chat:stream-event",
      expect.objectContaining({
        type: "error",
        ok: false,
        message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
      })
    );
    expect(owner.send.mock.calls.some((call) => call[1]?.type === "done")).toBe(false);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("captures a complete plain reply", async () => {
    const reader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(reader)));
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(asWebContents(owner), createRequest("request-plain"), "stream-plain");
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalled());
    reader.push('data: {"choices":[{"delta":{"content":"plain visible reply"}}]}\n\n');
    reader.end();
    await pending;
    expect(captureMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-plain",
      userText: "hello",
      assistantReply: "plain visible reply"
    }));
  });

  it("does not capture an empty response, HTTP failure, or interrupted stream", async () => {
    const { startAiChatStream } = await import("./aiChat");

    const emptyReader = new ControlledReader();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createStreamingResponse(emptyReader)));
    const empty = startAiChatStream(
      asWebContents(new FakeWebContents()),
      createRequest("request-empty"),
      "stream-empty"
    );
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalledTimes(1));
    emptyReader.end();
    await empty;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: null,
      json: vi.fn(async () => ({ error: { message: "unavailable" } }))
    } as unknown as Response));
    await startAiChatStream(
      asWebContents(new FakeWebContents()),
      createRequest("request-http-error"),
      "stream-http-error"
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: vi.fn(async () => { throw new Error("stream interrupted"); }),
          cancel: vi.fn(async () => undefined)
        })
      }
    } as unknown as Response));
    await startAiChatStream(
      asWebContents(new FakeWebContents()),
      createRequest("request-interrupted"),
      "stream-interrupted"
    );

    expect(captureMock).not.toHaveBeenCalled();
  });

  it("keeps the normalized request body unchanged when recall returns no context", async () => {
    const reader = new ControlledReader();
    const fetchMock = vi.fn().mockResolvedValue(createStreamingResponse(reader));
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(asWebContents(owner), {
      petId: "pet-a",
      requestId: "request-disabled",
      messages: [
        { role: "user", content: " old " },
        { role: "system", content: " persona " },
        { role: "user", content: " hello " }
      ]
    }, "stream-disabled");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "old" },
      { role: "user", content: "hello" }
    ]);
    expect(body).toMatchObject({
      model: "model-a",
      temperature: 0.8,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      stream: true
    });
    reader.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    reader.end();
    await pending;
  });

  it("injects recalled memory after persona systems and before conversation", async () => {
    recallMock.mockResolvedValue({ context: "untrusted-memory-context", recalledCount: 1 });
    const reader = new ControlledReader();
    const fetchMock = vi.fn().mockResolvedValue(createStreamingResponse(reader));
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(asWebContents(owner), {
      petId: "pet-a",
      requestId: "request-memory",
      messages: [
        { role: "system", content: "persona" },
        { role: "user", content: "hello" }
      ]
    }, "stream-memory");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages).toEqual([
      { role: "system", content: "persona" },
      { role: "system", content: "untrusted-memory-context" },
      { role: "user", content: "hello" }
    ]);
    reader.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    reader.end();
    await pending;
  });

  it("falls back to the original body when recall unexpectedly throws", async () => {
    recallMock.mockRejectedValue(new Error("recall failed"));
    const reader = new ControlledReader();
    const fetchMock = vi.fn().mockResolvedValue(createStreamingResponse(reader));
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(asWebContents(owner), createRequest("request-fallback"), "stream-fallback");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    reader.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    reader.end();
    await pending;
  });

  it("cancels recall with the stream lifecycle and never starts AI fetch", async () => {
    recallMock.mockImplementation((_petId, _messages, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { cancelAiChatStreams, startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const pending = startAiChatStream(asWebContents(owner), createRequest("request-recall-cancel"), "stream-recall-cancel");
    await vi.waitFor(() => expect(recallMock).toHaveBeenCalledTimes(1));
    expect(cancelAiChatStreams(asWebContents(owner), { requestId: "request-recall-cancel" }).canceled).toBe(1);
    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("aborts and reports a connection timeout", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const streamPromise = startAiChatStream(
      asWebContents(owner),
      createRequest("request-timeout"),
      "stream-timeout",
      {
        connectTimeoutMs: 10,
        idleTimeoutMs: 100,
        totalTimeoutMs: 200
      }
    );

    await expect(streamPromise).resolves.toBeUndefined();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(owner.send).toHaveBeenCalledWith(
      "ai-chat:stream-event",
      expect.objectContaining({
        requestId: "request-timeout",
        type: "error",
        reason: "connect-timeout"
      })
    );
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("cancels only streams owned by the requesting renderer", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { cancelAiChatStreams, startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const otherOwner = new FakeWebContents();
    const streamPromise = startAiChatStream(
      asWebContents(owner),
      createRequest("request-cancel"),
      "stream-cancel"
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      cancelAiChatStreams(asWebContents(otherOwner), { requestId: "request-cancel" }).canceled
    ).toBe(0);
    expect(
      cancelAiChatStreams(asWebContents(owner), { requestId: "request-cancel" }).canceled
    ).toBe(1);
    await expect(streamPromise).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("aborts every owned stream when its WebContents is destroyed", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const streamPromise = startAiChatStream(
      asWebContents(owner),
      createRequest("request-owner"),
      "stream-owner"
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    owner.destroyOwner();
    await expect(streamPromise).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(owner.send).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("aborts every owned stream when its renderer process exits", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const streamPromise = startAiChatStream(
      asWebContents(owner),
      createRequest("request-crash"),
      "stream-crash"
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    owner.crashOwner();
    await expect(streamPromise).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(owner.send).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("ignores a late chunk from a stream replaced by a newer request", async () => {
    const oldReader = new ControlledReader();
    const newReader = new ControlledReader();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createStreamingResponse(oldReader))
      .mockResolvedValueOnce(createStreamingResponse(newReader));
    vi.stubGlobal("fetch", fetchMock);
    const { startAiChatStream } = await import("./aiChat");
    const owner = new FakeWebContents();
    const oldPromise = startAiChatStream(
      asWebContents(owner),
      createRequest("request-old"),
      "stream-old"
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newPromise = startAiChatStream(
      asWebContents(owner),
      createRequest("request-new"),
      "stream-new"
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    oldReader.push('data: {"choices":[{"delta":{"content":"old"}}]}\n\n');
    newReader.push('data: {"choices":[{"delta":{"content":"new"}}]}\n\n');
    newReader.end();

    await expect(oldPromise).resolves.toBeUndefined();
    await expect(newPromise).resolves.toBeUndefined();
    const sentEvents = owner.send.mock.calls.map((call) => call[1]);
    expect(sentEvents).toContainEqual(
      expect.objectContaining({ requestId: "request-new", type: "chunk", content: "new" })
    );
    expect(sentEvents).not.toContainEqual(
      expect.objectContaining({ requestId: "request-old", type: "chunk" })
    );
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-new",
      assistantReply: "new"
    }));
  });
});

describe("AI chat final response normalization", () => {
  it("returns only the normalized visible fields from mixed provider content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        choices: [{
          message: {
            content: '<think>隐藏推理</think>\n```json\n{"reply":"可见回复","voiceText":"可见语音"}\n```'
          }
        }]
      }))
    } as unknown as Response));
    const { sendAiChat } = await import("./aiChat");

    await expect(sendAiChat({ petId: "pet-a", messages: [{ role: "user", content: "hello" }] }))
      .resolves.toMatchObject({
        ok: true,
        content: "可见回复",
        voiceText: "可见语音"
      });
  });

  it("returns a controlled error for an unrecognizable final response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        choices: [{ message: { content: "<think>只有推理</think>" } }]
      }))
    } as unknown as Response));
    const { sendAiChat } = await import("./aiChat");

    await expect(sendAiChat({ petId: "pet-a", messages: [{ role: "user", content: "hello" }] }))
      .resolves.toEqual({
        ok: false,
        message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
      });
  });
});
