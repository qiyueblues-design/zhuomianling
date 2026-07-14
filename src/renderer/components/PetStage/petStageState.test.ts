import { describe, expect, it } from "vitest";
import type { PetVoiceModelSettings } from "../../../shared/types/pet";
import { buildVoiceDraft, getVoiceReadiness } from "./petStageState";

function createSettings(
  overrides: Partial<PetVoiceModelSettings> = {}
): PetVoiceModelSettings {
  return {
    enabled: true,
    connected: false,
    gptSoVitsRootPath: "C:/voice",
    sovitsModelPath: "C:/voice/model.pth",
    gptModelPath: "C:/voice/model.ckpt",
    referenceAudioPath: "C:/voice/reference.wav",
    referenceText: "你好",
    language: "zh",
    playMode: "sentence",
    ...overrides
  };
}

describe("桌宠详情声音配置兼容", () => {
  it("未配置声音模型时显示未就绪", () => {
    expect(getVoiceReadiness(undefined)).toEqual({
      ready: false,
      text: "未配置 GPT-SoVITS 本地路径",
      issue: expect.objectContaining({ code: "root-path" })
    });
  });

  it("兼容有参考音频但缺少旧版参考文本的配置", () => {
    const legacySettings = {
      ...createSettings(),
      referenceText: undefined
    } as unknown as PetVoiceModelSettings;

    expect(() => getVoiceReadiness(legacySettings)).not.toThrow();
    expect(getVoiceReadiness(legacySettings)).toEqual({
      ready: false,
      text: "参考文本缺失",
      issue: expect.objectContaining({
        code: "reference-text",
        guidance: expect.stringContaining("参考文本")
      })
    });
    expect(buildVoiceDraft("legacy-pet", legacySettings, true, false))
      .toBeUndefined();
  });

  it("拒绝只有空白参考文本的配置", () => {
    const settings = createSettings({ referenceText: "   " });

    expect(getVoiceReadiness(settings).ready).toBe(false);
    expect(buildVoiceDraft("pet", settings, true, false)).toBeUndefined();
  });

  it("为完整配置生成可连接草稿", () => {
    const settings = createSettings({ referenceText: "  测试文本  " });

    expect(getVoiceReadiness(settings)).toEqual({ ready: true, text: "可连接" });
    expect(buildVoiceDraft("pet", settings, true, false)).toMatchObject({
      petId: "pet",
      enabled: true,
      connected: false,
      referenceText: "测试文本",
      language: "zh"
    });
  });
});
