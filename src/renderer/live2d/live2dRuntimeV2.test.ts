import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resourceMocks = vi.hoisted(() => ({
  fetchArrayBuffer: vi.fn(),
  fetchJson: vi.fn(),
  loadImage: vi.fn()
}));

vi.mock("./live2dResourceLoader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live2dResourceLoader")>();

  return {
    ...actual,
    fetchLive2DArrayBuffer: resourceMocks.fetchArrayBuffer,
    fetchLive2DJson: resourceMocks.fetchJson,
    loadLive2DImage: resourceMocks.loadImage
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface Cubism2DrawableFixture {
  visible: boolean;
  opacity: number;
  points: Float32Array;
}

interface RuntimeFixture {
  canvas: HTMLCanvasElement;
  drawables: Cubism2DrawableFixture[];
  draw: ReturnType<typeof vi.fn>;
  expressionParser: ReturnType<typeof vi.fn>;
  framework: Record<string, unknown>;
  init: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  motionParser: ReturnType<typeof vi.fn>;
  motionStarts: ReturnType<typeof vi.fn>;
  matrixSetY: ReturnType<typeof vi.fn>;
  expressionStarts: ReturnType<typeof vi.fn>;
  physicsParser: ReturnType<typeof vi.fn>;
  poseParser: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
  runAnimationFrame: () => void;
  runtimeWindow: Record<string, unknown>;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve: (value) => resolve?.(value),
    reject: (error) => reject?.(error)
  };
}

function createRuntimeFixture(): RuntimeFixture {
  const draw = vi.fn();
  const motionStarts = vi.fn();
  const expressionStarts = vi.fn();
  const expressionParser = vi.fn(() => ({}));
  const physicsParser = vi.fn(() => ({ updateParam: vi.fn() }));
  const poseUpdate = vi.fn();
  const poseParser = vi.fn(() => ({ updateParam: poseUpdate }));
  const motionParser = vi.fn(() => ({
    setFadeIn: vi.fn(),
    setFadeOut: vi.fn()
  }));
  const init = vi.fn();
  const dispose = vi.fn();
  const revokeObjectURL = vi.fn();
  const matrixSetY = vi.fn();
  const animationFrames = new Map<number, FrameRequestCallback>();
  const drawables: Cubism2DrawableFixture[] = [
    {
      visible: true,
      opacity: 1,
      points: new Float32Array([0.2, 0.3, 1.8, 1.6])
    }
  ];
  let animationFrameId = 0;

  class FakeMotionManager {
    currentPriority = 0;
    reservePriority = 0;
    finished = true;
    isExpression: boolean;

    constructor(isExpression = false) {
      this.isExpression = isExpression;
    }

    isFinished = (): boolean => this.finished;
    updateParam = (): boolean => false;
    stopAllMotions = (): void => {
      this.finished = true;
    };
    reserveMotion = (): boolean => true;
    setReservePriority = (priority: number): void => {
      this.reservePriority = priority;
    };
    startMotion = (motion: unknown): void => {
      this.finished = false;
      (this.isExpression ? expressionStarts : motionStarts)(motion);
    };
    startMotionPrio = (motion: unknown, priority: number): void => {
      this.finished = false;
      motionStarts(motion, priority);
    };
  }

  const parameterValues = [0, 0, 0, 0];
  const savedParameterValues = new Float32Array(parameterValues);
  const rawModel = {
    getCanvasWidth: () => 2,
    getCanvasHeight: () => 2,
    getDrawDataIndex: () => -1,
    getTransformedPoints: () => [],
    getParamIndex: () => -1,
    getParamFloat: (idOrIndex: string | number) =>
      typeof idOrIndex === "number" ? parameterValues[idOrIndex] ?? 0 : 0,
    getPartsDataIndex: () => -1,
    getModelContext: () => ({
      _$qo: parameterValues.length,
      _$_2: parameterValues,
      _$fs: savedParameterValues,
      _$aS: drawables,
      _$C2: (index: number) => {
        const drawable = drawables[index];

        return drawable
          ? {
              _$yo: () => drawable.visible,
              baseOpacity: drawable.opacity,
              getTransformedPoints: () => drawable.points
            }
          : null;
      }
    }),
    setTexture: vi.fn(),
    deleteTextures: vi.fn(),
    isPremultipliedAlpha: () => true,
    saveParam: () => {
      parameterValues.forEach((value, index) => {
        savedParameterValues[index] = value;
      });
    },
    loadParam: () => {
      savedParameterValues.forEach((value, index) => {
        parameterValues[index] = value;
      });
    },
    setParamFloat: (idOrIndex: string | number, value: number) => {
      if (typeof idOrIndex === "number") {
        parameterValues[idOrIndex] = value;
      }
    },
    addToParamFloat: vi.fn(),
    multParamFloat: vi.fn(),
    setPartsOpacity: vi.fn(),
    getPartsOpacity: () => 1,
    update: vi.fn(),
    setMatrix: vi.fn(),
    draw
  };

  class FakeBaseModel {
    live2DModel = null;
    modelMatrix = null;
    mainMotionManager = new FakeMotionManager();
    expressionManager = new FakeMotionManager(true);
    motions: Record<string, unknown> = {};
    expressions: Record<string, unknown> = {};
    physics = null;
    pose = null;
    lipSync = false;
    dragX = 0;
    dragY = 0;
    lipSyncValue = 0;
    startTimeMSec = 0;
    hitTestSimple = () => false;
  }

  class FakeModelMatrix {
    private readonly values = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    identity = vi.fn();
    getArray = () => this.values;
    multScale = vi.fn();
    setWidth = vi.fn(() => {
      this.values[0] = 1;
      this.values[5] = -1;
    });
    setHeight = vi.fn();
    setX = vi.fn();
    setY = vi.fn((value: number) => {
      this.values[13] = value;
      matrixSetY(value);
    });
    centerX = vi.fn();
    centerY = vi.fn();
    top = vi.fn();
    bottom = vi.fn();
    left = vi.fn();
    right = vi.fn();
    invertTransformX = (value: number) => value;
    invertTransformY = (value: number) => value;
  }

  const framework = {
    Live2DFramework: {
      getPlatformManager: vi.fn(),
      setPlatformManager: vi.fn()
    },
    L2DBaseModel: FakeBaseModel,
    L2DExpressionMotion: { loadJson: expressionParser },
    L2DMatrix44: FakeModelMatrix,
    L2DModelMatrix: FakeModelMatrix,
    L2DMotionManager: FakeMotionManager,
    L2DEyeBlink: class {
      updateParam = vi.fn();
    },
    L2DPhysics: { load: physicsParser },
    L2DPose: { load: poseParser }
  };
  const gl = {
    TEXTURE_2D: 1,
    RGBA: 2,
    UNSIGNED_BYTE: 3,
    TEXTURE_MAG_FILTER: 4,
    TEXTURE_MIN_FILTER: 5,
    LINEAR: 6,
    LINEAR_MIPMAP_NEAREST: 7,
    TEXTURE0: 8,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 9,
    UNPACK_FLIP_Y_WEBGL: 10,
    COLOR_BUFFER_BIT: 11,
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    pixelStorei: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    generateMipmap: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn()
  };
  const canvas = {
    width: 320,
    height: 480,
    clientWidth: 320,
    clientHeight: 480,
    parentElement: { clientWidth: 320, clientHeight: 480 },
    style: {},
    getContext: vi.fn(() => gl),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 480 })
  } as unknown as HTMLCanvasElement;
  const runtimeWindow = {
    location: { href: "http://localhost/pet.html" },
    devicePixelRatio: 1,
    performance: { now: () => 0 },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      animationFrameId += 1;
      animationFrames.set(animationFrameId, callback);
      return animationFrameId;
    },
    cancelAnimationFrame: (id: number) => animationFrames.delete(id),
    URL: {
      createObjectURL: vi.fn(() => "blob:fixture"),
      revokeObjectURL
    },
    Live2D: {
      init,
      setGL: vi.fn(),
      getError: () => 0,
      dispose
    },
    Live2DModelWebGL: { loadModel: vi.fn(() => rawModel) },
    Live2DMotion: { loadMotion: motionParser },
    Cubism2Framework: framework
  };
  const runAnimationFrame = (): void => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    callbacks.forEach((callback) => callback(16));
  };

  return {
    canvas,
    drawables,
    draw,
    expressionParser,
    framework,
    init,
    dispose,
    motionParser,
    motionStarts,
    matrixSetY,
    expressionStarts,
    physicsParser,
    poseParser,
    revokeObjectURL,
    runAnimationFrame,
    runtimeWindow
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let fixture: RuntimeFixture;

beforeEach(() => {
  fixture = createRuntimeFixture();
  resourceMocks.fetchArrayBuffer.mockReset();
  resourceMocks.fetchArrayBuffer.mockResolvedValue(new ArrayBuffer(8));
  resourceMocks.fetchJson.mockReset();
  resourceMocks.loadImage.mockReset();
  resourceMocks.loadImage.mockResolvedValue({
    image: {} as HTMLImageElement,
    objectUrl: "blob:fixture-texture"
  });
  vi.stubGlobal("window", fixture.runtimeWindow);
  vi.stubGlobal("document", {
    querySelector: vi.fn(() => null),
    createElement: vi.fn(),
    head: { appendChild: vi.fn() }
  });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cubism 2 critical and deferred loading", () => {
  it("anchors the lowest visible drawable instead of the logical model canvas", async () => {
    fixture.drawables.splice(
      0,
      fixture.drawables.length,
      {
        visible: true,
        opacity: 1,
        points: new Float32Array([0.2, 0.3, 1.8, 1.6])
      },
      {
        visible: false,
        opacity: 1,
        points: new Float32Array([0.3, 0.4, 1.7, 1.98])
      },
      {
        visible: true,
        opacity: 0.001,
        points: new Float32Array([0.4, 0.5, 1.6, 1.95])
      },
      {
        visible: true,
        opacity: 0.9,
        points: new Float32Array([0.5, 0.6, 1.9, 1.8])
      }
    );
    resourceMocks.fetchJson.mockResolvedValue({ model: "pet.moc" });
    const { Cubism2Live2DModel } = await import("./live2dRuntimeV2");
    const model = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json",
      autoIdle: false
    });

    expect(fixture.matrixSetY).toHaveBeenCalledOnce();
    expect(fixture.matrixSetY.mock.calls.at(-1)?.[0]).toBeCloseTo(0.35, 6);

    model.destroy();
  });

  it("routes exact model.json entries to Cubism 2 and model3 entries to Cubism 4/5", async () => {
    const { isCubism2ModelPath } = await import("./live2dRuntimeV2");

    expect(isCubism2ModelPath("models/model.json")).toBe(true);
    expect(isCubism2ModelPath("models/avatar.model3.json")).toBe(false);
    expect(isCubism2ModelPath("models/cubism5/avatar.model3.json")).toBe(false);
  });

  it("renders once after model, textures and pose while deferring all optional assets", async () => {
    resourceMocks.fetchJson.mockResolvedValue({
      model: "pet.moc",
      textures: ["texture.png"],
      pose: "pose.json",
      physics: "physics.json",
      motions: { Tap: [{ file: "tap.mtn" }] },
      expressions: [{ name: "smile", file: "smile.exp.json" }]
    });
    const { Cubism2Live2DModel } = await import("./live2dRuntimeV2");
    const controller = new AbortController();
    const model = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json",
      abortSignal: controller.signal,
      autoIdle: false
    });
    const bufferUrls = resourceMocks.fetchArrayBuffer.mock.calls.map(([url]) => String(url));
    const signals = [
      resourceMocks.fetchJson.mock.calls[0]?.[1],
      ...resourceMocks.fetchArrayBuffer.mock.calls.map((call) => call[1]),
      ...resourceMocks.loadImage.mock.calls.map((call) => call[1])
    ] as AbortSignal[];

    expect(bufferUrls.some((url) => url.endsWith("/pet.moc"))).toBe(true);
    expect(bufferUrls.some((url) => url.endsWith("/pose.json"))).toBe(true);
    expect(bufferUrls.some((url) => /tap\.mtn|smile\.exp\.json|physics\.json/.test(url))).toBe(false);
    expect(resourceMocks.loadImage).toHaveBeenCalledOnce();
    expect(fixture.poseParser).toHaveBeenCalledOnce();
    expect(fixture.draw).toHaveBeenCalledOnce();
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(1);

    fixture.runAnimationFrame();
    await flushAsyncWork();
    expect(
      resourceMocks.fetchArrayBuffer.mock.calls.some(([url]) =>
        String(url).endsWith("/physics.json")
      )
    ).toBe(true);
    expect(fixture.physicsParser).toHaveBeenCalledOnce();

    controller.abort();
    expect(signals[0]?.aborted).toBe(true);
    model.destroy();
  });

  it("loads one motion/expression on demand, coalesces concurrency and preserves aliases/fades", async () => {
    resourceMocks.fetchJson.mockResolvedValue({
      model: "pet.moc",
      motions: { Tap: [{ File: "tap.mtn", fade_in: 120, fade_out: 240 }] },
      expressions: [{ Name: "smile", File: "smile.exp.json" }]
    });
    const tapLoad = createDeferred<ArrayBuffer>();
    const expressionLoad = createDeferred<ArrayBuffer>();
    resourceMocks.fetchArrayBuffer.mockImplementation((url: string) => {
      if (url.endsWith("tap.mtn")) return tapLoad.promise;
      if (url.endsWith("smile.exp.json")) return expressionLoad.promise;
      return Promise.resolve(new ArrayBuffer(8));
    });
    const { Cubism2Live2DModel } = await import("./live2dRuntimeV2");
    const model = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json",
      autoIdle: false
    });
    const firstMotion = model.motion("Tap", 0, "normal");
    const secondMotion = model.motion("Tap", 0, "force");

    await flushAsyncWork();
    expect(
      resourceMocks.fetchArrayBuffer.mock.calls.filter(([url]) => String(url).endsWith("tap.mtn"))
    ).toHaveLength(1);
    tapLoad.resolve(new ArrayBuffer(4));
    await expect(Promise.all([firstMotion, secondMotion])).resolves.toEqual([false, true]);

    const parsedMotion = fixture.motionParser.mock.results.at(-1)?.value as {
      setFadeIn: ReturnType<typeof vi.fn>;
      setFadeOut: ReturnType<typeof vi.fn>;
    };
    expect(parsedMotion.setFadeIn).toHaveBeenCalledWith(120);
    expect(parsedMotion.setFadeOut).toHaveBeenCalledWith(240);
    expect(fixture.motionStarts).toHaveBeenCalledOnce();
    await expect(model.motion("Tap", 0, "force")).resolves.toBe(true);
    expect(
      resourceMocks.fetchArrayBuffer.mock.calls.filter(([url]) => String(url).endsWith("tap.mtn"))
    ).toHaveLength(1);

    const firstExpression = model.expression("smile");
    const secondExpression = model.expression(0);
    await flushAsyncWork();
    expect(
      resourceMocks.fetchArrayBuffer.mock.calls.filter(([url]) =>
        String(url).endsWith("smile.exp.json")
      )
    ).toHaveLength(1);
    expressionLoad.resolve(new ArrayBuffer(4));
    await expect(Promise.all([firstExpression, secondExpression])).resolves.toEqual([false, true]);
    expect(fixture.expressionStarts).toHaveBeenCalledOnce();
    await expect(model.expression("index:0")).resolves.toBe(true);
    expect(
      resourceMocks.fetchArrayBuffer.mock.calls.filter(([url]) =>
        String(url).endsWith("smile.exp.json")
      )
    ).toHaveLength(1);
    model.destroy();
  });

  it("drops a failed action load so a later request can retry", async () => {
    resourceMocks.fetchJson.mockResolvedValue({
      model: "pet.moc",
      motions: { Tap: [{ file: "tap.mtn" }] }
    });
    let attempts = 0;
    resourceMocks.fetchArrayBuffer.mockImplementation((url: string) => {
      if (!url.endsWith("tap.mtn")) return Promise.resolve(new ArrayBuffer(8));
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("temporary motion failure"))
        : Promise.resolve(new ArrayBuffer(4));
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { Cubism2Live2DModel } = await import("./live2dRuntimeV2");
    const model = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json"
    });

    await expect(model.motion("Tap", 0)).resolves.toBe(false);
    await expect(model.motion("Tap", 0)).resolves.toBe(true);
    expect(attempts).toBe(2);
    model.destroy();
  });

  it("returns false instead of rejecting when the legacy SDK cannot start an action", async () => {
    resourceMocks.fetchJson.mockResolvedValue({
      model: "pet.moc",
      motions: { Tap: [{ file: "tap.mtn" }] },
      expressions: [{ name: "smile", file: "smile.exp.json" }]
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.motionStarts.mockImplementation(() => {
      throw new Error("legacy motion start failed");
    });
    fixture.expressionStarts.mockImplementation(() => {
      throw new Error("legacy expression start failed");
    });
    const { Cubism2Live2DModel } = await import("./live2dRuntimeV2");
    const model = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json"
    });

    await expect(model.motion("Tap", 0)).resolves.toBe(false);
    await expect(model.expression("smile")).resolves.toBe(false);
    model.destroy();
  });

  it("never starts deferred actions after external abort or destroy", async () => {
    resourceMocks.fetchJson.mockResolvedValue({
      model: "pet.moc",
      motions: { Tap: [{ file: "tap.mtn" }] },
      expressions: [{ name: "smile", file: "smile.exp.json" }]
    });
    const tapLoad = createDeferred<ArrayBuffer>();
    const expressionLoad = createDeferred<ArrayBuffer>();
    const deferredSignals: AbortSignal[] = [];
    resourceMocks.fetchArrayBuffer.mockImplementation((url: string, signal: AbortSignal) => {
      if (url.endsWith("tap.mtn")) {
        deferredSignals.push(signal);
        return tapLoad.promise;
      }
      if (url.endsWith("smile.exp.json")) {
        deferredSignals.push(signal);
        return expressionLoad.promise;
      }
      return Promise.resolve(new ArrayBuffer(8));
    });
    const { Cubism2Live2DModel } = await import("./live2dRuntimeV2");
    const controller = new AbortController();
    const model = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json",
      abortSignal: controller.signal
    });
    const motion = model.motion("Tap", 0);
    const expression = model.expression("smile");
    await flushAsyncWork();

    controller.abort();
    model.destroy();
    expect(deferredSignals.every((signal) => signal.aborted)).toBe(true);
    tapLoad.resolve(new ArrayBuffer(4));
    expressionLoad.resolve(new ArrayBuffer(4));
    await expect(Promise.all([motion, expression])).resolves.toEqual([false, false]);
    expect(fixture.motionStarts).not.toHaveBeenCalled();
    expect(fixture.expressionStarts).not.toHaveBeenCalled();
  });

  it("keeps only one pending auto-idle request across render frames", async () => {
    resourceMocks.fetchJson.mockResolvedValue({
      model: "pet.moc",
      motions: { idle: [{ file: "idle.mtn" }] }
    });
    const idleLoad = createDeferred<ArrayBuffer>();
    resourceMocks.fetchArrayBuffer.mockImplementation((url: string) =>
      url.endsWith("idle.mtn") ? idleLoad.promise : Promise.resolve(new ArrayBuffer(8))
    );
    const { Cubism2Live2DModel } = await import("./live2dRuntimeV2");
    const model = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json",
      autoIdle: true
    });

    fixture.runAnimationFrame();
    fixture.runAnimationFrame();
    fixture.runAnimationFrame();
    expect(
      resourceMocks.fetchArrayBuffer.mock.calls.filter(([url]) => String(url).endsWith("idle.mtn"))
    ).toHaveLength(1);

    idleLoad.resolve(new ArrayBuffer(4));
    await vi.waitFor(() => expect(fixture.motionStarts).toHaveBeenCalledOnce());
    model.destroy();
  });

  it("reinitializes the shared SDK after the last model disposes it", async () => {
    resourceMocks.fetchJson.mockResolvedValue({ model: "pet.moc" });
    const { Cubism2Live2DModel } = await import("./live2dRuntimeV2");
    const first = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json"
    });
    expect(fixture.init).toHaveBeenCalledTimes(1);
    first.destroy();
    expect(fixture.dispose).toHaveBeenCalledTimes(1);

    const second = await Cubism2Live2DModel.from({
      canvas: fixture.canvas,
      modelPath: "models/model.json"
    });
    expect(fixture.init).toHaveBeenCalledTimes(2);
    second.destroy();
  });
});

describe("Cubism 2 shared runtime bootstrap", () => {
  it("clears a failed bootstrap promise so script loading can retry", async () => {
    const framework = fixture.framework;
    const runtimeWindow = fixture.runtimeWindow as {
      Cubism2Framework?: unknown;
      module?: { exports?: unknown };
    };
    runtimeWindow.Cubism2Framework = undefined;
    let attempts = 0;
    const appendChild = vi.fn((script: {
      onerror?: () => void;
      onload?: () => void;
      remove: () => void;
    }) => {
      attempts += 1;
      queueMicrotask(() => {
        if (attempts === 1) {
          script.onerror?.();
          return;
        }

        if (runtimeWindow.module) {
          runtimeWindow.module.exports = framework;
        }
        script.onload?.();
      });
    });
    vi.stubGlobal("document", {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({
        dataset: {},
        remove: vi.fn()
      })),
      head: { appendChild }
    });
    vi.resetModules();
    const { loadLive2DV2Runtime } = await import("./live2dRuntimeV2");

    await expect(loadLive2DV2Runtime()).rejects.toThrow("Failed to load script");
    await expect(loadLive2DV2Runtime()).resolves.toBe(framework);
    expect(attempts).toBe(2);
  });
});
