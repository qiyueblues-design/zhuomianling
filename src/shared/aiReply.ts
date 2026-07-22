import type { AiReplyContract } from "./aiContract";

export type AiReplyParseQuality = "structured" | "recovered" | "plain-text" | "invalid";

export interface NormalizedAiReply {
  reply: string;
  emotion?: string;
  voiceText?: string;
  quality: AiReplyParseQuality;
  completeForMemory: boolean;
  moodDelta?: number;
}

export type ParsedAiReply = NormalizedAiReply;

export const maxAiReplyInputCharacters = 128 * 1024;
export const maxAiReplyTextCharacters = 32 * 1024;
const maxEmotionCharacters = 128;
export const maxAiVoiceTextCharacters = 32 * 1024;
const structuredFieldPattern = /"(?:reply|emotion|voiceText|moodDelta)"\s*:/;

function invalidReply(): NormalizedAiReply {
  return {
    reply: "",
    quality: "invalid",
    completeForMemory: false
  };
}

function normalizeOptionalString(value: unknown, maxCharacters: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\0/g, "").trim();

  if (!normalized || normalized.length > maxCharacters) {
    return undefined;
  }

  return normalized;
}

function stripReasoningBlocks(value: string): string {
  let visible = value.replace(
    /<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ""
  );
  const unclosedOpeningTag = /<(think|analysis|reasoning)\b[^>]*>/i.exec(visible);

  if (unclosedOpeningTag?.index !== undefined) {
    visible = visible.slice(0, unclosedOpeningTag.index);
  }

  return visible.replace(/<\/(?:think|analysis|reasoning)\s*>/gi, "");
}

function stripMarkdownFences(value: string): string {
  return value
    .replace(/^\s*```(?:json|JSON)?\s*$/gm, "")
    .replace(/^\s*```\s*$/gm, "")
    .trim();
}

function extractBalancedJsonObjects(value: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }

    if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (character !== "}" || depth === 0) {
      continue;
    }

    depth -= 1;
    if (depth === 0 && start >= 0) {
      objects.push(value.slice(start, index + 1));
      start = -1;
    }
  }

  return objects;
}

function parseStructuredObject(candidate: string): NormalizedAiReply | undefined {
  try {
    const parsed = JSON.parse(candidate) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const reply = normalizeOptionalString(record.reply, maxAiReplyTextCharacters);

    if (!reply) {
      return undefined;
    }

    return {
      reply,
      emotion: normalizeOptionalString(record.emotion, maxEmotionCharacters),
      voiceText: normalizeOptionalString(record.voiceText, maxAiVoiceTextCharacters),
      quality: "structured",
      completeForMemory: true,
      ...(typeof record.moodDelta === "number" && Number.isFinite(record.moodDelta) && Number.isInteger(record.moodDelta)
        ? { moodDelta: record.moodDelta }
        : {})
    };
  } catch {
    return undefined;
  }
}

function isStructuredReplyContractCompatible(
  candidate: string,
  parsed: NormalizedAiReply,
  contract: AiReplyContract
): boolean {
  try {
    const value = JSON.parse(candidate) as Record<string, unknown>;
    if (Object.keys(value).some((key) => !contract.allowedFields.includes(key as never))) {
      return false;
    }
    if (!Number.isInteger(value.moodDelta) || (value.moodDelta as number) < -12 || (value.moodDelta as number) > 12) {
      return false;
    }
    if (contract.voiceTextRequired && !normalizeOptionalString(value.voiceText, maxAiVoiceTextCharacters)) {
      return false;
    }
    if (
      contract.emotionRequired &&
      (typeof value.emotion !== "string" || !contract.emotionKeys.includes(value.emotion.trim()))
    ) {
      return false;
    }
    return contract.requiredFields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) &&
      parsed.quality === "structured";
  } catch {
    return false;
  }
}

function asContractRecovery(parsed: NormalizedAiReply): NormalizedAiReply {
  return {
    reply: parsed.reply,
    quality: "recovered",
    completeForMemory: false
  };
}

function unescapePartialJsonText(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\0/g, "");
}

function recoverPartialStructuredReply(value: string): NormalizedAiReply | undefined {
  const replyMatch = value.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)"\s*(?:,|\})/);
  const emotionMatch = value.match(/"emotion"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const voiceTextMatch = value.match(/"voiceText"\s*:\s*"((?:\\.|[^"\\])*)"\s*(?:,|\})/);
  const reply = replyMatch?.[1]
    ? normalizeOptionalString(unescapePartialJsonText(replyMatch[1]), maxAiReplyTextCharacters)
    : undefined;

  if (!reply) {
    return undefined;
  }

  return {
    reply,
    emotion: emotionMatch?.[1]
      ? normalizeOptionalString(unescapePartialJsonText(emotionMatch[1]), maxEmotionCharacters)
      : undefined,
    voiceText: voiceTextMatch?.[1]
      ? normalizeOptionalString(unescapePartialJsonText(voiceTextMatch[1]), maxAiVoiceTextCharacters)
      : undefined,
    quality: "recovered",
    completeForMemory: false
  };
}

export function parseFinalAiReply(
  content: string,
  contract?: AiReplyContract
): NormalizedAiReply {
  if (!content || content.length > maxAiReplyInputCharacters) {
    return invalidReply();
  }

  const reasoningSafeContent = stripReasoningBlocks(content.replace(/^\uFEFF/, ""));
  if (contract?.tier === "text") {
    const reply = normalizeOptionalString(reasoningSafeContent, maxAiReplyTextCharacters);
    return reply
      ? { reply, quality: "plain-text", completeForMemory: true }
      : invalidReply();
  }

  const visibleContent = stripMarkdownFences(reasoningSafeContent);

  if (!visibleContent) {
    return invalidReply();
  }

  const structuredObjects = extractBalancedJsonObjects(visibleContent);

  let lastStructuredReply: NormalizedAiReply | undefined;
  for (let index = structuredObjects.length - 1; index >= 0; index -= 1) {
    const parsed = parseStructuredObject(structuredObjects[index]);

    if (parsed) {
      if (!contract) return parsed;
      if (isStructuredReplyContractCompatible(structuredObjects[index], parsed, contract)) {
        return parsed;
      }
      lastStructuredReply ??= parsed;
    }
  }

  if (lastStructuredReply) return asContractRecovery(lastStructuredReply);

  if (structuredFieldPattern.test(visibleContent)) {
    const recovered = recoverPartialStructuredReply(visibleContent);
    if (!recovered) return invalidReply();
    return recovered;
  }

  if (structuredObjects.length > 0 || /^\s*[{[]/.test(visibleContent)) {
    return invalidReply();
  }

  const reply = normalizeOptionalString(visibleContent, maxAiReplyTextCharacters);

  if (!reply) {
    return invalidReply();
  }

  const plainReply: NormalizedAiReply = {
    reply,
    quality: "plain-text",
    completeForMemory: true
  };
  if (contract?.tier === "full") return asContractRecovery(plainReply);
  return plainReply;
}
