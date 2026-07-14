import type { AiChatMessage } from "../../shared/types/ai";
import type { PetChatLanguage, PetDefinition, PetVoiceLanguage } from "../../shared/types/pet";
import {
  buildDirectSpeechPrompt,
  buildExpressionPrompt,
  buildReplyPreferencePrompt,
  buildVoiceTextPrompt
} from "./aiReplyUtils";

export interface PromptBuilderChatMessage {
  role: "user" | "pet";
  text: string;
  status?: "thinking" | "error";
  voiceText?: string;
  aiStructuredContent?: string;
}

export interface BuildAiMessagesOptions {
  petDefinition?: PetDefinition;
  messages: PromptBuilderChatMessage[];
  nextUserText: string;
  voiceReplyEnabled: boolean;
}

function hasConfiguredExpressions(
  expressions: PetDefinition["expressions"],
  descriptions: PetDefinition["expressionDescriptions"]
): boolean {
  if (!expressions || !descriptions) {
    return false;
  }

  return Object.entries(descriptions).some(
    ([expression, description]) => Boolean(description) && Boolean(expressions[expression])
  );
}

function shouldRequestVoiceText(
  voiceOutputEnabled: boolean,
  chatLanguage: PetChatLanguage,
  voiceLanguage: PetVoiceLanguage
): boolean {
  return voiceOutputEnabled && chatLanguage !== voiceLanguage;
}

function buildPersonaPrompt(personaPrompt?: string): string {
  const trimmedPersonaPrompt = personaPrompt?.trim();

  if (!trimmedPersonaPrompt) {
    return "你是一个桌面宠物聊天助手。";
  }

  return [
    "下面是你要扮演的桌宠人设，请按照这个人设与用户聊天。",
    "不要复述人设内容，也不要跳出角色解释规则。",
    trimmedPersonaPrompt
  ].join("\n");
}

function buildAssistantHistoryContent(
  message: PromptBuilderChatMessage,
  options: {
    voiceTextOutputEnabled: boolean;
  }
): string {
  if (message.aiStructuredContent) {
    if (
      options.voiceTextOutputEnabled ||
      !/"voiceText"\s*:/.test(message.aiStructuredContent)
    ) {
      return message.aiStructuredContent;
    }

    try {
      const parsed = JSON.parse(message.aiStructuredContent) as Record<string, unknown>;
      delete parsed.voiceText;

      return JSON.stringify(parsed);
    } catch {
      return JSON.stringify({ reply: message.text });
    }
  }

  return JSON.stringify({
    ...(options.voiceTextOutputEnabled && message.voiceText ? { voiceText: message.voiceText } : {}),
    reply: message.text
  });
}

export function buildAiMessages({
  petDefinition,
  messages,
  nextUserText,
  voiceReplyEnabled
}: BuildAiMessagesOptions): AiChatMessage[] {
  const voiceOutputEnabled =
    voiceReplyEnabled ||
    Boolean(petDefinition?.voiceModelSettings?.enabled && petDefinition.voiceModelSettings.connected);
  const chatLanguage = petDefinition?.personaSettings?.chatLanguage ?? "zh";
  const voiceLanguage = petDefinition?.voiceModelSettings?.language ?? "zh";
  const voiceTextOutputEnabled = shouldRequestVoiceText(
    voiceOutputEnabled,
    chatLanguage,
    voiceLanguage
  );
  const randomExpressionMode = petDefinition?.expressionSelectionMode === "random";
  const expressionOutputEnabled =
    !randomExpressionMode &&
    hasConfiguredExpressions(petDefinition?.expressions, petDefinition?.expressionDescriptions);
  const responseShape = {
    ...(voiceTextOutputEnabled ? { voiceText: "给语音服务朗读的文本" } : {}),
    reply: "给用户看的回复",
    ...(expressionOutputEnabled ? { emotion: "表情标签" } : {})
  };
  const responseInstructions = [
    `只输出这个 JSON 结构：${JSON.stringify(responseShape)}。`,
    buildDirectSpeechPrompt(),
    buildReplyPreferencePrompt(
      chatLanguage,
      petDefinition?.personaSettings?.replyLength
    )
  ];

  if (voiceTextOutputEnabled) {
    responseInstructions.push(buildVoiceTextPrompt(voiceLanguage));
  }

  if (expressionOutputEnabled) {
    responseInstructions.push(
      buildExpressionPrompt(petDefinition?.expressions, petDefinition?.expressionDescriptions)
    );
  }

  const recentMessages = messages
    .filter((message) => message.status !== "thinking" && message.status !== "error")
    .slice(-12)
    .map<AiChatMessage>((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      content:
        message.role === "pet"
          ? buildAssistantHistoryContent(message, {
              voiceTextOutputEnabled
            })
          : message.text
    }));

  return [
    {
      role: "system",
      content: [
        buildPersonaPrompt(petDefinition?.personaPrompt),
        "只输出 JSON，不输出 Markdown 或解释。",
        ...responseInstructions
      ].join("\n")
    },
    ...recentMessages,
    {
      role: "user",
      content: nextUserText
    }
  ];
}
