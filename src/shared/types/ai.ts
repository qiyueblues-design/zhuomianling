export interface AiConnectionDraft {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  models?: AiModelOption[];
}

export interface AiConnectionConfig extends AiConnectionDraft {
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
