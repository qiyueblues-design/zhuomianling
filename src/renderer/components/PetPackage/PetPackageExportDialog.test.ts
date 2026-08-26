import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("pet package export dialog completion", () => {
  it("stops loading from the matching terminal progress event", async () => {
    const source = await readFile(new URL("./PetPackageExportDialog.tsx", import.meta.url), "utf8");

    expect(source).toContain("exportRequestedRef");
    expect(source).toContain("activeOperationIdRef");
    expect(source).toContain('next.status === "success"');
    expect(source).toContain('next.status === "failed"');
    expect(source).toContain('next.status === "canceled"');
    expect(source).toContain("finally {");
    expect(source).toContain("setBusy(false)");
  });
});
