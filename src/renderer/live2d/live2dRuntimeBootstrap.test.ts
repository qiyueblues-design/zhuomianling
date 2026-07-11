import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const directoryPath = path.dirname(fileURLToPath(import.meta.url));
let runtimeSource = "";

beforeAll(async () => {
  runtimeSource = await fs.readFile(path.join(directoryPath, "live2dRuntime.ts"), "utf8");
});

describe("Cubism Core bootstrap readiness", () => {
  it("waits for the async Core exports before starting the Framework", () => {
    const bootstrapStart = runtimeSource.indexOf("const pendingRuntime = Promise.resolve()");
    const readyWait = runtimeSource.indexOf("await waitForLive2DCubismCoreReady()");
    const frameworkStartup = runtimeSource.indexOf("CubismFramework.startUp(option)");

    expect(bootstrapStart).toBeGreaterThan(-1);
    expect(readyWait).toBeGreaterThan(bootstrapStart);
    expect(frameworkStartup).toBeGreaterThan(readyWait);
  });

  it("probes the Core version API and retries transient initialization failures", () => {
    const readinessCheck = runtimeSource.slice(
      runtimeSource.indexOf("export function isLive2DCubismCoreReady"),
      runtimeSource.indexOf("function waitForLive2DCubismCoreReady")
    );

    expect(readinessCheck).toContain("Live2DCubismCore.Version.csmGetVersion()");
    expect(readinessCheck).toContain("Number.isFinite");
    expect(readinessCheck).toContain("catch");
  });
});
