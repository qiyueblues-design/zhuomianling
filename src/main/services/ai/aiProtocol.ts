import type {
  AiChatMessage,
  AiOutputMode
} from "../../../shared/types/ai";

export function buildChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/`);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (normalizedPath) {
    url.pathname = `${normalizedPath}/chat/completions`;
    return url.toString();
  }

  url.pathname = "/v1/chat/completions";
  return url.toString();
}

export function buildAiResponseFormat(mode: AiOutputMode): Record<string, unknown> | undefined {
  if (mode === "plain-text") {
    return undefined;
  }

  if (mode === "json-object") {
    return { type: "json_object" };
  }

  return {
    type: "json_schema",
    json_schema: {
      name: "zhuomianling_reply",
      strict: false,
      schema: {
        type: "object",
        properties: {
          reply: { type: "string" },
          emotion: { type: ["string", "null"] },
          voiceText: { type: ["string", "null"] }
        },
        required: ["reply"],
        additionalProperties: false
      }
    }
  };
}

export function buildAiChatRequestBody(options: {
  model: string;
  messages: AiChatMessage[];
  mode: AiOutputMode;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
}): Record<string, unknown> {
  const responseFormat = buildAiResponseFormat(options.mode);
  return {
    model: options.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.8,
    max_tokens: options.maxTokens ?? 1200,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    stream: options.stream
  };
}

export function getAiOutputModeFallbacks(mode: AiOutputMode): AiOutputMode[] {
  if (mode === "json-schema") {
    return ["json-schema", "json-object", "plain-text"];
  }

  if (mode === "json-object") {
    return ["json-object", "plain-text"];
  }

  return ["plain-text"];
}

export function canFallbackAiOutputMode(status: number): boolean {
  return status === 400 || status === 404 || status === 415 || status === 422;
}
