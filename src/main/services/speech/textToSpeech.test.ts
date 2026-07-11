import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataPath: ""
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath
  }
}));

class FakeWebContents extends EventEmitter {
  destroyed = false;

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

function asWebContents(owner: FakeWebContents): WebContents {
  return owner as unknown as WebContents;
}

function createAbortablePendingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    })
  );
}

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-tts-"));
  electronMock.userDataPath = temporaryDirectory;
  await Promise.all(
    ["pet-a", "pet-b"].map(async (petId) => {
      const petDirectory = path.join(temporaryDirectory, "pets", petId);
      await fs.mkdir(petDirectory, { recursive: true });
      await fs.writeFile(
        path.join(petDirectory, "pet.local.json"),
        JSON.stringify({
          voiceModelSettings: {
            enabled: true,
            connected: true,
            referenceAudioPath: "C:/voice/reference.wav",
            referenceText: "参考文本",
            referenceLanguage: "zh",
            language: "zh"
          }
        }),
        "utf8"
      );
    })
  );
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("text-to-speech request lifecycle", () => {
  it("stop aborts every active synthesis request for the selected pet", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText, stopSpeechPlayback } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const firstSpeakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "speech-cancel-1",
      text: "你好"
    });
    const secondSpeakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "speech-cancel-2",
      text: "世界"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(stopSpeechPlayback(asWebContents(owner), { petId: "pet-a" }).canceled).toBe(2);
    await expect(firstSpeakPromise).resolves.toMatchObject({
      ok: false,
      requestId: "speech-cancel-1",
      code: "CANCELED"
    });
    await expect(secondSpeakPromise).resolves.toMatchObject({
      ok: false,
      requestId: "speech-cancel-2",
      code: "CANCELED"
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect((fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("aborts synthesis when its timeout expires", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");
    const owner = new FakeWebContents();

    await expect(
      speakText(
        asWebContents(owner),
        {
          petId: "pet-a",
          requestId: "speech-timeout",
          text: "你好"
        },
        10
      )
    ).resolves.toMatchObject({
      ok: false,
      requestId: "speech-timeout",
      code: "TIMEOUT"
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("aborts synthesis when the owning renderer is destroyed", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const speakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "speech-owner",
      text: "你好"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    owner.destroyOwner();
    await expect(speakPromise).resolves.toMatchObject({
      ok: false,
      requestId: "speech-owner",
      code: "CANCELED"
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("aborts synthesis when the owning renderer process exits", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const speakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "speech-crash",
      text: "你好"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    owner.crashOwner();
    await expect(speakPromise).resolves.toMatchObject({
      ok: false,
      requestId: "speech-crash",
      code: "CANCELED"
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("keeps the same request ID isolated across different pets", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText, stopSpeechPlayback } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const firstSpeakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "shared-request",
      text: "宠物 A"
    });
    const secondSpeakPromise = speakText(asWebContents(owner), {
      petId: "pet-b",
      requestId: "shared-request",
      text: "宠物 B"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      stopSpeechPlayback(asWebContents(owner), {
        petId: "pet-a",
        requestId: "shared-request"
      }).canceled
    ).toBe(1);
    await expect(firstSpeakPromise).resolves.toMatchObject({ code: "CANCELED" });

    const callsByText = new Map(
      fetchMock.mock.calls.map(([, init]) => [
        (JSON.parse(String(init?.body)) as { text: string }).text,
        init?.signal as AbortSignal
      ])
    );
    expect(callsByText.get("宠物 A")?.aborted).toBe(true);
    expect(callsByText.get("宠物 B")?.aborted).toBe(false);

    expect(
      stopSpeechPlayback(asWebContents(owner), {
        petId: "pet-b",
        requestId: "shared-request"
      }).canceled
    ).toBe(1);
    await expect(secondSpeakPromise).resolves.toMatchObject({ code: "CANCELED" });
  });
});
