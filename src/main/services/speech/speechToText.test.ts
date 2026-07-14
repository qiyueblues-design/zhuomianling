import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataPath: ""
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath
  }
}));

vi.mock("../config/secureConfigStore", () => ({
  getSecureString: vi.fn(async () =>
    JSON.stringify({
      appId: "1000000000",
      secretId: "test-secret-id",
      secretKey: "test-secret-key"
    })
  ),
  setSecureString: vi.fn()
}));

type SocketEvent = { data?: string | ArrayBuffer };
type SocketListener = (event: SocketEvent) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Set<SocketListener>>();
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string | Buffer): void {
    this.sent.push(String(value));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  completeHandshake(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("message", { data: JSON.stringify({ code: 0 }) });
  }

  private emit(type: string, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

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
}

function asWebContents(owner: FakeWebContents): WebContents {
  return owner as unknown as WebContents;
}

async function waitForSocket(index = 0): Promise<FakeWebSocket> {
  await vi.waitFor(() => {
    expect(FakeWebSocket.instances.length).toBeGreaterThan(index);
  });
  return FakeWebSocket.instances[index];
}

async function waitForSessionSocket(sessionId: string): Promise<FakeWebSocket> {
  await vi.waitFor(() => {
    expect(FakeWebSocket.instances.some((socket) =>
      new URL(socket.url).searchParams.get("voice_id") === sessionId
    )).toBe(true);
  });
  return FakeWebSocket.instances.find((socket) =>
    new URL(socket.url).searchParams.get("voice_id") === sessionId
  )!;
}

beforeEach(() => {
  electronMock.userDataPath = path.join(os.tmpdir(), `zhuomianling-speech-${Date.now()}`);
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.resetModules();
});

describe("speech stream lifecycle", () => {
  it("rejects unsafe renderer-provided session IDs before opening a socket", async () => {
    const { startSpeechStream } = await import("./speechToText");
    const owner = new FakeWebContents();

    const result = await startSpeechStream(asWebContents(owner), {
      petId: "pet-a",
      sessionId: "../unsafe"
    });

    expect(result.ok).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("honors a stop that arrives before start is registered", async () => {
    const { startSpeechStream, stopSpeechStream } = await import("./speechToText");
    const sessionId = "desktop-pet-pending-0001";
    const owner = new FakeWebContents();

    stopSpeechStream({ sessionId });
    const result = await startSpeechStream(asWebContents(owner), {
      petId: "pet-a",
      sessionId
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("取消");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("closes a CONNECTING socket immediately when stopped", async () => {
    const { startSpeechStream, stopSpeechStream } = await import("./speechToText");
    const sessionId = "desktop-pet-connecting-0001";
    const owner = new FakeWebContents();
    const startPromise = startSpeechStream(asWebContents(owner), {
      petId: "pet-a",
      sessionId
    });
    const socket = await waitForSocket();

    stopSpeechStream({ sessionId });

    expect(socket.closeCalls).toBe(1);
    await expect(startPromise).resolves.toMatchObject({ ok: false });
  });

  it("keeps normal finalization graceful, then force-closes every socket when its owner exits", async () => {
    const { startSpeechStream, stopSpeechStream } = await import("./speechToText");
    const owner = new FakeWebContents();
    const firstSessionId = "desktop-pet-owner-00000001";
    const secondSessionId = "desktop-pet-owner-00000002";
    const firstStart = startSpeechStream(asWebContents(owner), {
      petId: "pet-a",
      sessionId: firstSessionId
    });
    const secondStart = startSpeechStream(asWebContents(owner), {
      petId: "pet-a",
      sessionId: secondSessionId
    });
    const firstSocket = await waitForSessionSocket(firstSessionId);
    const secondSocket = await waitForSessionSocket(secondSessionId);
    firstSocket.completeHandshake();
    secondSocket.completeHandshake();
    await expect(firstStart).resolves.toMatchObject({ ok: true, sessionId: firstSessionId });
    await expect(secondStart).resolves.toMatchObject({ ok: true, sessionId: secondSessionId });

    stopSpeechStream({ sessionId: firstSessionId });
    expect(firstSocket.sent).toContain(JSON.stringify({ type: "end" }));
    expect(firstSocket.closeCalls).toBe(0);

    owner.destroyOwner();

    expect(firstSocket.closeCalls).toBe(1);
    expect(secondSocket.closeCalls).toBe(1);
  });
});
