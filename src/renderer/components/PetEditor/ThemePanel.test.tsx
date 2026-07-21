import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PetCustomTheme, PetDefinition } from "../../../shared/types/pet";
import { ThemePanel } from "./ThemePanel";

const importedTheme: PetCustomTheme = {
  id: "mint-plaid",
  name: "薄荷格纹",
  description: "当前桌宠的导入主题。",
  version: 1,
  tokens: {
    background: "#f3fbf8",
    surface: "#ffffff",
    text: "#273047",
    mutedText: "#6d7f89",
    accent: "#0f7281",
    border: "#668987"
  }
};

function createPet(customTheme?: PetCustomTheme): PetDefinition {
  return {
    id: "theme-test-pet",
    name: "主题测试桌宠",
    description: "用于验证主题卡片。",
    modelPath: "",
    personaPrompt: "",
    capabilities: { chat: true, voiceOutput: false, subtitles: true },
    details: { role: "", personality: "", scenes: [], features: [] },
    uiSettings: {
      theme: customTheme ? "custom" : "soft",
      ...(customTheme ? { customTheme } : {})
    }
  };
}

beforeEach(() => {
  vi.stubGlobal("document", {
    getElementById: vi.fn(() => null)
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemePanel", () => {
  it("shows a right-bottom delete control only for the imported theme card", () => {
    const markup = renderToStaticMarkup(
      <ThemePanel pet={createPet(importedTheme)} onDirtyChange={vi.fn()} />
    );

    expect(markup).toContain('class="themeCardDelete"');
    expect(markup).toContain('aria-label="删除导入主题「薄荷格纹」"');
    expect(markup).toContain("themeCardDelete");
  });

  it("does not show delete controls when the pet only uses a built-in theme", () => {
    const markup = renderToStaticMarkup(<ThemePanel pet={createPet()} onDirtyChange={vi.fn()} />);

    expect(markup).not.toContain("themeCardDelete");
    expect(markup).toContain("软糖风");
  });
});
