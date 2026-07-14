export interface ChatMessage {
  id: number;
  role: "user" | "pet";
  text: string;
  status?: "thinking" | "error";
  voiceText?: string;
  aiStructuredContent?: string;
}
