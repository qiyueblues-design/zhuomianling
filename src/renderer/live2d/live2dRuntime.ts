import { CubismDefaultParameterId } from "./cubism/framework/cubismdefaultparameterid";
import { CubismModelSettingJson } from "./cubism/framework/cubismmodelsettingjson";
import {
  BreathParameterData,
  CubismBreath
} from "./cubism/framework/effect/cubismbreath";
import { CubismEyeBlink } from "./cubism/framework/effect/cubismeyeblink";
import { CubismPose } from "./cubism/framework/effect/cubismpose";
import type { CubismIdHandle } from "./cubism/framework/id/cubismid";
import type { ICubismModelSetting } from "./cubism/framework/icubismmodelsetting";
import {
  CubismFramework,
  LogLevel,
  Option
} from "./cubism/framework/live2dcubismframework";
import { CubismMatrix44 } from "./cubism/framework/math/cubismmatrix44";
import { CubismModelMatrix } from "./cubism/framework/math/cubismmodelmatrix";
import type { CubismModel } from "./cubism/framework/model/cubismmodel";
import { CubismMoc } from "./cubism/framework/model/cubismmoc";
import type { ACubismMotion } from "./cubism/framework/motion/acubismmotion";
import { CubismExpressionMotion } from "./cubism/framework/motion/cubismexpressionmotion";
import { CubismExpressionMotionManager } from "./cubism/framework/motion/cubismexpressionmotionmanager";
import { CubismMotion } from "./cubism/framework/motion/cubismmotion";
import { CubismMotionManager } from "./cubism/framework/motion/cubismmotionmanager";
import {
  CubismMotionQueueEntryHandle,
  InvalidMotionQueueEntryHandleValue
} from "./cubism/framework/motion/cubismmotionqueuemanager";
import { CubismPhysics } from "./cubism/framework/physics/cubismphysics";
import { CubismRenderer_WebGL } from "./cubism/framework/rendering/cubismrenderer_webgl";
import {
  DeferredLive2DAssetCache,
  fetchLive2DArrayBuffer,
  isLive2DLoadAborted,
  loadLive2DElementImage,
  loadLive2DImage,
  raceLive2DLoadWithSignal,
  throwIfLive2DLoadAborted
} from "./live2dResourceLoader";

export type CubismMotionPriority = "idle" | "normal" | "force";
export type Live2DFitMode = "stage" | "previewContain";

export interface CubismLive2DModelOptions {
  canvas: HTMLCanvasElement;
  modelPath: string;
  autoIdle?: boolean;
  fitMode?: Live2DFitMode;
  abortSignal?: AbortSignal;
  onHit?: () => void;
  onError?: (error: unknown) => void;
}

export interface CubismPartOpacityTarget {
  idOrIndex: string | number;
  opacity: number;
}

interface ModelBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface LoadedTexture {
  id: WebGLTexture;
  image: HTMLImageElement;
  path: string;
  objectUrl?: string;
}

const motionPriorities: Record<CubismMotionPriority, number> = {
  idle: 1,
  normal: 2,
  force: 3
};
const defaultFitScale = 0.96;
const previewFitScale = 0.9;
const bottomPaddingRatio = 0.02;
const previewPaddingRatio = 0.05;
const lookSmoothing = 12;
const cubismCoreReadyTimeoutMs = 10_000;
const cubismCoreReadyPollMs = 16;

export function isLive2DCubismCoreReady(
  getVersion: () => number = () => Live2DCubismCore.Version.csmGetVersion()
): boolean {
  try {
    return Number.isFinite(getVersion());
  } catch {
    // The Core script creates its global before its async Emscripten runtime is ready.
    return false;
  }
}

function waitForLive2DCubismCoreReady(): Promise<void> {
  if (isLive2DCubismCoreReady()) {
    return Promise.resolve();
  }

  const deadline = window.performance.now() + cubismCoreReadyTimeoutMs;

  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (isLive2DCubismCoreReady()) {
        resolve();
        return;
      }

      if (window.performance.now() >= deadline) {
        reject(new Error("Live2D Cubism Core did not finish initializing."));
        return;
      }

      window.setTimeout(poll, cubismCoreReadyPollMs);
    };

    poll();
  });
}

function normalizeLive2DId(id: string): string {
  return id.replace(/[\s_-]/g, "").toLowerCase();
}

function isIdleMotionGroupName(groupName: string): boolean {
  const normalized = normalizeLive2DId(groupName);

  return normalized === "idle" || normalized === "idling" || /^idle\d+$/.test(normalized);
}

function isNeutralFaceParameterId(id: string): boolean {
  const normalized = normalizeLive2DId(id);

  return (
    normalized.includes("mouth") ||
    normalized.includes("cheek") ||
    normalized.includes("tear") ||
    normalized.includes("eyesmile") ||
    normalized.includes("eyelsmile") ||
    normalized.includes("eyersmile") ||
    normalized.includes("brow")
  );
}

let runtimePromise: Promise<void> | undefined;
let activeModelCount = 0;

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

function resolveRuntimeUrl(): string {
  return new URL("vendor/live2dcubismcore.min.js", window.location.href).href;
}

function resolveShaderPath(): string {
  return new URL("vendor/cubism/Shaders/WebGL/", window.location.href).href;
}

export function loadLive2DRuntime(): Promise<void> {
  if (runtimePromise) {
    return runtimePromise;
  }

  const pendingRuntime = Promise.resolve()
    .then(() => {
      if (typeof Live2DCubismCore !== "undefined") {
        return undefined;
      }

      return loadScript(resolveRuntimeUrl());
    })
    .then(async () => {
      await waitForLive2DCubismCoreReady();

      if (!CubismFramework.isStarted()) {
        const option = new Option();
        option.loggingLevel = import.meta.env.DEV
          ? LogLevel.LogLevel_Warning
          : LogLevel.LogLevel_Error;
        option.logFunction = (message: string) => {
          if (import.meta.env.DEV) {
            console.info(message.trim());
          }
        };
        CubismFramework.startUp(option);
      }

      if (!CubismFramework.isInitialized()) {
        CubismFramework.initialize();
      }
    });
  let retryableRuntime: Promise<void>;
  retryableRuntime = pendingRuntime.catch((error) => {
    if (runtimePromise === retryableRuntime) {
      runtimePromise = undefined;
    }

    throw error;
  });
  runtimePromise = retryableRuntime;

  return runtimePromise;
}

function retainRuntime(): void {
  activeModelCount += 1;
}

function releaseRuntime(): void {
  activeModelCount = Math.max(0, activeModelCount - 1);
}

function resolveModelEntryUrl(modelPath: string): string {
  return new URL(modelPath, window.location.href).href;
}

function createModelBaseUrl(modelPath: string): string {
  return new URL(".", resolveModelEntryUrl(modelPath)).href;
}

function resolveModelResource(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).href;
}

function createTexture(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  image: HTMLImageElement
): WebGLTexture {
  const texture = gl.createTexture();

  if (!texture) {
    throw new Error("Failed to create WebGL texture.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

function normalizeMotionKey(group: string, index: number): string {
  return `${group}:${index}`;
}

function getFirstAvailableMotionGroup(setting: ICubismModelSetting): string | undefined {
  const preferredGroups = ["Idle", "idle", "Idling", "idle01"];

  for (const group of preferredGroups) {
    if (setting.getMotionCount(group) > 0) {
      return group;
    }
  }

  for (let index = 0; index < setting.getMotionGroupCount(); index += 1) {
    const groupName = setting.getMotionGroupName(index);

    if (groupName && isIdleMotionGroupName(groupName) && setting.getMotionCount(groupName) > 0) {
      return groupName;
    }
  }

  return undefined;
}

export class CubismLive2DModel {
  static async from(options: CubismLive2DModelOptions): Promise<CubismLive2DModel> {
    await raceLive2DLoadWithSignal(loadLive2DRuntime(), options.abortSignal);
    throwIfLive2DLoadAborted(options.abortSignal);
    retainRuntime();

    const model = new CubismLive2DModel(options);

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
  private readonly autoIdle: boolean;
  private readonly fitMode: Live2DFitMode;
  private readonly resourceAbortController = new AbortController();
  private readonly externalAbortSignal?: AbortSignal;
  private readonly abortSignal = this.resourceAbortController.signal;
  private readonly onHit?: () => void;
  private readonly onError?: (error: unknown) => void;
  private gl: WebGLRenderingContext | WebGL2RenderingContext;
  private setting?: CubismModelSettingJson;
  private moc?: CubismMoc;
  private model?: CubismModel;
  private renderer?: CubismRenderer_WebGL;
  private modelMatrix?: CubismModelMatrix;
  private viewMatrix = new CubismMatrix44();
  private mvpMatrix = new CubismMatrix44();
  private modelBounds?: ModelBounds;
  private physics?: CubismPhysics;
  private pose?: CubismPose;
  private eyeBlink?: CubismEyeBlink;
  private breath?: CubismBreath;
  private motionManager = new CubismMotionManager();
  private expressionManager = new CubismExpressionMotionManager();
  private motions = new DeferredLive2DAssetCache<CubismMotion>();
  private expressions = new DeferredLive2DAssetCache<ACubismMotion>();
  private eyeBlinkIds: CubismIdHandle[] = [];
  private lipSyncIds: CubismIdHandle[] = [];
  private textures: LoadedTexture[] = [];
  private shaderPath = resolveShaderPath();
  private animationFrame = 0;
  private lastFrameTime = window.performance.now();
  private userTimeSeconds = 0;
  private reservedPriority = 0;
  private idleGroup?: string;
  private pendingIdleMotion?: Promise<boolean>;
  private pendingMotionOperationSequence?: number;
  private idleRetryAt = 0;
  private motionOperationSequence = 0;
  private expressionOperationSequence = 0;
  private width = 1;
  private height = 1;
  private targetLookX = 0;
  private targetLookY = 0;
  private lookX = 0;
  private lookY = 0;
  private disposed = false;
  private webglLost = false;

  private constructor(options: CubismLive2DModelOptions) {
    this.canvas = options.canvas;
    this.modelPath = resolveModelEntryUrl(options.modelPath);
    this.modelBaseUrl = createModelBaseUrl(options.modelPath);
    this.autoIdle = options.autoIdle ?? false;
    this.fitMode = options.fitMode ?? "stage";
    this.externalAbortSignal = options.abortSignal;
    if (this.externalAbortSignal?.aborted) {
      this.abortResourceLoads(this.externalAbortSignal.reason);
    } else {
      this.externalAbortSignal?.addEventListener("abort", this.handleExternalAbort, {
        once: true
      });
    }
    this.onHit = options.onHit;
    this.onError = options.onError;

    // Cubism's bundled WebGL shaders use GLSL ES 1.00 (`attribute`, `varying`,
    // `gl_FragColor` and `texture2D`). They therefore must compile against a
    // WebGL 1 context; requesting WebGL 2 first makes modern GPUs reject them.
    const gl =
      this.canvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false
      }) ??
      this.canvas.getContext("experimental-webgl", {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false
      }) as WebGLRenderingContext | null;

    if (!gl) {
      throw new Error("WebGL is not available.");
    }

    this.gl = gl;
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
  }

  async load(): Promise<void> {
    this.throwIfAborted();
    const settingBuffer = await fetchLive2DArrayBuffer(this.modelPath, this.abortSignal);
    this.throwIfAborted();
    this.setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);

    const modelFileName = this.setting.getModelFileName();

    if (!modelFileName) {
      throw new Error("model3.json does not reference a .moc3 file.");
    }

    const mocBuffer = await fetchLive2DArrayBuffer(
      resolveModelResource(this.modelBaseUrl, modelFileName),
      this.abortSignal
    );
    this.throwIfAborted();
    this.moc = CubismMoc.create(mocBuffer, true);
    this.throwIfAborted();
    const rawModel = this.moc.createModel();

    if (!rawModel) {
      throw new Error("Failed to create Cubism model from .moc3.");
    }

    this.model = rawModel;
    this.modelMatrix = new CubismModelMatrix(
      this.model.getCanvasWidth(),
      this.model.getCanvasHeight()
    );
    this.model.saveParameters();
    this.setupLayout();
    this.model.update();
    this.modelBounds = this.measureModelBounds();
    await this.loadPose();
    this.throwIfAborted();
    this.setupEffects();
    // Motion and expression files stay off the first-frame path and load on first use.
    this.idleGroup = getFirstAvailableMotionGroup(this.setting);
    await this.setupRendererAndTextures();
    this.throwIfAborted();
    this.resetToNeutralFace();
    this.pose?.updateParameters(this.model, 0);
    this.model.update();
    this.resize();
    this.draw();
    this.throwIfAborted();
    this.startLoop();
    // Physics is optional and starts only after a real neutral frame has been drawn.
    this.loadPhysicsAfterFirstDraw();
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
    this.width = nextWidth;
    this.height = nextHeight;
    this.renderer?.setRenderTargetSize(nextWidth, nextHeight);
    this.fitModelToViewport();
  }

  async motion(
    group: string,
    index = 0,
    priority: CubismMotionPriority = "normal"
  ): Promise<boolean> {
    if (!this.setting || !this.model || this.disposed) {
      return false;
    }

    const motionPriority = motionPriorities[priority];

    if (priority !== "force" && motionPriority < this.reservedPriority) {
      return false;
    }

    const operationSequence = ++this.motionOperationSequence;
    this.pendingMotionOperationSequence = operationSequence;
    this.reservedPriority = motionPriority;

    try {
      const motion = await this.getMotion(group, index);

      if (this.disposed || operationSequence !== this.motionOperationSequence) {
        return false;
      }

      this.pendingMotionOperationSequence = undefined;

      if (!motion) {
        this.reservedPriority = 0;
        return false;
      }

      this.motionManager.startMotion(motion, false);
      return true;
    } catch (error) {
      if (operationSequence === this.motionOperationSequence) {
        this.pendingMotionOperationSequence = undefined;
        this.reservedPriority = 0;
      }

      if (!isLive2DLoadAborted(error, this.abortSignal) && !this.disposed) {
        console.warn("Failed to load Live2D motion", { group, index, error });
      }

      return false;
    }
  }

  async expression(id?: string | number): Promise<boolean> {
    if (
      id === undefined ||
      id === null ||
      !this.setting ||
      !this.model ||
      this.disposed
    ) {
      return false;
    }

    const operationSequence = ++this.expressionOperationSequence;

    try {
      const expression = await this.getExpression(id);

      if (
        !expression ||
        this.disposed ||
        operationSequence !== this.expressionOperationSequence
      ) {
        return false;
      }

      this.expressionManager.startMotion(expression, false);
      return true;
    } catch (error) {
      if (!isLive2DLoadAborted(error, this.abortSignal) && !this.disposed) {
        console.warn("Failed to load Live2D expression", { id, error });
      }

      return false;
    }
  }

  resetToNeutralFace(): void {
    if (!this.model) {
      return;
    }

    this.motionManager.stopAllMotions();
    this.expressionManager.stopAllMotions();
    this.motionOperationSequence += 1;
    this.expressionOperationSequence += 1;
    this.pendingMotionOperationSequence = undefined;
    this.pendingIdleMotion = undefined;
    this.reservedPriority = 0;
    this.targetLookX = 0;
    this.targetLookY = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.model.loadParameters();
    this.applyNeutralFaceParameters();
    this.model.saveParameters();
    this.model.update();
  }

  setParameterValue(id: string, value: number, weight = 1): void {
    const parameterId = CubismFramework.getIdManager().getId(id);
    this.model?.setParameterValueById(parameterId, value, weight);
  }

  setPartOpacity(idOrIndex: string | number, opacity: number): void {
    if (!this.model) {
      return;
    }

    if (typeof idOrIndex === "number") {
      this.model.setPartOpacityByIndex(idOrIndex, opacity);
      return;
    }

    this.model.setPartOpacityById(CubismFramework.getIdManager().getId(idOrIndex), opacity);
  }

  lookAtClientPoint(clientX: number, clientY: number): void {
    this.updatePointerTargetFromClientPoint(clientX, clientY);
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }

    this.externalAbortSignal?.removeEventListener("abort", this.handleExternalAbort);
    this.abortResourceLoads();
    this.disposed = true;
    this.motionOperationSequence += 1;
    this.expressionOperationSequence += 1;
    this.pendingIdleMotion = undefined;
    this.pendingMotionOperationSequence = undefined;
    window.cancelAnimationFrame(this.animationFrame);
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    for (const texture of this.textures) {
      this.gl.deleteTexture(texture.id);
      if (texture.objectUrl) {
        window.URL.revokeObjectURL(texture.objectUrl);
      }
    }

    this.textures = [];
    this.motionManager.release();
    this.expressionManager.release();
    this.motions.clear((motion) => motion.release());
    this.expressions.clear((expression) => expression.release());
    if (this.physics) {
      CubismPhysics.delete(this.physics);
    }

    if (this.pose) {
      CubismPose.delete(this.pose);
    }

    if (this.eyeBlink) {
      CubismEyeBlink.delete(this.eyeBlink);
    }

    if (this.breath) {
      CubismBreath.delete(this.breath);
    }

    this.renderer?.release();
    if (this.moc && this.model) {
      this.moc.deleteModel(this.model);
    }
    this.moc?.release();
    this.setting?.release();
    releaseRuntime();
  }

  private setupLayout(): void {
    if (!this.setting || !this.modelMatrix) {
      return;
    }

    const layout = new Map<string, number>();
    this.setting.getLayoutMap(layout);
    this.modelMatrix.setupFromLayout(layout);
  }

  private fitModelToViewport(): void {
    if (!this.model || !this.modelMatrix) {
      return;
    }

    const bounds =
      this.modelBounds ??
      {
        left: -this.model.getCanvasWidth() / 2,
        right: this.model.getCanvasWidth() / 2,
        top: this.model.getCanvasHeight() / 2,
        bottom: -this.model.getCanvasHeight() / 2,
        width: this.model.getCanvasWidth(),
        height: this.model.getCanvasHeight()
      };
    const viewportRatio = this.width / Math.max(this.height, 1);
    const viewWidth = viewportRatio >= 1 ? viewportRatio * 2 : 2;
    const viewHeight = viewportRatio >= 1 ? 2 : 2 / viewportRatio;
    const fitScale = this.fitMode === "previewContain" ? previewFitScale : defaultFitScale;
    const paddingRatio = this.fitMode === "previewContain" ? previewPaddingRatio : bottomPaddingRatio;
    const scale = Math.min(
      viewWidth / Math.max(bounds.width, 0.0001),
      viewHeight / Math.max(bounds.height, 0.0001)
    ) * fitScale;
    const visibleWidth = bounds.width * scale;
    const visibleHeight = bounds.height * scale;
    const translateX = -((bounds.left + bounds.right) / 2) * scale;
    const targetBottom = -viewHeight / 2 + viewHeight * paddingRatio;
    const translateY = targetBottom - bounds.bottom * scale;
    const topAfterFit = translateY + bounds.top * scale;
    const maxTop = viewHeight / 2 - viewHeight * paddingRatio;
    const adjustedTranslateY =
      visibleHeight > viewHeight
        ? -((bounds.top + bounds.bottom) / 2) * scale
        : Math.min(translateY, maxTop - bounds.top * scale);

    this.modelMatrix.loadIdentity();
    this.modelMatrix.scale(scale, scale);
    this.modelMatrix.translate(
      Number.isFinite(visibleWidth) ? translateX : 0,
      Number.isFinite(topAfterFit) ? adjustedTranslateY : 0
    );
  }

  private measureModelBounds(): ModelBounds | undefined {
    const model = this.model;

    if (!model) {
      return undefined;
    }

    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    const drawableCount = model.getDrawableCount();

    for (let drawableIndex = 0; drawableIndex < drawableCount; drawableIndex += 1) {
      const vertexCount = model.getDrawableVertexCount(drawableIndex);
      const vertices = model.getDrawableVertices(drawableIndex);

      if (!vertexCount || vertices.length < 2) {
        continue;
      }

      for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
        const x = vertices[vertexIndex * 2];
        const y = vertices[vertexIndex * 2 + 1];

        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.max(top, y);
        bottom = Math.min(bottom, y);
      }
    }

    if (
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      !Number.isFinite(top) ||
      !Number.isFinite(bottom) ||
      left >= right ||
      bottom >= top
    ) {
      return undefined;
    }

    return {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: top - bottom
    };
  }

  private resolveExpressionIndex(id: string | number): number | undefined {
    if (!this.setting) {
      return undefined;
    }

    const requestedId = String(id);

    for (let index = 0; index < this.setting.getExpressionCount(); index += 1) {
      if (this.setting.getExpressionName(index) === requestedId) {
        return index;
      }
    }

    const indexMatch = /^index:(\d+)$/.exec(requestedId);
    const numericIndex = indexMatch
      ? Number(indexMatch[1])
      : /^\d+$/.test(requestedId)
        ? Number(requestedId)
        : Number.NaN;

    return Number.isInteger(numericIndex) &&
      numericIndex >= 0 &&
      numericIndex < this.setting.getExpressionCount()
      ? numericIndex
      : undefined;
  }

  private async getExpression(id: string | number): Promise<ACubismMotion | undefined> {
    const setting = this.setting;
    const index = this.resolveExpressionIndex(id);

    if (!setting || index === undefined) {
      return undefined;
    }

    const key = `index:${index}`;

    return this.expressions.getOrLoad(key, async () => {
      const name = setting.getExpressionName(index);
      const fileName = setting.getExpressionFileName(index);

      if (!name || !fileName) {
        return undefined;
      }

      const buffer = await fetchLive2DArrayBuffer(
        resolveModelResource(this.modelBaseUrl, fileName),
        this.abortSignal
      );
      this.throwIfAborted();
      const expression = CubismExpressionMotion.create(buffer, buffer.byteLength);

      if (!expression) {
        return undefined;
      }

      try {
        this.throwIfAborted();
        return expression;
      } catch (error) {
        expression.release();
        throw error;
      }
    });
  }

  private loadPhysicsAfterFirstDraw(): void {
    void this.loadPhysics().catch((error: unknown) => {
      if (!isLive2DLoadAborted(error, this.abortSignal) && !this.disposed) {
        console.warn("Failed to load optional Live2D physics", error);
      }
    });
  }

  private async loadPhysics(): Promise<void> {
    const physicsFileName = this.setting?.getPhysicsFileName();

    if (!physicsFileName) {
      return;
    }

    const buffer = await fetchLive2DArrayBuffer(
      resolveModelResource(this.modelBaseUrl, physicsFileName),
      this.abortSignal
    );
    this.throwIfAborted();
    const physics = CubismPhysics.create(buffer, buffer.byteLength);

    try {
      this.throwIfAborted();
      this.physics = physics;
    } catch (error) {
      CubismPhysics.delete(physics);
      throw error;
    }
  }

  private async loadPose(): Promise<void> {
    const poseFileName = this.setting?.getPoseFileName();

    if (!poseFileName) {
      return;
    }

    const buffer = await fetchLive2DArrayBuffer(
      resolveModelResource(this.modelBaseUrl, poseFileName),
      this.abortSignal
    );
    this.throwIfAborted();
    const pose = CubismPose.create(buffer, buffer.byteLength);

    try {
      this.throwIfAborted();
      this.pose = pose;
    } catch (error) {
      CubismPose.delete(pose);
      throw error;
    }
  }

  private async getMotion(group: string, index: number): Promise<CubismMotion | undefined> {
    const setting = this.setting;

    if (!setting) {
      return undefined;
    }

    const key = normalizeMotionKey(group, index);

    if (index < 0 || index >= setting.getMotionCount(group)) {
      return undefined;
    }

    const motionFileName = setting.getMotionFileName(group, index);

    if (!motionFileName) {
      return undefined;
    }

    const fadeInTime = setting.getMotionFadeInTimeValue(group, index);
    const fadeOutTime = setting.getMotionFadeOutTimeValue(group, index);

    return this.motions.getOrLoad(key, async () => {
      const buffer = await fetchLive2DArrayBuffer(
        resolveModelResource(this.modelBaseUrl, motionFileName),
        this.abortSignal
      );
      this.throwIfAborted();
      const motion = CubismMotion.create(buffer, buffer.byteLength);

      if (!motion) {
        return undefined;
      }

      try {
        this.throwIfAborted();

        if (fadeInTime >= 0) {
          motion.setFadeInTime(fadeInTime);
        }

        if (fadeOutTime >= 0) {
          motion.setFadeOutTime(fadeOutTime);
        }

        motion.setEffectIds(this.eyeBlinkIds, this.lipSyncIds);
        return motion;
      } catch (error) {
        motion.release();
        throw error;
      }
    });
  }

  private applyNeutralFaceParameters(): void {
    if (!this.model) {
      return;
    }

    for (let index = 0; index < this.model.getParameterCount(); index += 1) {
      const id = this.model.getParameterId(index).getString();

      if (!isNeutralFaceParameterId(id)) {
        continue;
      }

      const defaultValue = this.model.getParameterDefaultValue(index);

      if (Number.isFinite(defaultValue)) {
        this.model.setParameterValueByIndex(index, defaultValue, 1);
      }
    }
  }

  private setupEffects(): void {
    if (!this.setting || !this.model) {
      return;
    }

    if (this.setting.getEyeBlinkParameterCount() > 0) {
      this.eyeBlink = CubismEyeBlink.create(this.setting);
    }

    this.eyeBlinkIds = Array.from(
      { length: this.setting.getEyeBlinkParameterCount() },
      (_, index) => this.setting?.getEyeBlinkParameterId(index)
    ).filter((id): id is CubismIdHandle => Boolean(id));
    this.lipSyncIds = Array.from(
      { length: this.setting.getLipSyncParameterCount() },
      (_, index) => this.setting?.getLipSyncParameterId(index)
    ).filter((id): id is CubismIdHandle => Boolean(id));

    this.breath = CubismBreath.create();
    this.breath.setParameters([
      new BreathParameterData(
        CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamAngleX),
        0,
        15,
        6.5345,
        0.5
      ),
      new BreathParameterData(
        CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamAngleY),
        0,
        8,
        3.5345,
        0.5
      ),
      new BreathParameterData(
        CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamAngleZ),
        0,
        10,
        5.5345,
        0.5
      ),
      new BreathParameterData(
        CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamBodyAngleX),
        0,
        4,
        15.5345,
        0.5
      ),
      new BreathParameterData(
        CubismFramework.getIdManager().getId(CubismDefaultParameterId.ParamBreath),
        0.5,
        0.5,
        3.2345,
        1
      )
    ]);
  }

  private async setupRendererAndTextures(): Promise<void> {
    if (!this.setting || !this.model) {
      return;
    }

    this.renderer = new CubismRenderer_WebGL(this.canvas.width, this.canvas.height);
    this.renderer.initialize(this.model);
    this.renderer.startUp(this.gl);
    this.renderer.setIsPremultipliedAlpha(true);
    await Promise.all([
      this.renderer.loadShaders(this.shaderPath, this.abortSignal),
      this.loadTextures()
    ]);
    this.throwIfAborted();
  }

  private async loadTextures(): Promise<void> {
    if (!this.setting || !this.renderer) {
      return;
    }

    const textureCount = this.setting.getTextureCount();

    for (let index = 0; index < textureCount; index += 1) {
      const textureFileName = this.setting.getTextureFileName(index);

      if (!textureFileName) {
        continue;
      }

      const texturePath = resolveModelResource(this.modelBaseUrl, textureFileName);
      const { image, objectUrl } = await loadLive2DImage(
        texturePath,
        this.abortSignal
      ).catch(async (error: unknown) => {
        if (isLive2DLoadAborted(error, this.abortSignal)) {
          throw error;
        }

        console.warn("Falling back to element texture loading", {
          texturePath,
          error
        });

        return {
          image: await loadLive2DElementImage(texturePath, this.abortSignal),
          objectUrl: undefined
        };
      });
      let texture: WebGLTexture | undefined;

      try {
        this.throwIfAborted();
        texture = createTexture(this.gl, image);
        this.throwIfAborted();
        this.renderer.bindTexture(index, texture);
        this.textures.push({ id: texture, image, path: texturePath, objectUrl });
      } catch (error) {
        if (texture) {
          this.gl.deleteTexture(texture);
        }
        if (objectUrl) {
          window.URL.revokeObjectURL(objectUrl);
        }
        throw error;
      }
    }
  }

  private abortResourceLoads(reason?: unknown): void {
    if (this.resourceAbortController.signal.aborted) {
      return;
    }

    if (reason === undefined) {
      this.resourceAbortController.abort();
    } else {
      this.resourceAbortController.abort(reason);
    }
  }

  private readonly handleExternalAbort = (): void => {
    this.abortResourceLoads(this.externalAbortSignal?.reason);
  };

  private throwIfAborted(): void {
    throwIfLive2DLoadAborted(this.abortSignal);

    if (this.disposed) {
      throw new Error("Live2D model load was canceled.");
    }
  }

  private startLoop(): void {
    this.lastFrameTime = window.performance.now();
    const frame = (time: number): void => {
      if (this.disposed) {
        return;
      }

      const deltaTimeSeconds = Math.min(0.1, Math.max(0, (time - this.lastFrameTime) / 1000));
      this.lastFrameTime = time;

      if (!this.webglLost) {
        this.update(deltaTimeSeconds);
        this.draw();
      }

      this.animationFrame = window.requestAnimationFrame(frame);
    };

    this.animationFrame = window.requestAnimationFrame(frame);
  }

  private update(deltaTimeSeconds: number): void {
    if (!this.model) {
      return;
    }

    this.userTimeSeconds += deltaTimeSeconds;
    this.model.loadParameters();

    let motionUpdated = false;

    if (this.motionManager.isFinished()) {
      if (this.pendingMotionOperationSequence === undefined) {
        this.reservedPriority = 0;
      }

      if (
        this.autoIdle &&
        this.idleGroup &&
        !this.pendingIdleMotion &&
        this.pendingMotionOperationSequence === undefined &&
        window.performance.now() >= this.idleRetryAt
      ) {
        const idleCount = this.setting?.getMotionCount(this.idleGroup) ?? 0;
        const index = idleCount > 1 ? Math.floor(Math.random() * idleCount) : 0;
        const idleMotion = this.motion(this.idleGroup, index, "idle");
        this.pendingIdleMotion = idleMotion;
        void idleMotion.then((started) => {
          if (this.pendingIdleMotion !== idleMotion) {
            return;
          }

          this.pendingIdleMotion = undefined;
          if (!started && !this.disposed) {
            this.idleRetryAt = window.performance.now() + 2000;
          }
        });
      }
    } else {
      motionUpdated = this.motionManager.updateMotion(this.model, deltaTimeSeconds);
    }

    this.model.saveParameters();
    this.expressionManager.updateMotion(this.model, deltaTimeSeconds);

    if (!motionUpdated) {
      this.eyeBlink?.updateParameters(this.model, deltaTimeSeconds);
    }

    this.breath?.updateParameters(this.model, deltaTimeSeconds);
    this.updateLookAt(deltaTimeSeconds);
    this.physics?.evaluate(this.model, deltaTimeSeconds);
    this.pose?.updateParameters(this.model, deltaTimeSeconds);
    this.model.update();
  }

  private draw(): void {
    if (!this.renderer || !this.model || !this.modelMatrix) {
      return;
    }

    const gl = this.gl;
    const viewport = [0, 0, this.width, this.height];

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.updateViewMatrix(this.viewMatrix);
    this.mvpMatrix.setMatrix(this.viewMatrix.getArray());
    this.mvpMatrix.multiplyByMatrix(this.modelMatrix);
    this.renderer.setMvpMatrix(this.mvpMatrix);
    this.renderer.setRenderState(null as unknown as WebGLFramebuffer, viewport);
    this.renderer.drawModel(this.shaderPath);
  }

  private hitTest(canvasX: number, canvasY: number): boolean {
    if (!this.model || !this.setting) {
      return false;
    }

    this.updateViewMatrix(this.viewMatrix);
    const pixelX = canvasX * (this.canvas.width / Math.max(this.canvas.clientWidth, 1));
    const pixelY = canvasY * (this.canvas.height / Math.max(this.canvas.clientHeight, 1));
    const screenX = (pixelX / Math.max(this.width, 1)) * 2 - 1;
    const screenY = 1 - (pixelY / Math.max(this.height, 1)) * 2;
    const viewX = this.viewMatrix.invertTransformX(screenX);
    const viewY = this.viewMatrix.invertTransformY(screenY);

    for (let index = 0; index < this.setting.getHitAreasCount(); index += 1) {
      if (this.isDrawableHit(this.setting.getHitAreaId(index), viewX, viewY)) {
        return true;
      }
    }

    return this.setting.getHitAreasCount() === 0 && this.isAnyVisibleDrawableHit(viewX, viewY);
  }

  private isDrawableHit(drawableId: CubismIdHandle, viewX: number, viewY: number): boolean {
    const model = this.model;

    if (!model) {
      return false;
    }

    const drawableIndex = model.getDrawableIndex(drawableId);

    if (drawableIndex < 0 || !model.getDrawableDynamicFlagIsVisible(drawableIndex)) {
      return false;
    }

    return this.isDrawableBoundsHit(drawableIndex, viewX, viewY);
  }

  private isAnyVisibleDrawableHit(viewX: number, viewY: number): boolean {
    const drawableCount = this.model?.getDrawableCount() ?? 0;

    for (let index = 0; index < drawableCount; index += 1) {
      if (this.model?.getDrawableDynamicFlagIsVisible(index) && this.isDrawableBoundsHit(index, viewX, viewY)) {
        return true;
      }
    }

    return false;
  }

  private isDrawableBoundsHit(drawableIndex: number, viewX: number, viewY: number): boolean {
    const model = this.model;

    if (!model) {
      return false;
    }

    const count = model.getDrawableVertexCount(drawableIndex);
    const vertices = model.getDrawableVertices(drawableIndex);

    if (!count || vertices.length < 2) {
      return false;
    }

    let left = vertices[0];
    let right = vertices[0];
    let top = vertices[1];
    let bottom = vertices[1];

    for (let index = 1; index < count; index += 1) {
      const x = vertices[index * 2];
      const y = vertices[index * 2 + 1];
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }

    if (!this.modelMatrix) {
      return false;
    }

    const modelX = this.modelMatrix.invertTransformX(viewX);
    const modelY = this.modelMatrix.invertTransformY(viewY);

    return left <= modelX && modelX <= right && top <= modelY && modelY <= bottom;
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.disposed || this.webglLost) {
      return;
    }

    this.updatePointerTarget(event);
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (this.hitTest(x, y)) {
      this.onHit?.();
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.updatePointerTarget(event);
  };

  private readonly handlePointerLeave = (): void => {
    this.targetLookX = 0;
    this.targetLookY = 0;
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.webglLost = true;
  };

  private readonly handleContextRestored = (): void => {
    this.webglLost = false;
    this.onError?.(new Error("Live2D WebGL context was restored; reload the model to rebuild renderer state."));
  };

  private updateViewMatrix(matrix: CubismMatrix44): void {
    const ratio = this.width / Math.max(this.height, 1);

    matrix.loadIdentity();
    if (this.width > this.height) {
      matrix.scaleRelative(1 / ratio, 1);
    } else {
      matrix.scaleRelative(1, ratio);
    }
  }

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

  private updateLookAt(deltaTimeSeconds: number): void {
    if (!this.model) {
      return;
    }

    const blend = 1 - Math.exp(-lookSmoothing * deltaTimeSeconds);
    this.lookX += (this.targetLookX - this.lookX) * blend;
    this.lookY += (this.targetLookY - this.lookY) * blend;
    const idManager = CubismFramework.getIdManager();

    this.model.addParameterValueById(idManager.getId(CubismDefaultParameterId.ParamAngleX), this.lookX * 30, 1);
    this.model.addParameterValueById(idManager.getId(CubismDefaultParameterId.ParamAngleY), this.lookY * 30, 1);
    this.model.addParameterValueById(idManager.getId(CubismDefaultParameterId.ParamAngleZ), this.lookX * this.lookY * -30, 1);
    this.model.addParameterValueById(idManager.getId(CubismDefaultParameterId.ParamBodyAngleX), this.lookX * 10, 1);
    this.model.addParameterValueById(idManager.getId(CubismDefaultParameterId.ParamEyeBallX), this.lookX, 1);
    this.model.addParameterValueById(idManager.getId(CubismDefaultParameterId.ParamEyeBallY), this.lookY, 1);
  }
}
