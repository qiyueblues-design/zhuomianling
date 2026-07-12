export interface ParsedAiReply {
  reply: string;
  emotion?: string;
  voiceText?: string;
  completeForMemory: boolean;
}

function unescapePartialJsonText(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

export function parseFinalAiReply(content: string): ParsedAiReply {
  const trimmedContent = content.trim();
  if (!trimmedContent.startsWith("{")) {
    return { reply: trimmedContent, completeForMemory: Boolean(trimmedContent) };
  }

  try {
    const parsed = JSON.parse(trimmedContent) as {
      reply?: unknown;
      emotion?: unknown;
      voiceText?: unknown;
    };
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    const emotion = typeof parsed.emotion === "string" ? parsed.emotion.trim() : undefined;
    const voiceText = typeof parsed.voiceText === "string" ? parsed.voiceText.trim() : undefined;
    if (reply) return { reply, emotion, voiceText, completeForMemory: true };
  } catch {
    const replyMatch = trimmedContent.match(/"reply"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
    const emotionMatch = trimmedContent.match(/"emotion"\s*:\s*"([^"]+)"/);
    const voiceTextMatch = trimmedContent.match(/"voiceText"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
    const reply = replyMatch?.[1] ? unescapePartialJsonText(replyMatch[1]).trim() : "";
    const voiceText = voiceTextMatch?.[1]
      ? unescapePartialJsonText(voiceTextMatch[1]).trim()
      : undefined;
    if (reply) {
      return {
        reply,
        emotion: emotionMatch?.[1]?.trim(),
        voiceText,
        completeForMemory: false
      };
    }
  }

  return { reply: trimmedContent, completeForMemory: false };
}
