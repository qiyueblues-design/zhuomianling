import { describe, expect, it } from "vitest";
import { buildAiMessages, type PromptBuilderChatMessage } from "./promptBuilder";

describe("buildAiMessages", () => {
  it("submits conversation only and leaves system authority to main", () => {
    expect(buildAiMessages({ messages: [], nextUserText: "你好" })).toEqual([
      { role: "user", content: "你好" }
    ]);
  });

  it("preserves safe structured assistant history without inventing fields", () => {
    const messages = buildAiMessages({
      messages: [
        { role: "user", text: "上一轮" },
        {
          role: "pet",
          text: "原句",
          voiceText: "translated",
          aiStructuredContent: '{"reply":"原句","moodDelta":4,"emotion":"normal"}'
        }
      ],
      nextUserText: "继续"
    });
    expect(messages).toEqual([
      { role: "user", content: "上一轮" },
      {
        role: "assistant",
        content: '{"reply":"原句","moodDelta":4,"emotion":"normal"}'
      },
      { role: "user", content: "继续" }
    ]);
  });

  it("filters transient messages and keeps only the latest twelve history items", () => {
    const history: PromptBuilderChatMessage[] = [
      { role: "user", text: "会被裁掉" },
      { role: "pet", text: "思考中", status: "thinking" },
      { role: "pet", text: "失败", status: "error" },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: "user" as const,
        text: `历史 ${index + 1}`
      }))
    ];
    const messages = buildAiMessages({ messages: history, nextUserText: "新问题" });
    expect(messages).toHaveLength(13);
    expect(messages[0]).toEqual({ role: "user", content: "历史 1" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "新问题" });
  });
});
