import type {
  AiChatMessage,
  AiOutputMode
} from "../../../shared/types/ai";
import {
  buildAiReplyJsonSchema,
  createAiReplyContract,
  type AiReplyContract
} from "../../../shared/aiContract";

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

export function buildAiResponseFormat(
  mode: AiOutputMode,
  contract: AiReplyContract = createAiReplyContract({
    tier: mode === "plain-text" ? "text" : "full"
  })
): Record<string, unknown> | undefined {
  if (mode === "plain-text") {
    return undefined;
  }
  if (contract.tier !== "full") {
    throw new Error("Structured AI output mode requires the full desktop-pet protocol.");
  }
  if (mode === "prompt-json") return undefined;

  if (mode === "json-object") {
    return { type: "json_object" };
  }

  return {
    type: "json_schema",
    json_schema: {
      name: "zhuomianling_reply",
      strict: true,
      schema: buildAiReplyJsonSchema(contract)
    }
  };
}

export function buildAiChatRequestBody(options: {
  model: string;
  messages: AiChatMessage[];
  mode: AiOutputMode;
  contract?: AiReplyContract;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
}): Record<string, unknown> {
  const responseFormat = buildAiResponseFormat(options.mode, options.contract);
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
    return ["json-schema", "json-object", "prompt-json", "plain-text"];
  }

  if (mode === "json-object") {
    return ["json-object", "prompt-json", "plain-text"];
  }

  if (mode === "prompt-json") return ["prompt-json", "plain-text"];

  return ["plain-text"];
}

export function canFallbackAiOutputMode(status: number): boolean {
  return status === 400 || status === 404 || status === 415 || status === 422;
}
