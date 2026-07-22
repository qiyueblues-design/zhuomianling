import { describe, expect, it } from "vitest";
import { buildMoodSystemPrompt } from "./moodPrompt";

describe("mood system prompt", () => {
  it("describes mood behavior without duplicating the output protocol", () => {
    expect(buildMoodSystemPrompt("calm")).toContain("心情只允许调整本轮语气");
    expect(buildMoodSystemPrompt("calm")).toContain(
      "必须结合角色人设、本轮语境和双方互动场景评估变化"
    );
    expect(buildMoodSystemPrompt("calm")).toContain("不得按通用的正负面倾向机械打分");
    expect(buildMoodSystemPrompt("calm")).toContain("当前回复契约包含 moodDelta");
    expect(buildMoodSystemPrompt("calm")).not.toContain("只输出");
  });

  it("gives calm an explicit baseline instead of comparing it with itself", () => {
    const calm = buildMoodSystemPrompt("calm");
    expect(calm).toContain("当前处于平静心情。请以自然、稳定的日常状态回复：");
    expect(calm).toContain("保持稳定、自然、适度克制的日常情绪");
    expect(calm).not.toContain("与平静状态的差异");
    expect(buildMoodSystemPrompt("joyful")).toContain("当前回复须自然体现以下心情表现：");
  });
});
