import type { CubismLive2DModelOptions, CubismMotionPriority, Live2DFitMode } from "./live2dRuntime";
import {
  DeferredLive2DAssetCache,
  fetchLive2DArrayBuffer,
  fetchLive2DJson,
  isLive2DLoadAborted,
  loadLive2DImage,
  raceLive2DLoadWithSignal,
  throwIfLive2DLoadAborted
} from "./live2dResourceLoader";

interface Cubism2ModelJson {
  model?: string;
  textures?: string[];
  motions?: Record<string, Array<Cubism2MotionEntry> | undefined>;
  expressions?: Cubism2ExpressionEntry[];
  physics?: string;
  pose?: string;
  layout?: Record<string, number>;
}

interface Cubism2MotionEntry {
  file?: string;
  File?: string;
  fade_in?: number;
  fade_out?: number;
  sound?: string;
  expression?: string;
}

interface Cubism2ExpressionEntry {
  name?: string;
  Name?: string;
  file?: string;
  File?: string;
}

interface Live2DFrameworkExports {
  Live2DFramework: {
    getPlatformManager: () => unknown;
    setPlatformManager: (platformManager: Cubism2PlatformManager) => void;
  };
  L2DBaseModel: new () => Cubism2BaseModel;
  L2DExpressionMotion: {
    loadJson: (buffer: ArrayBuffer) => Cubism2Motion;
  };
  L2DMatrix44: new () => Cubism2Matrix44;
  L2DModelMatrix: new (width: number, height: number) => Cubism2ModelMatrix;
  L2DMotionManager: new () => Cubism2MotionManager;
  L2DEyeBlink: new () => Cubism2EyeBlink;
  L2DPhysics: {
    load: (buffer: ArrayBuffer) => Cubism2Physics;
  };
  L2DPose: {
    load: (buffer: ArrayBuffer) => Cubism2Pose;
  };
}

interface Cubism2PlatformManager {
  loadBytes: (path: string, callback: (buffer: ArrayBuffer) => void) => void;
  loadLive2DModel: (path: string, callback: (model: Cubism2RawModel) => void) => void;
  jsonParseFromBytes: (buffer: ArrayBuffer) => unknown;
  log: (message: string) => void;
}

interface Cubism2BaseModel {
  live2DModel: Cubism2RawModel | null;
  modelMatrix: Cubism2ModelMatrix | null;
  mainMotionManager: Cubism2MotionManager;
  expressionManager: Cubism2MotionManager;
  motions: Record<string, Cubism2Motion>;
  expressions: Record<string, Cubism2Motion>;
  physics: Cubism2Physics | null;
  pose: Cubism2Pose | null;
  lipSync: boolean;
  dragX: number;
  dragY: number;
  lipSyncValue: number;
  startTimeMSec: number;
  loadModelData: (path: string, callback: (model: Cubism2RawModel) => void) => void;
  loadTexture: (textureIndex: number, path: string, callback?: () => void) => void;
  loadMotion: (name: string | null, path: string, callback: (motion: Cubism2Motion) => void) => void;
  loadExpression: (name: string, path: string, callback?: () => void) => void;
  loadPhysics: (path: string) => void;
  loadPose: (path: string, callback?: () => void) => void;
  hitTestSimple: (drawId: string, testX: number, testY: number) => boolean;
}

interface Cubism2RawModel {
  getCanvasWidth: () => number;
  getCanvasHeight: () => number;
  getDrawDataIndex: (drawId: string) => number;
  getTransformedPoints: (drawIndex: number) => number[];
  getParamIndex: (id: string) => number;
  getParamFloat: (idOrIndex: string | number) => number;
  getPartsDataIndex: (id: unknown) => number;
  getModelContext?: () => Cubism2ModelContext;
  setTexture: (textureIndex: number, texture: WebGLTexture) => void;
  deleteTextures?: () => void;
  isPremultipliedAlpha: () => boolean;
  saveParam: () => void;
  loadParam: () => void;
  setParamFloat: (idOrIndex: string | number, value: number, weight?: number) => void;
  addToParamFloat: (id: string, value: number, weight?: number) => void;
  multParamFloat: (id: string, value: number, weight?: number) => void;
  setPartsOpacity: (idOrIndex: string | number, opacity: number) => void;
  getPartsOpacity: (idOrIndex: string | number) => number;
  update: () => void;
  setMatrix: (matrix: ArrayLike<number>) => void;
  draw: () => void;
}

interface Cubism2Motion {
  setFadeIn?: (fadeInMs: number) => void;
  setFadeOut?: (fadeOutMs: number) => void;
}

interface Cubism2MotionManager {
  currentPriority?: number | null;
  reservePriority?: number | null;
  isFinished: () => boolean;
  updateParam: (model: Cubism2RawModel) => boolean;
  stopAllMotions?: () => void;
  reserveMotion?: (priority: number) => boolean;
  setReservePriority?: (priority: number) => void;
  startMotion: (motion: Cubism2Motion, autoDelete: boolean) => void;
  startMotionPrio?: (motion: Cubism2Motion, priority: number) => void;
}

interface Cubism2EyeBlink {
  updateParam: (model: Cubism2RawModel) => void;
}

interface Cubism2Physics {
  updateParam: (model: Cubism2RawModel) => void;
}

interface Cubism2ModelContext {
  _$qo?: number;
  _$_2?: ArrayLike<number>;
  _$fs?: Float32Array;
}

interface Cubism2Pose {
  updateParam: (model: Cubism2RawModel) => void;
}

interface Cubism2Matrix44 {
  identity: () => void;
  getArray: () => Float32Array;
  multScale: (scaleX: number, scaleY: number) => void;
}

interface Cubism2ModelMatrix extends Cubism2Matrix44 {
  setWidth: (width: number) => void;
  setHeight: (height: number) => void;
  setX: (x: number) => void;
  setY: (y: number) => void;
  centerX: (x: number) => void;
  centerY: (y: number) => void;
  top: (y: number) => void;
  bottom: (y: number) => void;
  left: (x: number) => void;
  right: (x: number) => void;
  invertTransformX: (x: number) => number;
  invertTransformY: (y: number) => number;
}

declare global {
  interface Window {
    Live2D?: {
      init: () => void;
      setGL: (gl: WebGLRenderingContext) => void;
      getError: () => number;
      dispose?: () => void;
    };
    Live2DModelWebGL?: {
      loadModel: (buffer: ArrayBuffer) => Cubism2RawModel;
    };
    Live2DMotion?: {
      loadMotion: (buffer: ArrayBuffer) => Cubism2Motion;
    };
    Cubism2Framework?: Live2DFrameworkExports;
  }
}

interface Cubism2FrameworkWindow extends Window {
  module?: {
    exports?: Live2DFrameworkExports;
  };
}

const motionPriorities: Record<CubismMotionPriority, number> = {
  idle: 1,
  normal: 3,
  force: 4
};
const defaultFitScale = 0.96;
const previewFitScale = 0.9;
const bottomPaddingRatio = 0.02;
const previewPaddingRatio = 0.05;
const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const lookSmoothing = 12;

let runtimePromise: Promise<Live2DFrameworkExports> | undefined;
let runtimeInitialized = false;
let activeCubism2ModelCount = 0;

function retainCubism2Runtime(): void {
  activeCubism2ModelCount += 1;
}

function releaseCubism2Runtime(): void {
  activeCubism2ModelCount = Math.max(0, activeCubism2ModelCount - 1);

  if (activeCubism2ModelCount === 0 && runtimeInitialized) {
    window.Live2D?.dispose?.();
    runtimeInitialized = false;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-runtime-src="${src}"]`)) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.runtimeSrc = src;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(script);
  });
}

function resolveVendorUrl(fileName: string): string {
  return new URL(`vendor/live2d-v2/${fileName}`, window.location.href).href;
}

function resolveModelEntryUrl(modelPath: string): string {
  return new URL(modelPath, window.location.href).href;
}

function createModelBaseUrl(modelPath: string): string {
  return new URL(".", resolveModelEntryUrl(modelPath)).href;
}

function resolveModelResource(baseUrl: string, filePath: string): string {
  return new URL(filePath, baseUrl).href;
}

export function isCubism2ModelPath(modelPath: string): boolean {
  try {
    return new URL(modelPath, window.location.href).pathname.toLowerCase().endsWith("/model.json");
  } catch {
    return modelPath.toLowerCase().endsWith("model.json");
  }
}

function getFrameworkExports(): Live2DFrameworkExports {
  const runtimeWindow = window as Cubism2FrameworkWindow;
  const framework = window.Cubism2Framework ?? runtimeWindow.module?.exports;

  if (!framework?.Live2DFramework || !framework.L2DBaseModel) {
    throw new Error("Cubism 2 framework did not load.");
  }

  window.Cubism2Framework = framework;
  return framework;
}

export async function loadLive2DV2Runtime(): Promise<Live2DFrameworkExports> {
  if (!runtimePromise) {
    const bootstrap = Promise.resolve().then(async () => {
      if (!window.Live2D || !window.Live2DModelWebGL || !window.Live2DMotion) {
        await loadScript(resolveVendorUrl("coreV2.min.js"));
      }

      if (!window.Live2D || !window.Live2DModelWebGL || !window.Live2DMotion) {
        throw new Error("Cubism 2 core did not load.");
      }

      if (!window.Cubism2Framework) {
        const runtimeWindow = window as Cubism2FrameworkWindow;
        const previousModule = runtimeWindow.module;
        runtimeWindow.module = { exports: undefined };

        try {
          await loadScript(resolveVendorUrl("Live2DFramework.js"));
          window.Cubism2Framework = runtimeWindow.module?.exports;
        } finally {
          runtimeWindow.module = previousModule;
        }
      }

      return getFrameworkExports();
    });
    const retryableBootstrap = bootstrap.catch((error: unknown) => {
      if (runtimePromise === retryableBootstrap) {
        runtimePromise = undefined;
      }

      throw error;
    });
    runtimePromise = retryableBootstrap;
  }

  const framework = await runtimePromise;

  if (!runtimeInitialized) {
    window.Live2D?.init();
    framework.Live2DFramework.setPlatformManager(new Cubism2PlatformManagerImpl());
    runtimeInitialized = true;
  }

  return framework;
}

class Cubism2PlatformManagerImpl implements Cubism2PlatformManager {
  loadBytes(path: string, callback: (buffer: ArrayBuffer) => void): void {
    void fetchLive2DArrayBuffer(path).then(callback);
  }

  loadLive2DModel(path: string, callback: (model: Cubism2RawModel) => void): void {
    void fetchLive2DArrayBuffer(path).then((buffer) => {
      const model = window.Live2DModelWebGL?.loadModel(buffer);

      if (!model) {
        throw new Error(`Failed to load Cubism 2 model: ${path}`);
      }

      callback(model);
    });
  }

  jsonParseFromBytes(buffer: ArrayBuffer): unknown {
    const bytes = new Uint8Array(buffer);
    const offset = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0;
    const decoder = new TextDecoder("utf-8");

    return JSON.parse(decoder.decode(bytes.slice(offset)));
  }

  log(message: string): void {
    if (import.meta.env.DEV) {
      console.info(message);
    }
  }
}

function applyLayout(modelMatrix: Cubism2ModelMatrix, layout?: Record<string, number>): void {
  if (!layout) {
    return;
  }

  if (layout.width !== undefined) modelMatrix.setWidth(layout.width);
  if (layout.height !== undefined) modelMatrix.setHeight(layout.height);
  if (layout.x !== undefined) modelMatrix.setX(layout.x);
  if (layout.y !== undefined) modelMatrix.setY(layout.y);
  if (layout.center_x !== undefined) modelMatrix.centerX(layout.center_x);
  if (layout.center_y !== undefined) modelMatrix.centerY(layout.center_y);
  if (layout.top !== undefined) modelMatrix.top(layout.top);
  if (layout.bottom !== undefined) modelMatrix.bottom(layout.bottom);
  if (layout.left !== undefined) modelMatrix.left(layout.left);
  if (layout.right !== undefined) modelMatrix.right(layout.right);
}

function multiplyMatrix(left: ArrayLike<number>, right: ArrayLike<number>): number[] {
  const result = new Array<number>(16).fill(0);

  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[row + column * 4] += left[row + index * 4] * right[index + column * 4];
      }
    }
  }

  return result;
}

function scaleMatrix(scaleX: number, scaleY: number): number[] {
  return [scaleX, 0, 0, 0, 0, scaleY, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function normalizeMotionKey(group: string, index: number): string {
  return `${group}:${index}`;
}

function getMotionFileName(entry?: Cubism2MotionEntry): string | undefined {
  return entry?.file ?? entry?.File;
}

function getExpressionFileName(entry?: Cubism2ExpressionEntry): string | undefined {
  return entry?.file ?? entry?.File;
}

function getExpressionName(entry: Cubism2ExpressionEntry, index: number): string {
  return entry.name ?? entry.Name ?? `index:${index}`;
}

function getFirstAvailableMotionGroup(modelJson: Cubism2ModelJson): string | undefined {
  const motions = modelJson.motions ?? {};
  const preferredGroups = ["idle", "Idle", "idle01", "Idling"];

  for (const group of preferredGroups) {
    if ((motions[group] ?? []).length > 0) {
      return group;
    }
  }

  return Object.keys(motions).find((group) => /^idle\d*$/i.test(group) && (motions[group] ?? []).length > 0);
}

export class Cubism2Live2DModel {
  static async from(options: CubismLive2DModelOptions): Promise<Cubism2Live2DModel> {
    const framework = await raceLive2DLoadWithSignal(
      loadLive2DV2Runtime(),
      options.abortSignal
    );
    const model = new Cubism2Live2DModel(options, framework);

    try {
      await model.load();
      return model;
    } catch (error) {
      model.destroy();
      throw error;
    }
  }

  private readonly canvas: HTMLCanvasElement;
  private readonly modelPath: string;
  private readonly modelBaseUrl: string;
  private readonly framework: Live2DFrameworkExports;
  private readonly autoIdle: boolean;
  private readonly fitMode: Live2DFitMode;
  private readonly externalAbortSignal?: AbortSignal;
  private readonly resourceAbortController = new AbortController();
  private readonly onHit?: () => void;
  private readonly onError?: (error: unknown) => void;
  private readonly motionCache = new DeferredLive2DAssetCache<Cubism2Motion>();
  private readonly expressionCache = new DeferredLive2DAssetCache<Cubism2Motion>();
  private gl: WebGLRenderingContext;
  private baseModel: Cubism2BaseModel;
  private modelJson?: Cubism2ModelJson;
  private viewProjectionMatrix = identityMatrix;
  private animationFrame = 0;
  private deferredPhysicsFrame = 0;
  private disposed = false;
  private runtimeRetained = false;
  private idleGroup?: string;
  private textures: WebGLTexture[] = [];
  private textureObjectUrls: Array<string | undefined> = [];
  private initialParameterSnapshot: number[] = [];
  private initialSavedParameterSnapshot: number[] = [];
  private eyeBlink?: Cubism2EyeBlink;
  private autoIdlePending?: Promise<void>;
  private autoIdleRetryAfter = 0;
  private motionOperationSequence = 0;
  private expressionOperationSequence = 0;
  private targetLookX = 0;
  private targetLookY = 0;
  private lookX = 0;
  private lookY = 0;

  private constructor(options: CubismLive2DModelOptions, framework: Live2DFrameworkExports) {
    this.canvas = options.canvas;
    this.modelPath = resolveModelEntryUrl(options.modelPath);
    this.modelBaseUrl = createModelBaseUrl(options.modelPath);
    this.framework = framework;
    this.autoIdle = options.autoIdle ?? false;
    this.fitMode = options.fitMode ?? "stage";
    this.externalAbortSignal = options.abortSignal;
    this.onHit = options.onHit;
    this.onError = options.onError;

    const gl = this.canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false
    });

    if (!gl) {
      throw new Error("WebGL is not available.");
    }

    this.gl = gl;
    retainCubism2Runtime();
    this.runtimeRetained = true;
    this.bindGL();
    this.baseModel = new this.framework.L2DBaseModel();
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);

    if (this.externalAbortSignal?.aborted) {
      this.abortResources(this.externalAbortSignal.reason);
    } else {
      this.externalAbortSignal?.addEventListener("abort", this.handleExternalAbort, {
        once: true
      });
    }
  }

  async load(): Promise<void> {
    this.throwIfAborted();
    this.modelJson = await fetchLive2DJson<Cubism2ModelJson>(
      this.modelPath,
      this.resourceAbortController.signal
    );
    this.throwIfAborted();

    if (!this.modelJson.model) {
      throw new Error("model.json does not reference a .moc file.");
    }

    const modelBuffer = await fetchLive2DArrayBuffer(
      resolveModelResource(this.modelBaseUrl, this.modelJson.model),
      this.resourceAbortController.signal
    );
    this.throwIfAborted();
    this.bindGL();
    const rawModel = window.Live2DModelWebGL?.loadModel(modelBuffer);

    if (!rawModel) {
      throw new Error(`Failed to load Cubism 2 model: ${this.modelJson.model}`);
    }

    this.throwIfAborted();
    this.baseModel.live2DModel = rawModel;
    rawModel.saveParam();
    this.baseModel.modelMatrix = new this.framework.L2DModelMatrix(
      rawModel.getCanvasWidth(),
      rawModel.getCanvasHeight()
    );
    this.baseModel.modelMatrix.setWidth(2);
    applyLayout(this.baseModel.modelMatrix, this.modelJson.layout);

    await Promise.all([this.loadTextures(), this.loadPose()]);
    this.throwIfAborted();
    this.stopMotionManagers();
    this.idleGroup = getFirstAvailableMotionGroup(this.modelJson);
    this.captureInitialParameterSnapshot();
    this.saveNeutralParameterBase();
    this.resetToNeutralFace();
    this.resize();
    this.render();
    this.startLoop();
    this.scheduleDeferredPhysicsLoad();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    const cssWidth = Math.max(1, parent?.clientWidth ?? this.canvas.clientWidth ?? 1);
    const cssHeight = Math.max(1, parent?.clientHeight ?? this.canvas.clientHeight ?? 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const nextHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (this.canvas.width !== nextWidth || this.canvas.height !== nextHeight) {
      this.canvas.width = nextWidth;
      this.canvas.height = nextHeight;
    }

    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.bindGL();
    this.gl.viewport(0, 0, nextWidth, nextHeight);
    const viewportRatio = nextWidth / Math.max(nextHeight, 1);
    const projection =
      nextWidth > nextHeight
        ? scaleMatrix(1 / viewportRatio, 1)
        : scaleMatrix(1, viewportRatio);

    this.viewProjectionMatrix = projection;
    this.fitModelToViewport();
  }

  async motion(group: string, index = 0, priority: CubismMotionPriority = "normal"): Promise<boolean> {
    if (this.disposed || !this.modelJson) {
      return false;
    }

    const operationSequence = ++this.motionOperationSequence;
    let motion: Cubism2Motion | undefined;

    try {
      motion = await this.getMotion(group, index);
    } catch (error) {
      if (!isLive2DLoadAborted(error, this.resourceAbortController.signal)) {
        this.reportOptionalAssetError("motion", error);
      }

      return false;
    }

    if (
      !motion ||
      this.disposed ||
      this.resourceAbortController.signal.aborted ||
      operationSequence !== this.motionOperationSequence
    ) {
      return false;
    }

    try {
      const motionPriority = motionPriorities[priority];

      if (priority === "force") {
        this.baseModel.mainMotionManager.setReservePriority?.(motionPriority);
      } else if (
        this.baseModel.mainMotionManager.reserveMotion &&
        !this.baseModel.mainMotionManager.reserveMotion(motionPriority)
      ) {
        return false;
      }

      if (this.baseModel.mainMotionManager.startMotionPrio) {
        this.baseModel.mainMotionManager.startMotionPrio(motion, motionPriority);
      } else {
        this.baseModel.mainMotionManager.startMotion(motion, false);
      }
      return true;
    } catch (error) {
      if (!isLive2DLoadAborted(error, this.resourceAbortController.signal)) {
        this.reportOptionalAssetError("motion", error);
      }

      return false;
    }
  }

  async expression(id?: string | number): Promise<boolean> {
    if (id === undefined || id === null || this.disposed) {
      return false;
    }

    const operationSequence = ++this.expressionOperationSequence;
    let expression: Cubism2Motion | undefined;

    try {
      expression = await this.getExpression(id);
    } catch (error) {
      if (!isLive2DLoadAborted(error, this.resourceAbortController.signal)) {
        this.reportOptionalAssetError("expression", error);
      }

      return false;
    }

    if (
      !expression ||
      this.disposed ||
      this.resourceAbortController.signal.aborted ||
      operationSequence !== this.expressionOperationSequence
    ) {
      return false;
    }

    try {
      this.baseModel.expressionManager.startMotion(expression, false);
      return true;
    } catch (error) {
      if (!isLive2DLoadAborted(error, this.resourceAbortController.signal)) {
        this.reportOptionalAssetError("expression", error);
      }

      return false;
    }
  }

  resetToNeutralFace(): void {
    const rawModel = this.baseModel.live2DModel;

    if (!rawModel) {
      return;
    }

    this.motionOperationSequence += 1;
    this.expressionOperationSequence += 1;
    this.stopMotionManagers();
    this.baseModel.lipSync = false;
    this.baseModel.lipSyncValue = 0;
    this.baseModel.dragX = 0;
    this.baseModel.dragY = 0;
    this.eyeBlink = new this.framework.L2DEyeBlink();
    this.targetLookX = 0;
    this.targetLookY = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.restoreInitialParameterSnapshot();
    this.saveNeutralParameterBase();
    rawModel.update();
  }

  setParameterValue(id: string, value: number, weight = 1): void {
    this.baseModel.live2DModel?.setParamFloat(id, value, weight);
  }

  setPartOpacity(idOrIndex: string | number, opacity: number): void {
    this.baseModel.live2DModel?.setPartsOpacity(idOrIndex, opacity);
  }

  lookAtClientPoint(clientX: number, clientY: number): void {
    this.updatePointerTargetFromClientPoint(clientX, clientY);
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.motionOperationSequence += 1;
    this.expressionOperationSequence += 1;
    this.externalAbortSignal?.removeEventListener("abort", this.handleExternalAbort);
    this.abortResources();
    window.cancelAnimationFrame(this.animationFrame);
    window.cancelAnimationFrame(this.deferredPhysicsFrame);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.bindGL();
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    for (const texture of this.textures) {
      this.gl.deleteTexture(texture);
    }

    for (const objectUrl of this.textureObjectUrls) {
      if (objectUrl) {
        window.URL.revokeObjectURL(objectUrl);
      }
    }

    this.textures = [];
    this.textureObjectUrls = [];
    this.autoIdlePending = undefined;
    this.motionCache.clear();
    this.expressionCache.clear();
    this.baseModel.motions = {};
    this.baseModel.expressions = {};
    this.bindGL();
    this.baseModel.live2DModel?.deleteTextures?.();
    this.baseModel.live2DModel = null;

    if (this.runtimeRetained) {
      this.runtimeRetained = false;
      releaseCubism2Runtime();
    }
  }

  private async loadTextures(): Promise<void> {
    const textures = this.modelJson?.textures ?? [];

    await Promise.all(textures.map((texturePath, index) => this.loadTexture(index, texturePath)));
  }

  private async loadTexture(textureIndex: number, texturePath: string): Promise<void> {
    const rawModel = this.baseModel.live2DModel;

    if (!rawModel || this.disposed || this.resourceAbortController.signal.aborted) {
      return;
    }

    const { image, objectUrl } = await loadLive2DImage(
      resolveModelResource(this.modelBaseUrl, texturePath),
      this.resourceAbortController.signal
    );

    if (this.disposed || this.resourceAbortController.signal.aborted) {
      if (objectUrl) {
        window.URL.revokeObjectURL(objectUrl);
      }
      return;
    }

    this.bindGL();
    const texture = this.gl.createTexture();

    if (!texture) {
      if (objectUrl) {
        window.URL.revokeObjectURL(objectUrl);
      }
      throw new Error("Failed to create Cubism 2 texture.");
    }

    if (!rawModel.isPremultipliedAlpha()) {
      this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    }

    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, 1);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, image);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_NEAREST);
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.bindGL();
    rawModel.setTexture(textureIndex, texture);
    this.textureObjectUrls.push(objectUrl);
    this.textures.push(texture);
  }

  private async loadPose(): Promise<void> {
    const poseFile = this.modelJson?.pose;

    if (!poseFile) {
      return;
    }

    const poseBuffer = await fetchLive2DArrayBuffer(
      resolveModelResource(this.modelBaseUrl, poseFile),
      this.resourceAbortController.signal
    );
    this.throwIfAborted();
    this.baseModel.pose = this.framework.L2DPose.load(poseBuffer);

    if (this.baseModel.live2DModel) {
      this.baseModel.pose.updateParam(this.baseModel.live2DModel);
    }
  }

  private scheduleDeferredPhysicsLoad(): void {
    if (!this.modelJson?.physics || this.disposed) {
      return;
    }

    this.deferredPhysicsFrame = window.requestAnimationFrame(() => {
      this.deferredPhysicsFrame = 0;
      void this.loadPhysics().catch((error: unknown) => {
        if (!isLive2DLoadAborted(error, this.resourceAbortController.signal)) {
          this.reportOptionalAssetError("physics", error);
        }
      });
    });
  }

  private async loadPhysics(): Promise<void> {
    const physicsFile = this.modelJson?.physics;

    if (!physicsFile) {
      return;
    }

    const physicsBuffer = await fetchLive2DArrayBuffer(
      resolveModelResource(this.modelBaseUrl, physicsFile),
      this.resourceAbortController.signal
    );
    this.throwIfAborted();
    this.baseModel.physics = this.framework.L2DPhysics.load(physicsBuffer);
  }

  private async getMotion(group: string, index: number): Promise<Cubism2Motion | undefined> {
    const key = normalizeMotionKey(group, index);
    const cachedMotion = this.baseModel.motions[key] ?? this.motionCache.get(key);

    if (cachedMotion) {
      this.motionCache.set(key, cachedMotion);
      return cachedMotion;
    }

    return this.motionCache.getOrLoad(key, async () => {
      const entry = this.modelJson?.motions?.[group]?.[index];

      if (!entry) {
        return undefined;
      }

      const motionFile = getMotionFileName(entry);

      if (!motionFile) {
        return undefined;
      }

      const buffer = await fetchLive2DArrayBuffer(
        resolveModelResource(this.modelBaseUrl, motionFile),
        this.resourceAbortController.signal
      );
      this.throwIfAborted();
      const motion = window.Live2DMotion?.loadMotion(buffer);

      if (!motion) {
        return undefined;
      }

      if (entry.fade_in !== undefined) {
        motion.setFadeIn?.(entry.fade_in);
      }

      if (entry.fade_out !== undefined) {
        motion.setFadeOut?.(entry.fade_out);
      }

      this.throwIfAborted();
      this.baseModel.motions[key] = motion;
      return motion;
    });
  }

  private async getExpression(id: string | number): Promise<Cubism2Motion | undefined> {
    const resolved = this.resolveExpressionEntry(id);

    if (!resolved) {
      return undefined;
    }

    const { entry, index, name } = resolved;
    const indexKey = `index:${index}`;
    const aliases = [name, indexKey, String(index)];

    for (const alias of aliases) {
      const cachedExpression =
        this.baseModel.expressions[alias] ?? this.expressionCache.get(alias);

      if (cachedExpression) {
        this.expressionCache.setAliases(aliases, cachedExpression);
        return cachedExpression;
      }
    }

    return this.expressionCache.getOrLoad(indexKey, async () => {
      const expressionFile = getExpressionFileName(entry);

      if (!expressionFile) {
        return undefined;
      }

      const buffer = await fetchLive2DArrayBuffer(
        resolveModelResource(this.modelBaseUrl, expressionFile),
        this.resourceAbortController.signal
      );
      this.throwIfAborted();
      const expression = this.framework.L2DExpressionMotion.loadJson(buffer);
      this.throwIfAborted();
      this.baseModel.expressions[name] = expression;
      this.baseModel.expressions[indexKey] = expression;
      this.expressionCache.setAliases(aliases, expression);
      return expression;
    });
  }

  private resolveExpressionEntry(
    id: string | number
  ): { entry: Cubism2ExpressionEntry; index: number; name: string } | undefined {
    const expressions = this.modelJson?.expressions ?? [];
    const requestedId = String(id);
    const namedIndex =
      typeof id === "string"
        ? expressions.findIndex((entry, entryIndex) =>
            [getExpressionName(entry, entryIndex), entry.name, entry.Name]
              .filter(Boolean)
              .includes(requestedId)
          )
        : -1;
    const indexMatch = /^(?:index:)?(\d+)$/.exec(requestedId);
    const index = namedIndex >= 0 ? namedIndex : indexMatch ? Number(indexMatch[1]) : -1;
    const entry = expressions[index];

    if (!entry) {
      return undefined;
    }

    return {
      entry,
      index,
      name: getExpressionName(entry, index)
    };
  }

  private reportOptionalAssetError(kind: string, error: unknown): void {
    console.warn(`Failed to load optional Cubism 2 ${kind}.`, error);
  }

  private captureInitialParameterSnapshot(): void {
    const rawModel = this.baseModel.live2DModel;
    const context = rawModel?.getModelContext?.();
    const values = context?._$_2;

    if (!values) {
      return;
    }

    const count = Math.min(context?._$qo ?? values.length, values.length);

    this.initialParameterSnapshot = Array.from({ length: count }, (_, index) => values[index]);
  }

  private saveNeutralParameterBase(): void {
    const rawModel = this.baseModel.live2DModel;
    const context = rawModel?.getModelContext?.();
    const savedValues = context?._$fs;

    if (!savedValues) {
      if (rawModel) {
        rawModel.saveParam();
      }
      return;
    }

    if (!rawModel) {
      return;
    }

    rawModel.saveParam();

    const count = Math.min(context?._$qo ?? savedValues.length, savedValues.length);
    this.initialSavedParameterSnapshot = Array.from({ length: count }, (_, index) => savedValues[index]);
  }

  private restoreInitialParameterSnapshot(): void {
    const rawModel = this.baseModel.live2DModel;

    if (!rawModel) {
      return;
    }

    if (!this.initialParameterSnapshot.length) {
      rawModel.loadParam();
      return;
    }

    for (let index = 0; index < this.initialParameterSnapshot.length; index += 1) {
      const value = this.initialParameterSnapshot[index];

      if (Number.isFinite(value)) {
        rawModel.setParamFloat(index, value, 1);
      }
    }

    rawModel.saveParam();
  }

  private restoreNeutralParameterBase(): void {
    const rawModel = this.baseModel.live2DModel;
    const context = rawModel?.getModelContext?.();
    const savedValues = context?._$fs;

    if (!rawModel || !savedValues || !this.initialSavedParameterSnapshot.length) {
      rawModel?.loadParam();
      return;
    }

    const count = Math.min(this.initialSavedParameterSnapshot.length, savedValues.length);

    for (let index = 0; index < count; index += 1) {
      const value = this.initialSavedParameterSnapshot[index];

      if (Number.isFinite(value)) {
        savedValues[index] = value;
      }
    }

    rawModel.loadParam();
  }

  private stopMotionManagers(): void {
    const managers = [this.baseModel.mainMotionManager, this.baseModel.expressionManager];

    for (const manager of managers) {
      manager.stopAllMotions?.();
      manager.setReservePriority?.(0);
      manager.currentPriority = 0;
      manager.reservePriority = 0;
    }
  }

  private startLoop(): void {
    const tick = (): void => {
      if (this.disposed) {
        return;
      }

      try {
        this.render();
      } catch (error) {
        this.onError?.(error);
      }

      this.animationFrame = window.requestAnimationFrame(tick);
    };

    this.animationFrame = window.requestAnimationFrame(tick);
  }

  private render(): void {
    const rawModel = this.baseModel.live2DModel;

    if (!rawModel) {
      return;
    }

    this.bindGL();

    if (
      this.autoIdle &&
      !this.autoIdlePending &&
      window.performance.now() >= this.autoIdleRetryAfter &&
      this.baseModel.mainMotionManager.isFinished() &&
      this.idleGroup
    ) {
      const motionCount = this.modelJson?.motions?.[this.idleGroup]?.length ?? 0;
      const index = motionCount > 1 ? Math.floor(Math.random() * motionCount) : 0;
      const pending = this.motion(this.idleGroup, index, "idle").then((started) => {
        this.autoIdleRetryAfter = started ? 0 : window.performance.now() + 1000;
      });
      const trackedPending = pending.finally(() => {
        if (this.autoIdlePending === trackedPending) {
          this.autoIdlePending = undefined;
        }
      });
      this.autoIdlePending = trackedPending;
    }

    const timeSeconds = (window.performance.now() - this.baseModel.startTimeMSec) / 1000;
    const t = timeSeconds * 2 * Math.PI;

    this.restoreNeutralParameterBase();

    const updated = this.baseModel.mainMotionManager.updateParam(rawModel);

    if (updated) {
      rawModel.saveParam();
    }

    if (!this.baseModel.expressionManager.isFinished()) {
      this.baseModel.expressionManager.updateParam(rawModel);
    }

    if (!updated) {
      this.eyeBlink?.updateParam(rawModel);
    }

    this.updateLookAt();
    rawModel.addToParamFloat("PARAM_ANGLE_X", Number(15 * Math.sin(t / 6.5345)), 0.5);
    rawModel.addToParamFloat("PARAM_ANGLE_Y", Number(8 * Math.sin(t / 3.5345)), 0.5);
    rawModel.addToParamFloat("PARAM_ANGLE_Z", Number(10 * Math.sin(t / 5.5345)), 0.5);
    rawModel.addToParamFloat("PARAM_BODY_ANGLE_X", Number(4 * Math.sin(t / 15.5345)), 0.5);
    rawModel.setParamFloat("PARAM_BREATH", Number(0.5 + 0.5 * Math.sin(t / 3.2345)), 1);

    this.baseModel.physics?.updateParam(rawModel);
    if (this.baseModel.lipSync || Math.abs(this.baseModel.lipSyncValue) > 0.001) {
      rawModel.setParamFloat("PARAM_MOUTH_OPEN_Y", this.baseModel.lipSyncValue);
    }
    this.baseModel.pose?.updateParam(rawModel);
    rawModel.update();

    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    const modelMatrix = this.baseModel.modelMatrix?.getArray() ?? identityMatrix;
    rawModel.setMatrix(multiplyMatrix(this.viewProjectionMatrix, modelMatrix));
    this.bindGL();
    rawModel.draw();
  }

  private bindGL(): void {
    window.Live2D?.setGL(this.gl);
  }

  private abortResources(reason?: unknown): void {
    if (!this.resourceAbortController.signal.aborted) {
      this.resourceAbortController.abort(reason);
    }
  }

  private readonly handleExternalAbort = (): void => {
    this.motionOperationSequence += 1;
    this.expressionOperationSequence += 1;
    this.abortResources(this.externalAbortSignal?.reason);
  };

  private throwIfAborted(): void {
    throwIfLive2DLoadAborted(this.resourceAbortController.signal);
  }

  private fitModelToViewport(): void {
    if (this.fitMode === "previewContain") {
      this.fitModelContain();
      return;
    }

    this.fitModelBottom();
  }

  private fitModelBottom(): void {
    const modelMatrix = this.baseModel.modelMatrix;

    if (!modelMatrix || !this.baseModel.live2DModel) {
      return;
    }

    const ratio = this.canvas.height / Math.max(this.canvas.width, 1);
    const viewHeight = ratio >= 1 ? 2 * ratio : 2;
    const targetBottom = -viewHeight / 2 + viewHeight * bottomPaddingRatio;
    modelMatrix.bottom(targetBottom);
  }

  private fitModelContain(): void {
    const modelMatrix = this.baseModel.modelMatrix;
    const rawModel = this.baseModel.live2DModel;

    if (!modelMatrix || !rawModel) {
      return;
    }

    const viewportRatio = this.canvas.width / Math.max(this.canvas.height, 1);
    const viewWidth = viewportRatio >= 1 ? 2 * viewportRatio : 2;
    const viewHeight = viewportRatio >= 1 ? 2 : 2 / viewportRatio;
    const modelWidth = Math.max(rawModel.getCanvasWidth(), 0.0001);
    const modelHeight = Math.max(rawModel.getCanvasHeight(), 0.0001);
    const targetWidth = viewWidth * previewFitScale;
    const targetHeight = viewHeight * previewFitScale;
    const widthLimitedHeight = targetWidth * (modelHeight / modelWidth);

    modelMatrix.identity();

    if (widthLimitedHeight <= targetHeight) {
      modelMatrix.setWidth(targetWidth);
    } else {
      modelMatrix.setHeight(targetHeight);
    }

    modelMatrix.centerX(0);
    modelMatrix.bottom(-viewHeight / 2 + viewHeight * previewPaddingRatio);
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.onHit?.();
    this.updatePointerTarget(event);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.updatePointerTarget(event);
  };

  private readonly handlePointerLeave = (): void => {
    this.targetLookX = 0;
    this.targetLookY = 0;
  };

  private updatePointerTarget(event: PointerEvent): void {
    this.updatePointerTargetFromClientPoint(event.clientX, event.clientY);
  }

  private updatePointerTargetFromClientPoint(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      this.targetLookX = 0;
      this.targetLookY = 0;
      return;
    }

    this.targetLookX = Math.max(-1, Math.min(1, ((clientX - rect.left) / rect.width) * 2 - 1));
    this.targetLookY = Math.max(-1, Math.min(1, -(((clientY - rect.top) / rect.height) * 2 - 1)));
  }

  private updateLookAt(): void {
    const rawModel = this.baseModel.live2DModel;

    if (!rawModel) {
      return;
    }

    this.lookX += (this.targetLookX - this.lookX) * Math.min(1, lookSmoothing / 60);
    this.lookY += (this.targetLookY - this.lookY) * Math.min(1, lookSmoothing / 60);
    this.baseModel.dragX = this.lookX;
    this.baseModel.dragY = this.lookY;
    rawModel.addToParamFloat("PARAM_ANGLE_X", this.lookX * 30, 1);
    rawModel.addToParamFloat("PARAM_ANGLE_Y", this.lookY * 30, 1);
    rawModel.addToParamFloat("PARAM_ANGLE_Z", this.lookX * this.lookY * -30, 1);
    rawModel.addToParamFloat("PARAM_BODY_ANGLE_X", this.lookX * 10, 1);
    rawModel.addToParamFloat("PARAM_EYE_BALL_X", this.lookX, 1);
    rawModel.addToParamFloat("PARAM_EYE_BALL_Y", this.lookY, 1);
  }
}
