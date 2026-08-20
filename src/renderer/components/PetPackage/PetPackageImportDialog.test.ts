import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("pet package import dialog sequencing", () => {
  it("waits for real import progress before showing hash verification", async () => {
    const source = await readFile(new URL("./PetPackageImportDialog.tsx", import.meta.url), "utf8");
    const chooseStart = source.indexOf("const choosePackage = async");
    const beginImport = source.indexOf("petPackage.beginImport()", chooseStart);
    const chooseEnd = source.indexOf("const close = async", beginImport);
    const beforeSystemPickerReturns = source.slice(chooseStart, beginImport);
    const choosePackageBody = source.slice(chooseStart, chooseEnd);

    expect(chooseStart).toBeGreaterThan(-1);
    expect(beginImport).toBeGreaterThan(chooseStart);
    expect(beforeSystemPickerReturns).not.toContain('setStep("checking")');
    expect(beforeSystemPickerReturns).not.toContain("setShowChecking(true)");
    expect(choosePackageBody).not.toContain('setStep("checking")');
    expect(source).toContain('next.status === "running" && !checkingStartedRef.current');
    expect(source).toContain('setStep("checking")');
  });

  it("uses shared provider presets and requires a returned model before capability testing", async () => {
    const source = await readFile(new URL("./PetPackageImportDialog.tsx", import.meta.url), "utf8");

    expect(source).toContain("aiProviderOptions.map");
    expect(source).toContain('{ value: "custom", label: "自定义" }');
    expect(source).toContain("petPackage.listImportAiModels");
    expect(source).toContain("<PetPackageChoice searchable");
    expect(source).not.toContain("<select");
    expect(source).not.toContain("<datalist");
    expect(source).not.toContain("setProviderName(e.target.value)");
    expect(source).not.toContain("<span>服务名称</span>");
  });

  it("always releases the install loading state after commit", async () => {
    const source = await readFile(new URL("./PetPackageImportDialog.tsx", import.meta.url), "utf8");
    const commitStart = source.indexOf("const commit = async");
    const commitEnd = source.indexOf("const stageLabel", commitStart);
    const commitBody = source.slice(commitStart, commitEnd);

    expect(commitStart).toBeGreaterThan(-1);
    expect(commitBody).toContain("try {");
    expect(commitBody).toContain("catch (reason: unknown)");
    expect(commitBody).toContain("finally {");
    expect(commitBody).toContain("setBusy(false)");
    expect(source).toContain('if (next.status !== "running") setBusy(false);');
  });
});
