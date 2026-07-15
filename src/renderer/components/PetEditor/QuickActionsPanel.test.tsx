import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PetDefinition } from "../../../shared/types/pet";
import {
  hasQuickActionsSettingsChanges,
  QuickActionsPanel,
  type QuickActionsSettingsValues
} from "./QuickActionsPanel";

function createPet(desktopScale?: number): PetDefinition {
  return {
    id: "quick-actions-pet",
    name: "快捷操作测试桌宠",
    description: "用于验证快捷操作的测试桌宠。",
    modelPath: "pet-resource://local/quick-actions-pet/live2d/model.model3.json",
    avatar: "测",
    personaPrompt: "",
    capabilities: {
      chat: true,
      voiceOutput: false,
      subtitles: true
    },
    details: {
      role: "",
      personality: "",
      scenes: [],
      features: []
    },
    expressions: {},
    expressionDescriptions: {},
    uiSettings: {
      theme: "soft",
      clickThroughOpacity: 0.45,
      cursorFollowEnabled: true,
      ...(desktopScale === undefined ? {} : { desktopScale })
    },
    lines: {},
    subtitleStyle: { tone: "soft" }
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

describe("QuickActionsPanel desktop scale", () => {
  it("renders a default 100% slider with the 70%-150% range and 5% steps", () => {
    const markup = renderToStaticMarkup(
      <QuickActionsPanel pet={createPet()} onDirtyChange={vi.fn()} />
    );

    expect(markup).toContain("桌宠大小");
    expect(markup).toContain("恢复 100%");
    expect(markup).toContain('id="desktop-pet-scale"');
    expect(markup).toContain('min="70"');
    expect(markup).toContain('max="150"');
    expect(markup).toContain('step="5"');
    expect(markup).toContain('value="100"');
    expect(markup).toContain('aria-valuetext="100%"');
  });

  it("shows the pet's saved scale instead of falling back to 100%", () => {
    const markup = renderToStaticMarkup(
      <QuickActionsPanel pet={createPet(1.35)} onDirtyChange={vi.fn()} />
    );

    expect(markup).toContain('value="135"');
    expect(markup).toContain('aria-valuetext="135%"');
  });

  it("groups the click-through explanation with its opacity control", () => {
    const markup = renderToStaticMarkup(
      <QuickActionsPanel pet={createPet()} onDirtyChange={vi.fn()} />
    );

    expect(markup).toContain("<legend>点击穿透</legend>");
    expect(markup).toContain('for="click-through-opacity"');
    expect(markup).toContain('id="click-through-opacity"');
    expect(markup).not.toContain('class="settingsRowHeader"');
  });

  it("marks changes to size, transparency, or cursor following as unsaved", () => {
    const saved: QuickActionsSettingsValues = {
      clickThroughOpacity: 0.45,
      cursorFollowEnabled: true,
      desktopScale: 1
    };

    expect(hasQuickActionsSettingsChanges(saved, saved)).toBe(false);
    expect(hasQuickActionsSettingsChanges({ ...saved, desktopScale: 1.05 }, saved)).toBe(true);
    expect(hasQuickActionsSettingsChanges({ ...saved, clickThroughOpacity: 0.5 }, saved)).toBe(true);
    expect(hasQuickActionsSettingsChanges({ ...saved, cursorFollowEnabled: false }, saved)).toBe(true);
  });
});
