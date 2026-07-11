import { describe, expect, it, vi } from "vitest";
import {
  NeutralResetFrames,
  PreviewActionReplayGuard,
  waitForHostSize,
  type AnimationFrameScheduler
} from "./live2dCanvasLifecycle";

class FakeAnimationFrameScheduler implements AnimationFrameScheduler {
  private nextFrameId = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  readonly canceled: number[] = [];

  request(callback: FrameRequestCallback): number {
    const frameId = this.nextFrameId;
    this.nextFrameId += 1;
    this.callbacks.set(frameId, callback);
    return frameId;
  }

  cancel(frameId: number): void {
    this.canceled.push(frameId);
    this.callbacks.delete(frameId);
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }

  runNext(): void {
    const nextEntry = this.callbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;

    if (!nextEntry) {
      return;
    }

    const [frameId, callback] = nextEntry;
    this.callbacks.delete(frameId);
    callback(0);
  }
}

describe("Live2D canvas lifecycle helpers", () => {
  it("settles a pending host-size wait immediately when aborted", async () => {
    const host = { clientWidth: 0, clientHeight: 0 };
    const controller = new AbortController();
    const scheduler = new FakeAnimationFrameScheduler();
    const wait = waitForHostSize(host, controller.signal, scheduler);
    const settled = vi.fn();
    void wait.promise.then(settled);

    expect(scheduler.pendingCount).toBe(1);
    controller.abort();

    await expect(wait.promise).resolves.toBe(false);
    expect(settled).toHaveBeenCalledWith(false);
    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.canceled).toHaveLength(1);
  });

  it("settles successfully when the host receives a usable size", async () => {
    const host = { clientWidth: 0, clientHeight: 0 };
    const controller = new AbortController();
    const scheduler = new FakeAnimationFrameScheduler();
    const wait = waitForHostSize(host, controller.signal, scheduler);

    host.clientWidth = 320;
    host.clientHeight = 480;
    scheduler.runNext();

    await expect(wait.promise).resolves.toBe(true);
    expect(wait.ready).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("cancels the remaining neutral reset frames when a user action takes over", () => {
    const scheduler = new FakeAnimationFrameScheduler();
    const reset = vi.fn();
    const resets = new NeutralResetFrames(scheduler);
    resets.schedule(reset);

    scheduler.runNext();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount).toBe(1);

    resets.cancel();
    scheduler.runNext();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("replays an action first seen during loading exactly once after adopt", () => {
    const replayGuard = new PreviewActionReplayGuard();
    const apply = vi.fn();
    let adopted = false;
    const applyWhenReady = (actionId: number): void => {
      if (adopted && replayGuard.shouldApply(actionId)) {
        apply(actionId);
      }
    };

    applyWhenReady(42);
    adopted = true;
    applyWhenReady(42);
    applyWhenReady(42);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(42);
    expect(replayGuard.shouldApply(43)).toBe(true);
  });
});
