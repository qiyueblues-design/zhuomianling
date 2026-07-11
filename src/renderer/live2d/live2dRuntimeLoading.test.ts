import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const directoryPath = path.dirname(fileURLToPath(import.meta.url));
let runtimeSource = "";
let shaderSource = "";
let rendererSource = "";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Unable to find source range: ${start} -> ${end}`);
  }

  return source.slice(startIndex, endIndex);
}

beforeAll(async () => {
  [runtimeSource, shaderSource, rendererSource] = await Promise.all([
    fs.readFile(path.join(directoryPath, "live2dRuntime.ts"), "utf8"),
    fs.readFile(
      path.join(
        directoryPath,
        "cubism",
        "framework",
        "rendering",
        "cubismshader_webgl.ts"
      ),
      "utf8"
    ),
    fs.readFile(
      path.join(
        directoryPath,
        "cubism",
        "framework",
        "rendering",
        "cubismrenderer_webgl.ts"
      ),
      "utf8"
    )
  ]);
});

describe("Cubism 4/5 initial load plan", () => {
  it("keeps motions and expressions out of the first-frame critical path", () => {
    const loadMethod = sourceBetween(runtimeSource, "  async load(): Promise<void> {", "\n  resize(): void {");

    expect(loadMethod).not.toContain("loadMotions");
    expect(loadMethod).not.toContain("loadExpressions");
    expect(loadMethod).not.toContain("getMotion(");
    expect(loadMethod).not.toContain("getExpression(");
    expect(loadMethod.indexOf("this.pose?.updateParameters(this.model, 0);")).toBeGreaterThan(-1);
    expect(loadMethod.indexOf("this.pose?.updateParameters(this.model, 0);")).toBeLessThan(
      loadMethod.indexOf("this.draw();")
    );
    expect(loadMethod.indexOf("this.draw();")).toBeGreaterThan(-1);
    expect(loadMethod.indexOf("this.draw();")).toBeLessThan(
      loadMethod.indexOf("this.loadPhysicsAfterFirstDraw();")
    );
  });

  it("awaits cancelable shaders and textures before drawing once", () => {
    const rendererSetup = sourceBetween(
      runtimeSource,
      "  private async setupRendererAndTextures(): Promise<void> {",
      "\n  private async loadTextures(): Promise<void> {"
    );
    const textureLoader = sourceBetween(
      runtimeSource,
      "  private async loadTextures(): Promise<void> {",
      "\n  private abortResourceLoads"
    );

    expect(rendererSetup).toContain(
      "this.renderer.loadShaders(this.shaderPath, this.abortSignal)"
    );
    expect(rendererSetup).toContain("this.loadTextures()");
    expect(textureLoader).toContain("loadLive2DImage(");
    expect(textureLoader).toContain("this.abortSignal");
    expect(textureLoader.indexOf("isLive2DLoadAborted")).toBeLessThan(
      textureLoader.indexOf("loadLive2DElementImage")
    );
  });

  it("routes every model binary request through the same instance signal", () => {
    const binaryLoads = runtimeSource
      .split("fetchLive2DArrayBuffer(")
      .slice(1)
      .map((remainder) => remainder.slice(0, remainder.indexOf(");")));

    expect(binaryLoads).toHaveLength(6);
    for (const binaryLoad of binaryLoads) {
      expect(binaryLoad).toContain("this.abortSignal");
    }
    expect(runtimeSource).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("Cubism 4/5 deferred actions", () => {
  it("uses retryable per-instance deferred caches and operation sequences", () => {
    expect(runtimeSource).toContain(
      "new DeferredLive2DAssetCache<CubismMotion>()"
    );
    expect(runtimeSource).toContain(
      "new DeferredLive2DAssetCache<ACubismMotion>()"
    );
    expect(runtimeSource).toContain("this.motions.getOrLoad(key");
    expect(runtimeSource).toContain("this.expressions.getOrLoad(key");
    expect(runtimeSource).toContain("operationSequence !== this.motionOperationSequence");
    expect(runtimeSource).toContain("operationSequence !== this.expressionOperationSequence");
    expect(runtimeSource).toContain("!this.pendingIdleMotion");
  });

  it("passes the model instance signal to every deferred binary fetch", () => {
    const expressionLoader = sourceBetween(
      runtimeSource,
      "  private async getExpression(",
      "\n  private loadPhysicsAfterFirstDraw"
    );
    const motionLoader = sourceBetween(
      runtimeSource,
      "  private async getMotion(",
      "\n  private applyNeutralFaceParameters"
    );

    expect(expressionLoader).toMatch(
      /fetchLive2DArrayBuffer\([\s\S]*?this\.abortSignal/
    );
    expect(motionLoader).toMatch(
      /fetchLive2DArrayBuffer\([\s\S]*?this\.abortSignal/
    );
  });

  it("aborts instance resource work on destroy and allows Core bootstrap retry", () => {
    const destroyMethod = sourceBetween(
      runtimeSource,
      "  destroy(): void {",
      "\n  private setupLayout(): void {"
    );

    expect(runtimeSource).toContain(
      "private readonly resourceAbortController = new AbortController()"
    );
    expect(runtimeSource).toContain(
      'this.externalAbortSignal?.addEventListener("abort", this.handleExternalAbort'
    );
    expect(destroyMethod).toContain("this.abortResourceLoads();");
    expect(runtimeSource).toContain("runtimePromise = undefined;");
  });
});

describe("Cubism WebGL shader loading", () => {
  it("creates a WebGL 1 context for the bundled GLSL ES 1.00 shaders", () => {
    const constructor = sourceBetween(
      runtimeSource,
      "  private constructor(options: CubismLive2DModelOptions) {",
      "\n  async load(): Promise<void> {"
    );

    expect(constructor).toContain('this.canvas.getContext("webgl",');
    expect(constructor).toContain('this.canvas.getContext("experimental-webgl",');
    expect(constructor).not.toContain('this.canvas.getContext("webgl2",');
  });

  it("uses the shared signal-aware text loader with no raw fetch", () => {
    expect(shaderSource).toContain("fetchLive2DText(url, signal)");
    expect(shaderSource).not.toMatch(/\bfetch\s*\(/);
    expect(shaderSource).toContain(
      "public generateShaders(signal?: AbortSignal): Promise<void>"
    );
  });

  it("exposes an awaitable renderer API and resets failed loads for retry", () => {
    expect(rendererSource).toMatch(
      /public loadShaders\([\s\S]*?signal\?: AbortSignal[\s\S]*?\): Promise<void>/
    );
    expect(shaderSource).toContain("this._shaderLoadPromise = null");
    expect(shaderSource).toContain("this._shaderSets.length = 0");
    expect(shaderSource).toContain("return this.generateShaders(signal)");
  });

  it("does not reserve empty shader slots for the reused Normal + Over combination", () => {
    const shaderConstructor = sourceBetween(
      shaderSource,
      "  public constructor() {",
      "\n  public release(): void {"
    );

    expect(shaderConstructor).toContain("const generatedBlendCombinationCount =");
    expect(shaderConstructor).toMatch(
      /\(this\._alphaBlendValues\.length - 1\)\s*-\s*1;/
    );
    expect(shaderConstructor).toContain(
      "generatedBlendCombinationCount * ShaderType.ShaderType_Count"
    );
  });
});
