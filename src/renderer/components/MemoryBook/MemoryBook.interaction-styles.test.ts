import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("memory book page controls", () => {
  it("keeps the page-turn hit target stationary under the shared button active style", async () => {
    const [sharedTheme, memoryBookStyles] = await Promise.all([
      readFile(new URL("../../styles/themes/60-glass.css", import.meta.url), "utf8"),
      readFile(new URL("../../styles/surfaces/75-memory-book.css", import.meta.url), "utf8")
    ]);

    expect(sharedTheme).toContain("button:active:not(:disabled)");
    expect(sharedTheme).toContain("transform: translateY(1px)");
    expect(memoryBookStyles).toContain("top: calc(50% - 22px)");
    expect(memoryBookStyles).toContain(
      ".memoryPageTurnButton:active:not(:disabled) { transform: none; }"
    );
  });
});
