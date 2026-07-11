export interface AnimationFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(frameId: number): void;
}

export interface HostSizeTarget {
  clientWidth: number;
  clientHeight: number;
}

export interface HostSizeWaitResult {
  ready: boolean;
  cancel(): void;
  promise: Promise<boolean>;
}

export function waitForHostSize(
  host: HostSizeTarget,
  signal: AbortSignal,
  scheduler: AnimationFrameScheduler
): HostSizeWaitResult {
  let ready = false;
  let settled = false;
  let frameId: number | undefined;
  let resolveWait: (value: boolean) => void = () => undefined;

  const cleanup = (): void => {
    if (frameId !== undefined) {
      scheduler.cancel(frameId);
      frameId = undefined;
    }
    signal.removeEventListener("abort", handleAbort);
  };

  const settle = (value: boolean): void => {
    if (settled) {
      return;
    }

    settled = true;
    ready = value;
    cleanup();
    resolveWait(value);
  };

  const handleAbort = (): void => {
    settle(false);
  };

  const checkSize = (): void => {
    frameId = undefined;

    if (signal.aborted) {
      settle(false);
      return;
    }

    if (host.clientWidth > 0 && host.clientHeight > 0) {
      settle(true);
      return;
    }

    frameId = scheduler.request(checkSize);
  };

  const promise = new Promise<boolean>((resolve) => {
    resolveWait = resolve;

    if (signal.aborted) {
      settle(false);
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
    checkSize();
  });

  return {
    get ready() {
      return ready;
    },
    cancel: handleAbort,
    promise
  };
}

export class PreviewActionReplayGuard {
  private appliedActionId: number | undefined;

  shouldApply(actionId: number | undefined): boolean {
    if (actionId === undefined || actionId === this.appliedActionId) {
      return false;
    }

    this.appliedActionId = actionId;
    return true;
  }
}

export class NeutralResetFrames {
  private frameIds: number[] = [];

  constructor(private readonly scheduler: AnimationFrameScheduler) {}

  cancel(): void {
    for (const frameId of this.frameIds) {
      this.scheduler.cancel(frameId);
    }
    this.frameIds = [];
  }

  schedule(reset: () => void, count = 3): void {
    this.cancel();

    const scheduleNext = (remaining: number): void => {
      if (remaining <= 0) {
        return;
      }

      const frameId = this.scheduler.request(() => {
        this.frameIds = this.frameIds.filter((candidate) => candidate !== frameId);
        reset();
        scheduleNext(remaining - 1);
      });
      this.frameIds.push(frameId);
    };

    scheduleNext(count);
  }
}
