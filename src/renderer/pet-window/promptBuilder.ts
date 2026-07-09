import type { AiChatMessage } from "../../shared/types/ai";
import type { PetDefinition } from "../../shared/types/pet";
import {
  buildExpressionPrompt,
  buildReplyPreferencePrompt,
  buildVoiceTextPrompt
} from "./aiReplyUtils";

export interface PromptBuilderChatMessage {
  role: "user" | "pet";
  text: string;
  status?: "thinking" | "error";
  voiceText?: string;
  aiRawContent?: string;
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

export function buildAiMessages({
  petDefinition,
  messages,
  nextUserText,
  voiceReplyEnabled
}: BuildAiMessagesOptions): AiChatMessage[] {
  const voiceOutputEnabled =
    voiceReplyEnabled ||
    Boolean(petDefinition?.voiceModelSettings?.enabled && petDefinition.voiceModelSettings.connected);
  const randomExpressionMode = petDefinition?.expressionSelectionMode === "random";
  const expressionOutputEnabled =
    !randomExpressionMode &&
    hasConfiguredExpressions(petDefinition?.expressions, petDefinition?.expressionDescriptions);
  const responseShape = {
    ...(voiceOutputEnabled ? { voiceText: "给语音服务朗读的文本" } : {}),
    reply: "给用户看的回复",
    ...(expressionOutputEnabled ? { emotion: "表情标签" } : {})
  };
  const responseInstructions = [
    `只输出这个 JSON 结构：${JSON.stringify(responseShape)}。`,
    buildReplyPreferencePrompt(
      petDefinition?.personaSettings?.chatLanguage,
      petDefinition?.personaSettings?.replyLength
    )
  ];

  if (voiceOutputEnabled) {
    responseInstructions.push(buildVoiceTextPrompt(petDefinition?.voiceModelSettings?.language ?? "zh"));
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
          ? message.aiRawContent ??
            JSON.stringify({
              ...(voiceOutputEnabled && message.voiceText ? { voiceText: message.voiceText } : {}),
              reply: message.text
            })
          : message.text
    }));

  return [
    {
      role: "system",
      content: [
        petDefinition?.personaPrompt?.trim() || "你是一个桌面宠物聊天助手。",
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
