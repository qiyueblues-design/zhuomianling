import type { WebContents } from "electron";
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiChatStreamEvent
} from "../../../shared/types/ai";
import { getAiConnectionConfig } from "./aiSettings";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/`);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (normalizedPath && normalizedPath !== "") {
    url.pathname = `${normalizedPath}/chat/completions`;
    return url.toString();
  }

  url.pathname = "/v1/chat/completions";
  return url.toString();
}

function normalizeMessages(messages: AiChatMessage[]): AiChatMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim()
    }))
    .filter((message) => message.content.length > 0)
    .slice(-16);
}

function parseAiReply(content: string): { reply: string; emotion?: string; voiceText?: string } {
  const trimmedContent = content.trim();
  const jsonMatch = trimmedContent.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      reply: trimmedContent
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      reply?: unknown;
      emotion?: unknown;
      voiceText?: unknown;
    };
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    const emotion = typeof parsed.emotion === "string" ? parsed.emotion.trim() : undefined;
    const voiceText = typeof parsed.voiceText === "string" ? parsed.voiceText.trim() : undefined;

    if (!reply) {
      return {
        reply: trimmedContent
      };
    }

    return {
      reply,
      emotion,
      voiceText
    };
  } catch {
    const replyMatch = jsonMatch[0].match(/"reply"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
    const emotionMatch = jsonMatch[0].match(/"emotion"\s*:\s*"([^"]+)"/);
    const voiceTextMatch = jsonMatch[0].match(/"voiceText"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/);
    const reply = replyMatch?.[1]
      ?.replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .trim();

    const voiceText = voiceTextMatch?.[1]
      ?.replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .trim();

    if (reply) {
      return {
        reply,
        emotion: emotionMatch?.[1]?.trim(),
        voiceText
      };
    }

    return {
      reply: trimmedContent
    };
  }
}

export async function sendAiChat(request: AiChatRequest): Promise<AiChatResponse> {
  const config = await getAiConnectionConfig(request.petId);

  if (!config?.baseUrl || !config.model || !config.apiKey) {
    return {
      ok: false,
      message: "请先在 AI 设置中保存该桌宠的服务商、模型和 API Key。"
    };
  }

  const messages = normalizeMessages(request.messages);

  if (!messages.length) {
    return {
      ok: false,
      message: "请输入聊天内容。"
    };
  }

  let response: Response;

  try {
    response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.8,
        max_tokens: 1200,
        response_format: {
          type: "json_object"
        }
      })
    });
  } catch {
    return {
      ok: false,
      message: "无法连接 AI 服务，请检查网络或本地服务状态。"
    };
  }

  let body: ChatCompletionResponse;

  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch {
    return {
      ok: false,
      message: `AI 服务返回异常内容，状态码 ${response.status}。`
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: body.error?.message ?? `AI 请求失败，状态码 ${response.status}。`
    };
  }

  const content = body.choices?.[0]?.message?.content?.trim();

  if (!content) {
    return {
      ok: false,
      message: "AI 没有返回可显示的回复。"
    };
  }

  const parsedReply = parseAiReply(content);

  return {
    ok: true,
    message: "ok",
    content: parsedReply.reply,
    rawContent: content,
    emotion: parsedReply.emotion,
    voiceText: parsedReply.voiceText
  };
}

function sendStreamEvent(target: WebContents, event: AiChatStreamEvent): void {
  if (!target.isDestroyed()) {
    target.send("ai-chat:stream-event", event);
  }
}

function readStreamChunkDelta(line: string): { delta?: string; error?: string } {
  try {
    const parsed = JSON.parse(line) as ChatCompletionStreamChunk;

    return {
      delta: parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content,
      error: parsed.error?.message
    };
  } catch {
    return {};
  }
}

export async function startAiChatStream(
  target: WebContents,
  request: AiChatRequest,
  streamId: string
): Promise<void> {
  const config = await getAiConnectionConfig(request.petId);

  if (!config?.baseUrl || !config.model || !config.apiKey) {
    sendStreamEvent(target, {
      streamId,
      ok: false,
      type: "error",
      message: "请先在 AI 设置中保存该桌宠的服务商、模型和 API Key。"
    });
    return;
  }

  const messages = normalizeMessages(request.messages);

  if (!messages.length) {
    sendStreamEvent(target, {
      streamId,
      ok: false,
      type: "error",
      message: "请输入聊天内容。"
    });
    return;
  }

  let response: Response;

  try {
    response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.8,
        max_tokens: 1200,
        response_format: {
          type: "json_object"
        },
        stream: true
      })
    });
  } catch {
    sendStreamEvent(target, {
      streamId,
      ok: false,
      type: "error",
      message: "无法连接 AI 服务，请检查网络或本地服务状态。"
    });
    return;
  }

  if (!response.ok || !response.body) {
    let message = `AI 请求失败，状态码 ${response.status}。`;

    try {
      const body = (await response.json()) as ChatCompletionResponse;
      message = body.error?.message ?? message;
    } catch {
      // Keep the status-based message.
    }

    sendStreamEvent(target, {
      streamId,
      ok: false,
      type: "error",
      message
    });
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let content = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line.startsWith("data:")) {
          continue;
        }

        const data = line.slice(5).trim();

        if (!data || data === "[DONE]") {
          continue;
        }

        const { delta, error } = readStreamChunkDelta(data);

        if (error) {
          sendStreamEvent(target, {
            streamId,
            ok: false,
            type: "error",
            message: error
          });
          return;
        }

        if (!delta) {
          continue;
        }

        content += delta;
        sendStreamEvent(target, {
          streamId,
          ok: true,
          type: "chunk",
          delta,
          content
        });
      }
    }
  } catch {
    sendStreamEvent(target, {
      streamId,
      ok: false,
      type: "error",
      message: "AI 流式回复中断，请稍后再试。"
    });
    return;
  }

  if (!content.trim()) {
    sendStreamEvent(target, {
      streamId,
      ok: false,
      type: "error",
      message: "AI 没有返回可显示的回复。"
    });
    return;
  }

  sendStreamEvent(target, {
    streamId,
    ok: true,
    type: "done",
    content
  });
}
