export interface SpeechToTextRequest {
  petId?: string;
  audioBase64: string;
  format: "wav" | "pcm" | "mp3" | "m4a" | "ogg-opus" | "aac" | "amr";
}

export interface SpeechToTextResponse {
  ok: boolean;
  message: string;
  text?: string;
  language?: "zh" | "ja" | "en" | "unknown";
}

export interface SpeechStreamStartResult {
  ok: boolean;
  message: string;
  sessionId?: string;
}

export interface SpeechStreamStartRequest {
  petId: string;
  sessionId: string;
}

export interface SpeechStreamAudioChunk {
  sessionId: string;
  audio: ArrayBuffer;
}

export interface SpeechStreamStopRequest {
  sessionId: string;
}

export interface SpeechStreamResultEvent {
  sessionId: string;
  ok: boolean;
  message?: string;
  text?: string;
  index?: number;
  sliceType?: 0 | 1 | 2;
  final?: boolean;
}

export interface TextToSpeechRequest {
  petId: string;
  text: string;
}

export interface TextToSpeechResponse {
  ok: boolean;
  message: string;
  audioBase64?: string;
  mimeType?: string;
}
