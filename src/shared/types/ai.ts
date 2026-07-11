export function normalizeAiBaseUrl(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim();

  if (!trimmedBaseUrl) {
    return "";
  }

  try {
    const url = new URL(trimmedBaseUrl);
    const credentials = url.username
      ? `${url.username}${url.password ? `:${url.password}` : ""}@`
      : "";
    const normalizedPath = url.pathname.replace(/\/+$/, "");

    // URL canonicalizes the protocol/host casing, default port and dot segments.
    // Fragments are deliberately excluded because they are never sent to the API.
    return `${url.protocol}//${credentials}${url.host}${normalizedPath}${url.search}`;
  } catch {
    // Keep invalid drafts editable while still applying the same conservative
    // trailing-slash normalization on both the renderer and main process.
    return trimmedBaseUrl.replace(/\/+$/, "");
  }
}

export interface AiConnectionDraft {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  models?: AiModelOption[];
}

export interface AiConnectionConfig {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  models?: AiModelOption[];
  updatedAt: string;
}

export interface AiConnectionSummary {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  models: AiModelOption[];
  hasApiKey: boolean;
  updatedAt?: string;
}

export interface AiConnectionTestResult {
  ok: boolean;
  message: string;
  checkedAt: string;
  code?:
    | "API_KEY_REQUIRED"
    | "INVALID_AI_SETTINGS"
    | "SECURE_STORAGE_UNAVAILABLE"
    | "SECURE_STORAGE_CORRUPTED";
}

export interface AiModelOption {
  id: string;
  name: string;
}

export interface AiModelListResult extends AiConnectionTestResult {
  models: AiModelOption[];
}

export interface AiConnectionSaveResult {
  config: AiConnectionSummary;
  test: AiConnectionTestResult;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatRequest {
  petId: string;
  messages: AiChatMessage[];
}

export interface AiChatStreamStartResult {
  ok: boolean;
  message: string;
  streamId?: string;
}

export interface AiChatStreamEvent {
  streamId: string;
  ok: boolean;
  type: "chunk" | "done" | "error";
  delta?: string;
  content?: string;
  message?: string;
}

export interface AiChatResponse {
  ok: boolean;
  message: string;
  content?: string;
  rawContent?: string;
  emotion?: string;
  voiceText?: string;
}
