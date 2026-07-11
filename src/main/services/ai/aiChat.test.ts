import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});

describe("AI chat stream lifecycle", () => {
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
  });
});
