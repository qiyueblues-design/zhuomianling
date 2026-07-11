export interface LoadedLive2DImage {
  image: HTMLImageElement;
  objectUrl?: string;
}

export function createLive2DAbortError(): DOMException {
  return new DOMException("Live2D resource load was canceled.", "AbortError");
}

export function isLive2DLoadAborted(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

export function throwIfLive2DLoadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason instanceof Error ? signal.reason : createLive2DAbortError();
}

/** Stops waiting for shared runtime/bootstrap work without canceling it for other model instances. */
export function raceLive2DLoadWithSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return operation;
  }

  try {
    throwIfLive2DLoadAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", handleAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = (): void => {
      settle(() => reject(createLive2DAbortError()));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    );
  });
}

async function fetchLive2DResponse(url: string, signal?: AbortSignal): Promise<Response> {
  throwIfLive2DLoadAborted(signal);
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }

  return response;
}

export async function fetchLive2DArrayBuffer(
  url: string,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetchLive2DResponse(url, signal);
  const buffer = await response.arrayBuffer();
  throwIfLive2DLoadAborted(signal);
  return buffer;
}

export async function fetchLive2DJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchLive2DResponse(url, signal);
  const value = (await response.json()) as T;
  throwIfLive2DLoadAborted(signal);
  return value;
}

export async function fetchLive2DText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchLive2DResponse(url, signal);
  const value = await response.text();
  throwIfLive2DLoadAborted(signal);
  return value;
}

function decodeImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", handleAbort);
      image.onload = null;
      image.onerror = null;
    };
    const settle = (operation: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      operation();
    };
    const handleAbort = (): void => {
      settle(() => {
        image.src = "data:,";
        reject(createLive2DAbortError());
      });
    };

    image.decoding = "async";
    image.onload = () => settle(() => resolve(image));
    image.onerror = () =>
      settle(() => reject(new Error(`Failed to decode Live2D texture: ${url}`)));
    signal?.addEventListener("abort", handleAbort, { once: true });

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    image.src = url;
  });
}

export async function loadLive2DImage(
  url: string,
  signal?: AbortSignal
): Promise<LoadedLive2DImage> {
  const response = await fetchLive2DResponse(url, signal);
  const blob = await response.blob();
  throwIfLive2DLoadAborted(signal);
  const objectUrl = window.URL.createObjectURL(blob);

  try {
    return {
      image: await decodeImage(objectUrl, signal),
      objectUrl
    };
  } catch (error) {
    window.URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

export function loadLive2DElementImage(
  url: string,
  signal?: AbortSignal
): Promise<HTMLImageElement> {
  return decodeImage(url, signal);
}

export class DeferredLive2DAssetCache<T> {
  private readonly resolved = new Map<string, T>();
  private readonly pending = new Map<string, Promise<T | undefined>>();
  private readonly pendingCountByGeneration = new Map<number, number>();
  private readonly retiredGenerationReleasers = new Map<
    number,
    { release: (value: T) => void; releasedValues: Set<T> }
  >();
  private generation = 0;

  get(key: string): T | undefined {
    return this.resolved.get(key);
  }

  set(key: string, value: T): void {
    this.resolved.set(key, value);
  }

  setAliases(keys: Iterable<string>, value: T): void {
    for (const key of keys) {
      this.resolved.set(key, value);
    }
  }

  getOrLoad(key: string, loader: () => Promise<T | undefined>): Promise<T | undefined> {
    const resolved = this.resolved.get(key);

    if (resolved !== undefined) {
      return Promise.resolve(resolved);
    }

    const pending = this.pending.get(key);

    if (pending) {
      return pending;
    }

    const loadGeneration = this.generation;
    this.pendingCountByGeneration.set(
      loadGeneration,
      (this.pendingCountByGeneration.get(loadGeneration) ?? 0) + 1
    );
    const load = loader()
      .then((value) => {
        if (value === undefined) {
          return undefined;
        }

        if (loadGeneration === this.generation) {
          this.resolved.set(key, value);
          return value;
        }

        const retiredGeneration = this.retiredGenerationReleasers.get(loadGeneration);

        if (retiredGeneration && !retiredGeneration.releasedValues.has(value)) {
          retiredGeneration.releasedValues.add(value);
          retiredGeneration.release(value);
        }

        return undefined;
      })
      .finally(() => {
        if (this.pending.get(key) === load) {
          this.pending.delete(key);
        }

        const remaining = (this.pendingCountByGeneration.get(loadGeneration) ?? 1) - 1;

        if (remaining <= 0) {
          this.pendingCountByGeneration.delete(loadGeneration);
          this.retiredGenerationReleasers.delete(loadGeneration);
        } else {
          this.pendingCountByGeneration.set(loadGeneration, remaining);
        }
      });
    this.pending.set(key, load);
    return load;
  }

  clear(release?: (value: T) => void): void {
    const retiredGeneration = this.generation;
    const resolvedValues = new Set(this.resolved.values());
    this.generation += 1;

    if (release && (this.pendingCountByGeneration.get(retiredGeneration) ?? 0) > 0) {
      this.retiredGenerationReleasers.set(retiredGeneration, {
        release,
        releasedValues: new Set(resolvedValues)
      });
    }

    this.resolved.clear();
    this.pending.clear();

    if (release) {
      for (const value of resolvedValues) {
        release(value);
      }
    }
  }
}
