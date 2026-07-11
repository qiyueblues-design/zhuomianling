import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeferredLive2DAssetCache,
  fetchLive2DArrayBuffer,
  loadLive2DImage,
  raceLive2DLoadWithSignal
} from "./live2dResourceLoader";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Live2D resource cancellation", () => {
  it("passes the AbortSignal to the actual fetch and stops an in-flight request", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const request = fetchLive2DArrayBuffer("https://fixture.invalid/model.moc3", controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://fixture.invalid/model.moc3",
      { signal: controller.signal }
    );
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not start fetch when the load was already canceled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchLive2DArrayBuffer("https://fixture.invalid/model.moc3", controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels texture decoding and revokes its object URL", async () => {
    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn(() => "blob:fixture-texture");
    let imageInstance: { src: string } | undefined;

    class FakeImage {
      decoding = "auto";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private currentSrc = "";

      constructor() {
        imageInstance = this;
      }

      get src(): string {
        return this.currentSrc;
      }

      set src(value: string) {
        this.currentSrc = value;
      }
    }

    vi.stubGlobal("window", {
      URL: { createObjectURL, revokeObjectURL }
    });
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(["texture"]))
      })
    );
    const controller = new AbortController();
    const request = loadLive2DImage("https://fixture.invalid/texture.png", controller.signal);

    await vi.waitFor(() => expect(imageInstance?.src).toBe("blob:fixture-texture"));
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(imageInstance?.src).toBe("data:,");
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("stops waiting for shared bootstrap work without canceling the shared promise", async () => {
    let resolveBootstrap: ((value: string) => void) | undefined;
    const bootstrap = new Promise<string>((resolve) => {
      resolveBootstrap = resolve;
    });
    const controller = new AbortController();
    const localWait = raceLive2DLoadWithSignal(bootstrap, controller.signal);

    controller.abort();
    await expect(localWait).rejects.toMatchObject({ name: "AbortError" });

    resolveBootstrap?.("ready");
    await expect(bootstrap).resolves.toBe("ready");
  });
});

describe("deferred Live2D asset cache", () => {
  it("loads an action only when requested and coalesces concurrent requests", async () => {
    const cache = new DeferredLive2DAssetCache<object>();
    let resolveLoad: ((value: object) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          resolveLoad = resolve;
        })
    );

    expect(loader).not.toHaveBeenCalled();
    const first = cache.getOrLoad("Tap:0", loader);
    const second = cache.getOrLoad("Tap:0", loader);
    expect(loader).toHaveBeenCalledTimes(1);

    const asset = {};
    resolveLoad?.(asset);
    await expect(Promise.all([first, second])).resolves.toEqual([asset, asset]);
    await expect(cache.getOrLoad("Tap:0", loader)).resolves.toBe(asset);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("drops a failed pending load so the same action can be retried", async () => {
    const cache = new DeferredLive2DAssetCache<object>();
    const asset = {};
    const loader = vi
      .fn<() => Promise<object>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(asset);

    await expect(cache.getOrLoad("Idle:0", loader)).rejects.toThrow("temporary failure");
    await expect(cache.getOrLoad("Idle:0", loader)).resolves.toBe(asset);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("releases rather than adopting an asset that finishes after the runtime cache was cleared", async () => {
    const cache = new DeferredLive2DAssetCache<object>();
    let resolveLoad: ((value: object) => void) | undefined;
    const release = vi.fn();
    const pending = cache.getOrLoad(
      "Tap:0",
      () =>
        new Promise<object>((resolve) => {
          resolveLoad = resolve;
      })
    );

    const lateAsset = {};
    cache.clear(release);
    resolveLoad?.(lateAsset);
    await expect(pending).resolves.toBeUndefined();

    expect(cache.get("Tap:0")).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(lateAsset);
  });

  it("releases one aliased asset only once when clear races multiple pending keys", async () => {
    const cache = new DeferredLive2DAssetCache<object>();
    const resolvers: Array<(value: object) => void> = [];
    const release = vi.fn();
    const first = cache.getOrLoad(
      "name:smile",
      () =>
        new Promise<object>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const second = cache.getOrLoad(
      "index:0",
      () =>
        new Promise<object>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const sharedAsset = {};

    cache.clear(release);
    resolvers.forEach((resolve) => resolve(sharedAsset));

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(sharedAsset);
  });
});
