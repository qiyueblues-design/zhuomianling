import { describe, expect, it } from "vitest";
import type { PetDefinition } from "../../shared/types/pet";
import { buildAiMessages, type PromptBuilderChatMessage } from "./promptBuilder";

function createPetDefinition(overrides: Partial<PetDefinition> = {}): PetDefinition {
  return {
    id: "test-pet",
    name: "Test Pet",
    description: "A test pet.",
    modelPath: "pet-resource://local/test-pet/live2d/model.model3.json",
    personaPrompt: "你是测试桌宠，说话温柔但简洁。",
    capabilities: {
      chat: true,
      voiceOutput: false,
      subtitles: true
    },
    details: {
      role: "测试桌宠",
      personality: "温柔",
      scenes: ["测试"],
      features: []
    },
    ...overrides
  };
}

describe("buildAiMessages", () => {
  it("builds a fallback system prompt and the current user message", () => {
    const messages = buildAiMessages({
      messages: [],
      nextUserText: "你好",
      voiceReplyEnabled: false
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "system",
      content: expect.stringContaining("你是一个桌面宠物聊天助手。")
    });
    expect(messages[0].content).toContain("只输出 JSON，不输出 Markdown 或解释。");
    expect(messages[0].content).toContain('只输出这个 JSON 结构：{"reply":"给用户看的回复"}。');
    expect(messages[0].content).toContain("reply 只写角色实际对用户说出口的话。");
    expect(messages[0].content).toContain("禁止在 reply 中输出心理活动、旁白、动作描写");
    expect(messages[0].content).toContain("reply 使用中文。");
    expect(messages[1]).toEqual({
      role: "user",
      content: "你好"
    });
  });

  it("adds persona, voiceText, reply preferences, and expression instructions when configured", () => {
    const pet = createPetDefinition({
      personaSettings: {
        chatLanguage: "en",
        replyLength: "short"
      },
      voiceModelSettings: {
        enabled: true,
        connected: true,
        referenceText: "こんにちは",
        language: "ja",
        playMode: "sentence"
      },
      expressions: {
        normal: "normal.exp3.json",
        happy: "happy.exp3.json"
      },
      expressionDescriptions: {
        normal: "平静",
        happy: "开心"
      }
    });
    const messages = buildAiMessages({
      petDefinition: pet,
      messages: [],
      nextUserText: "Tell me something good.",
      voiceReplyEnabled: false
    });
    const systemPrompt = messages[0].content;

    expect(systemPrompt).toContain("你是测试桌宠，说话温柔但简洁。");
    expect(systemPrompt).toContain("下面是你要扮演的桌宠人设，请按照这个人设与用户聊天。");
    expect(systemPrompt).toContain("不要复述人设内容，也不要跳出角色解释规则。");
    expect(systemPrompt).toContain(
      '只输出这个 JSON 结构：{"voiceText":"给语音服务朗读的文本","reply":"给用户看的回复","emotion":"表情标签"}。'
    );
    expect(systemPrompt).toContain("reply 使用英语。");
    expect(systemPrompt).toContain("reply 长度：短，尽量一到两句话。");
    expect(systemPrompt).toContain("voiceText 使用日语。");
    expect(systemPrompt).toContain("必须覆盖 reply 的每一句、每个分句和所有关键信息");
    expect(systemPrompt).toContain("禁止摘要、缩短、跳过后半句或只翻译前半句");
    expect(systemPrompt).toContain("- normal: 平静");
    expect(systemPrompt).toContain("- happy: 开心");
  });

  it("omits voiceText when chat and voice output languages match", () => {
    const pet = createPetDefinition({
      personaSettings: {
        chatLanguage: "zh",
        replyLength: "short"
      },
      voiceModelSettings: {
        enabled: true,
        connected: true,
        referenceText: "你好",
        language: "zh",
        playMode: "sentence"
      }
    });
    const messages = buildAiMessages({
      petDefinition: pet,
      messages: [
        {
          role: "pet",
          text: "原句",
          voiceText: "被改写的原句",
          aiRawContent: '{"voiceText":"被改写的原句","reply":"原句","emotion":"normal"}'
        }
      ],
      nextUserText: "继续",
      voiceReplyEnabled: false
    });
    const systemPrompt = messages[0].content;

    expect(systemPrompt).toContain('只输出这个 JSON 结构：{"reply":"给用户看的回复"}。');
    expect(systemPrompt).not.toContain('"voiceText":"给语音服务朗读的文本"');
    expect(systemPrompt).not.toContain("voiceText 使用");
    expect(messages[1].content).toBe('{"reply":"原句","emotion":"normal"}');
  });

  it("filters transient messages, keeps the latest twelve history items, and preserves assistant raw content", () => {
    const history: PromptBuilderChatMessage[] = [
      {
        role: "user",
        text: "会被裁掉"
      },
      {
        role: "pet",
        text: "思考中...",
        status: "thinking"
      },
      {
        role: "pet",
        text: "失败",
        status: "error"
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        role: "user" as const,
        text: `历史 ${index + 1}`
      })),
      {
        role: "pet",
        text: "保留回复",
        aiRawContent: '{"reply":"保留回复","emotion":"normal"}'
      }
    ];
    const messages = buildAiMessages({
      petDefinition: createPetDefinition(),
      messages: history,
      nextUserText: "新问题",
      voiceReplyEnabled: false
    });

    expect(messages).toHaveLength(14);
    expect(messages.slice(1, -1).map((message) => message.content)).toEqual(
      [
        ...Array.from({ length: 11 }, (_, index) => `历史 ${index + 1}`),
        '{"reply":"保留回复","emotion":"normal"}'
      ]
    );
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "新问题"
    });
  });
});
