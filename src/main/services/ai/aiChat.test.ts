import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recallMock = vi.hoisted(() => vi.fn());
const captureMock = vi.hoisted(() => vi.fn());

vi.mock("./aiSettings", () => ({
  getAiConnectionConfig: vi.fn(async (petId: string) => ({
    petId,
    baseUrl: "https://ai.example.com/v1",
    model: "model-a",
    apiKey: "secret"
  }))
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
});

describe("AI chat stream lifecycle", () => {
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
