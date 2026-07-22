import type { AiChatMessage } from "../../shared/types/ai";

export interface PromptBuilderChatMessage {
  role: "user" | "pet";
  text: string;
  status?: "thinking" | "error";
  voiceText?: string;
  aiStructuredContent?: string;
}

export interface BuildAiMessagesOptions {
  messages: PromptBuilderChatMessage[];
  nextUserText: string;
}

function buildAssistantHistoryContent(message: PromptBuilderChatMessage): string {
  if (message.aiStructuredContent?.trim()) return message.aiStructuredContent.trim();
  return JSON.stringify({
    reply: message.text,
    ...(message.voiceText ? { voiceText: message.voiceText } : {})
  });
}

/**
 * Renderer only submits bounded conversation data. The main process owns the
 * authoritative system prompt and rewrites assistant history for the selected
 * protocol tier before contacting the provider.
 */
export function buildAiMessages({
  messages,
  nextUserText
}: BuildAiMessagesOptions): AiChatMessage[] {
  const recentMessages = messages
    .filter((message) => message.status !== "thinking" && message.status !== "error")
    .slice(-12)
    .map<AiChatMessage>((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      content: message.role === "pet" ? buildAssistantHistoryContent(message) : message.text
    }));

  return [
    ...recentMessages,
    { role: "user", content: nextUserText }
  ];
}
