import type {
  PetExpressionKey,
  PetExpressionMap
} from "../../shared/types/pet";

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
