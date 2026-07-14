import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isForbiddenReleasePath } from "../../../../scripts/release-asset-policy.mjs";

describe("M10 memory runtime release boundary", () => {
  it("packages only the prepared audited runtime as an external resource", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(new URL("../../../../package.json", import.meta.url), "utf8")
    );

    expect(packageJson.build.extraResources).toEqual([
      {
        from: ".cache/memory-sidecar-release",
        to: "memory-sidecar",
        filter: ["**/*"]
      }
    ]);
    expect(packageJson.scripts.pack).toContain("verify:memory-runtime");
    expect(packageJson.scripts["dist:win"]).toContain("verify:memory-runtime");
    expect(packageJson.scripts["verify:packed-assets"]).toBe("node scripts/verify-packed-assets.mjs");
  });

  it("keeps development and private model/index artifacts out of dist and app.asar", () => {
    for (const file of [
      "dist/model.safetensors",
      "dist/model_int8.onnx",
      "dist/runtime.whl",
      "dist/memory/ledger.sqlite3",
      "dist/.cache/memory-sidecar/runtime/python.exe"
    ]) expect(isForbiddenReleasePath(file)).toBe(true);
  });

  it("uses the project-produced official model fingerprint on both sides", async () => {
    const python = await fs.readFile(
      new URL("../../../../sidecar/memory/desktop_pet_memory_sidecar/embedding_runtime.py", import.meta.url),
      "utf8"
    );
    const typescript = await fs.readFile(new URL("./MemuMemoryBackend.ts", import.meta.url), "utf8");
    const recall = await fs.readFile(new URL("./memoryRecall.ts", import.meta.url), "utf8");

    expect(python).toContain('CONVERSION_ID = "desktop-pet/export-bge-int8.py"');
    expect(python).toContain("848c2ccd9277d9b36e830d1cc6c27644b78764b210d7409078d7db6f06b6ed20");
    expect(python).not.toContain('CONVERSION_ID = "Xenova/');
    expect(typescript).toContain("848c2ccd9277d9b3:48cea5d44424912a");
    expect(recall).toContain('"production-bge-int8"');
  });

  it("prevents packaged sidecar imports from modifying application resources", async () => {
    const source = await fs.readFile(new URL("./MemorySidecarClient.ts", import.meta.url), "utf8");
    expect(source).toContain('PYTHONDONTWRITEBYTECODE: "1"');
  });
});
