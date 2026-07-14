import type {
  PetChatLanguage,
  PetExpressionDescriptionMap,
  PetExpressionKey,
  PetExpressionMap,
  PetReplyLength,
  PetVoiceLanguage
} from "../../shared/types/pet";

const chatLanguageLabels: Record<PetChatLanguage, string> = {
  zh: "中文",
  ja: "日语",
  en: "英语"
};

const voiceLanguageLabels: Record<PetVoiceLanguage, string> = {
  zh: "中文",
  ja: "日语",
  en: "英语"
};

const replyLengthInstructions: Record<PetReplyLength, string[]> = {
  short: [
    "reply 长度偏短：优先一到两句话。",
    "直接回应用户，不展开长解释；除非用户明确要求详细说明。"
  ],
  medium: [
    "reply 长度适中：通常两到四句话。",
    "可以给出必要解释和一点情绪回应，但不要写成长段落。"
  ],
  long: [
    "reply 长度偏长：请更完整地展开，通常四句话以上。",
    "可以补充原因、建议、步骤、例子或安慰，让回复更有内容。",
    "不要为了变长重复同义句，也不要写与用户问题无关的内容。"
  ]
};

export function buildReplyPreferencePrompt(
  chatLanguage: PetChatLanguage = "zh",
  replyLength?: PetReplyLength
): string {
  return [
    `reply 使用${chatLanguageLabels[chatLanguage]}。`,
    ...(replyLength ? replyLengthInstructions[replyLength] : ["reply 长度按对话自然决定。"])
  ].join("\n");
}

export function buildDirectSpeechPrompt(): string {
  return [
    "reply 只写角色实际对用户说出口的话。",
    "禁止在 reply 中输出心理活动、旁白、动作描写、舞台说明、表情说明或括号内补充，例如“她心想……”“她低下头……”“（小声）”。"
  ].join("\n");
}

export function buildVoiceTextPrompt(voiceLanguage: PetVoiceLanguage): string {
  return [
    `voiceText 使用${voiceLanguageLabels[voiceLanguage]}。`,
    "voiceText 是 reply 的逐句朗读版：必须覆盖 reply 的每一句、每个分句和所有关键信息，顺序保持一致。",
    "如果 reply 有多句、逗号分句或省略号后的补充，voiceText 必须都有对应内容；禁止摘要、缩短、跳过后半句或只翻译前半句。",
    "voiceText 可根据人设、口癖和语气做自然翻译，但不能新增、删除或改变信息。",
    "voiceText 只写角色实际说出口的话，不写动作、旁白、心理活动或表情说明。"
  ].join("\n");
}

export function splitVoiceTextIntoSegments(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return [];
  }

  const segments: string[] = [];
  let current = "";

  for (const character of Array.from(normalized)) {
    current += character;

    const shouldSplit =
      /[。！？!?]/.test(character) ||
      (current.length >= 36 && /[、，,；;]/.test(character)) ||
      current.length >= 80;

    if (shouldSplit) {
      const segment = current.trim();

      if (segment) {
        segments.push(segment);
      }

      current = "";
    }
  }

  const lastSegment = current.trim();

  if (lastSegment) {
    segments.push(lastSegment);
  }

  return segments;
}

export function inferExpressionFromAiReply(text: string): PetExpressionKey {
  const normalizedText = text.toLowerCase();

  if (/[!！]{2,}|[?？]{2,}/.test(text) || /诶|欸|哇|等等|糟糕|突然/.test(text)) {
    return "panic";
  }

  if (/哭|眼泪|流泪|泪目|难过|伤心|委屈|崩溃|绷不住/.test(text)) {
    return "crying";
  }

  if (/抱歉|不好意思|对不起|惭愧|害羞|紧张/.test(text)) {
    return "shy";
  }

  if (/太好了|真好|开心|没问题|可以呀|当然|nice|great/.test(normalizedText)) {
    return "happy";
  }

  if (/认真|分析|步骤|建议|计划|首先|然后|最后/.test(text) || text.length > 80) {
    return "focus";
  }

  return "normal";
}

function isPetExpressionKey(value: string): value is PetExpressionKey {
  return value.trim().length > 0;
}

export function resolveMappedExpression(
  requestedExpression: string | undefined,
  expressions?: PetExpressionMap,
  fallbackExpression: PetExpressionKey = "normal"
): PetExpressionKey {
  if (
    requestedExpression &&
    isPetExpressionKey(requestedExpression) &&
    expressions?.[requestedExpression]
  ) {
    return requestedExpression;
  }

  if (expressions?.[fallbackExpression]) {
    return fallbackExpression;
  }

  return "normal";
}

export function buildExpressionPrompt(
  expressions?: PetExpressionMap,
  descriptions?: PetExpressionDescriptionMap
): string {
  if (!expressions || !descriptions) {
    return "当前没有可用的本地表情映射，emotion 请固定输出 normal。";
  }

  const lines = Object.entries(descriptions)
    .filter(([expression]) => isPetExpressionKey(expression) && Boolean(expressions[expression]))
    .map(([expression, description]) => `- ${expression}: ${description}`)
    .join("\n");

  if (!lines) {
    return "当前没有可用的本地表情映射，emotion 请固定输出 normal。";
  }

  return `emotion 根据 reply 的语义、情绪和意图选择最贴近的 key；每行冒号前是可输出的 key，冒号后是含义描述：\n${lines}`;
}
