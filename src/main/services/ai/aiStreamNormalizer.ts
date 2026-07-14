import {
  maxAiReplyInputCharacters,
  maxAiReplyTextCharacters,
  maxAiVoiceTextCharacters,
  parseFinalAiReply,
  type NormalizedAiReply
} from "../../../shared/aiReply";

export interface AiStreamSafeSnapshot {
  changed: boolean;
  overflowed: boolean;
  reply: string;
  replyDelta?: string;
  voiceText?: string;
  voiceTextDelta?: string;
}

const reasoningTagNames = ["think", "analysis", "reasoning"] as const;

function isPotentialReasoningTag(value: string): boolean {
  if (!value.startsWith("<")) {
    return false;
  }

  const normalized = value
    .toLowerCase()
    .replace(/^<\s*\/?\s*/, "")
    .trimStart();

  return reasoningTagNames.some(
    (tag) => tag.startsWith(normalized) || normalized.startsWith(tag)
  );
}

function stripReasoningForStreaming(value: string): string {
  let visible = "";
  let reasoningDepth = 0;
  let cursor = 0;

  while (cursor < value.length) {
    const tagStart = value.indexOf("<", cursor);

    if (tagStart < 0) {
      if (reasoningDepth === 0) {
        visible += value.slice(cursor);
      }
      break;
    }

    if (reasoningDepth === 0) {
      visible += value.slice(cursor, tagStart);
    }

    const tagEnd = value.indexOf(">", tagStart + 1);
    if (tagEnd < 0) {
      const tail = value.slice(tagStart);
      if (reasoningDepth === 0 && !isPotentialReasoningTag(tail)) {
        visible += tail;
      }
      break;
    }

    const tag = value.slice(tagStart, tagEnd + 1);
    const reasoningTag = tag.match(
      /^<\s*(\/?)\s*(think|analysis|reasoning)\b[^>]*>$/i
    );

    if (reasoningTag) {
      if (reasoningTag[1]) {
        reasoningDepth = Math.max(0, reasoningDepth - 1);
      } else {
        reasoningDepth += 1;
      }
    } else if (reasoningDepth === 0) {
      visible += tag;
    }

    cursor = tagEnd + 1;
  }

  return visible;
}

function stripStreamingMarkdownFence(value: string): string {
  const trimmedStart = value.trimStart();

  if (/^`{1,2}$/.test(trimmedStart) || /^```(?:j|js|jso|json)?$/i.test(trimmedStart)) {
    return "";
  }

  return trimmedStart
    .replace(/^```(?:json)?\s*(?:\r?\n)?/i, "")
    .replace(/\r?\n?```\s*$/i, "")
    .trim();
}

function decodePartialJsonString(value: string): string {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) {
      break;
    }
    index += 1;

    if (escaped === "u") {
      const hex = value.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) {
        break;
      }
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }

    const escapeMap: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t"
    };
    decoded += escapeMap[escaped] ?? escaped;
  }

  return decoded.replace(/\0/g, "").trim();
}

function findLastStreamingStringField(value: string, field: "reply" | "voiceText"): string | undefined {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"`, "g");
  let match: RegExpExecArray | null;
  let lastValue: string | undefined;

  while ((match = pattern.exec(value)) !== null) {
    let escaped = false;
    let fieldValue = "";

    for (let index = pattern.lastIndex; index < value.length; index += 1) {
      const character = value[index];

      if (!escaped && character === '"') {
        break;
      }

      fieldValue += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      }
    }

    lastValue = decodePartialJsonString(fieldValue);
  }

  return lastValue || undefined;
}

function projectSafeStreamingContent(rawContent: string): {
  reply: string;
  voiceText?: string;
} {
  const visible = stripStreamingMarkdownFence(stripReasoningForStreaming(rawContent));
  if (!visible) {
    return { reply: "" };
  }

  const reply = findLastStreamingStringField(visible, "reply");
  const voiceText = findLastStreamingStringField(visible, "voiceText");

  if (reply || voiceText) {
    return { reply: reply ?? "", voiceText };
  }

  if (/^\s*[{[]/.test(visible) || /"(?:reply|emotion|voiceText)"\s*:/.test(visible)) {
    return { reply: "" };
  }

  return { reply: visible.trim() };
}

function appendDelta(previous: string, current: string): string | undefined {
  if (!current.startsWith(previous)) {
    return undefined;
  }

  return current.slice(previous.length) || undefined;
}

export class AiStreamNormalizer {
  private rawContent = "";
  private reply = "";
  private voiceText = "";
  private replyRevisionDetected = false;

  append(delta: string): AiStreamSafeSnapshot {
    if (!delta) {
      return {
        changed: false,
        overflowed: false,
        reply: this.reply,
        voiceText: this.voiceText || undefined
      };
    }

    if (this.rawContent.length + delta.length > maxAiReplyInputCharacters) {
      return {
        changed: false,
        overflowed: true,
        reply: this.reply,
        voiceText: this.voiceText || undefined
      };
    }

    this.rawContent += delta;
    const projected = projectSafeStreamingContent(this.rawContent);
    const nextReply =
      this.reply && !projected.reply.startsWith(this.reply)
        ? this.reply
        : projected.reply;
    if (nextReply !== projected.reply) {
      this.replyRevisionDetected = true;
    }
    const nextVoiceText = this.replyRevisionDetected
      ? this.voiceText
      : projected.voiceText ?? "";
    if (
      nextReply.length > maxAiReplyTextCharacters ||
      nextVoiceText.length > maxAiVoiceTextCharacters
    ) {
      return {
        changed: false,
        overflowed: true,
        reply: this.reply,
        voiceText: this.voiceText || undefined
      };
    }
    const changed = nextReply !== this.reply || nextVoiceText !== this.voiceText;
    const snapshot: AiStreamSafeSnapshot = {
      changed,
      overflowed: false,
      reply: nextReply,
      replyDelta: appendDelta(this.reply, nextReply),
      voiceText: nextVoiceText || undefined,
      voiceTextDelta: appendDelta(this.voiceText, nextVoiceText)
    };
    this.reply = nextReply;
    this.voiceText = nextVoiceText;
    return snapshot;
  }

  finalize(): NormalizedAiReply {
    const parsed = parseFinalAiReply(this.rawContent);

    if (
      this.replyRevisionDetected &&
      this.reply &&
      parsed.reply &&
      parsed.reply !== this.reply
    ) {
      return {
        reply: this.reply,
        quality: "recovered",
        completeForMemory: false
      };
    }

    return parsed;
  }

  hasContent(): boolean {
    return this.rawContent.trim().length > 0;
  }
}
