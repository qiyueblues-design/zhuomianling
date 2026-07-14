import {
  maxAiReplyInputCharacters,
  parseFinalAiReply
} from "../../../shared/aiReply";
import type {
  AiChatMessage,
  AiOutputCapability,
  AiOutputMode
} from "../../../shared/types/ai";
import {
  buildAiChatRequestBody,
  buildChatCompletionsUrl
} from "./aiProtocol";

export interface AiCapabilityProbeResult {
  capability: AiOutputCapability;
  tested: boolean;
}

const probeModes: AiOutputMode[] = ["json-schema", "json-object", "plain-text"];
const probeMessages: AiChatMessage[] = [
  {
    role: "system",
    content: "这是连接能力测试。不要输出推理、Markdown 或解释；请只返回包含 reply 字段的 JSON。"
  },
  {
    role: "user",
    content: "将 reply 设置为 probe-ok。"
  }
];
const probeTimeoutMs = 12_000;

async function readBoundedText(response: Response): Promise<string | undefined> {
  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    content += decoder.decode(value, { stream: true });
    if (content.length > maxAiReplyInputCharacters) {
      await reader.cancel("AI capability probe exceeded its response budget").catch(() => undefined);
      return undefined;
    }
  }

  content += decoder.decode();
  return content;
}

function extractProbeContent(rawBody: string): { content?: string; streaming: boolean } {
  const trimmed = rawBody.trim();
  if (!trimmed) return { streaming: false };

  if (trimmed.startsWith("data:")) {
    let content = "";
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: unknown };
            message?: { content?: unknown };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
        if (typeof delta === "string") content += delta;
      } catch {
        return { streaming: true };
      }
    }
    return { content, streaming: true };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    return { content: typeof content === "string" ? content : undefined, streaming: false };
  } catch {
    return { streaming: false };
  }
}

function isProbeReplyValid(content: string | undefined, mode: AiOutputMode): boolean {
  if (!content) return false;
  const parsed = parseFinalAiReply(content);
  if (!parsed.reply) return false;
  return mode === "plain-text" || parsed.quality === "structured";
}

function fallbackCapability(baseUrl: string, model: string, checkedAt: string): AiOutputCapability {
  return {
    baseUrl,
    model,
    mode: "plain-text",
    streaming: true,
    confidence: "fallback",
    checkedAt
  };
}

export async function probeAiOutputCapability(options: {
  baseUrl: string;
  model: string;
  apiKey: string;
  checkedAt?: string;
}): Promise<AiCapabilityProbeResult> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("capability-probe-timeout"), probeTimeoutMs);

  try {
    // Prefer a usable streaming mode for low first-token latency. If every
    // streaming request is rejected, repeat the same bounded matrix without
    // streaming so providers that only implement complete responses still work.
    for (const requestedStreaming of [true, false]) {
      for (const mode of probeModes) {
        let response: Response;
        try {
          response = await fetch(buildChatCompletionsUrl(options.baseUrl), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
              Accept: requestedStreaming
                ? "text/event-stream, application/json"
                : "application/json"
            },
            signal: controller.signal,
            body: JSON.stringify(
              buildAiChatRequestBody({
                model: options.model,
                messages: probeMessages,
                mode,
                stream: requestedStreaming,
                temperature: 0,
                maxTokens: 48
              })
            )
          });
        } catch {
          return {
            capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
            tested: false
          };
        }

        if (!response.ok) {
          await response.body?.cancel("trying the next AI capability probe").catch(() => undefined);
          continue;
        }

        const rawBody = await readBoundedText(response);
        if (!rawBody) continue;
        const extracted = extractProbeContent(rawBody);
        if (!isProbeReplyValid(extracted.content, mode)) continue;

        return {
          capability: {
            baseUrl: options.baseUrl,
            model: options.model,
            mode,
            streaming: requestedStreaming && extracted.streaming,
            confidence: "tested",
            checkedAt
          },
          tested: true
        };
      }
    }
  } catch {
    return {
      capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
      tested: false
    };
  } finally {
    clearTimeout(timeout);
  }

  return {
    capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
    tested: false
  };
}
