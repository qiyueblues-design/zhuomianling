// TIMED DIAGNOSTICS TEST MODULE: screen model capability tests.
import { describe, expect, it } from "vitest";
import { classifyScreenVisionModel } from "./screenVisionModelCapability";

describe("screen vision model-name routing", () => {
  it.each([
    ["OpenAI", "gpt-4o"],
    ["OpenRouter", "openai/gpt-4o"],
    ["阿里云 DashScope", "qwen3.5-omni-plus"],
    ["火山引擎", "doubao-1.5-vision-pro"],
    ["智谱", "glm-4.5v"],
    ["月之暗面", "kimi-k2.5"],
    ["百度智能云", "ernie-4.5-vl"],
    ["腾讯混元", "hunyuan-vision"],
    ["商汤", "SenseNova-V6"],
    ["阶跃星辰", "step-1o"],
    ["OpenAI Compatible", "internvl3"],
    ["中转站", "qwen/qwen2.5-vl-72b-instruct"],
    ["深度求索", "deepseek-vl2-small"],
    ["DeepSeek", "deepseek-v4-flash-vision-exp"],
    ["科大讯飞", "imagev3"]
  ])("classifies %s/%s as multimodal", (providerName, model) => {
    expect(classifyScreenVisionModel({ providerName, model })).toBe("multimodal");
  });

  it.each([
    ["DeepSeek", "deepseek-v4-flash"],
    ["DeepSeek", "deepseek-v4-pro"],
    ["DeepSeek", "deepseek-chat"],
    ["百川", "Baichuan4"],
    ["OpenAI", "gpt-3.5-turbo"],
    ["阿里云 DashScope", "qwen-max"],
    ["智谱", "glm-4-flash"]
  ])("classifies %s/%s as text-only", (providerName, model) => {
    expect(classifyScreenVisionModel({ providerName, model })).toBe("text-only");
  });

  it("does not turn an arbitrary alias into a known capability", () => {
    expect(classifyScreenVisionModel({ providerName: "OpenAI", model: "vision-alias" })).toBe("unknown");
    expect(classifyScreenVisionModel({ providerName: "中转站", baseUrl: "https://relay.example.com/v1", model: "default" })).toBe("unknown");
  });
});
