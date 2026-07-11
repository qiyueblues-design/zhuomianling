import { describe, expect, it } from "vitest";
import type { AiChatStreamEvent } from "../../shared/types/ai";
import { isCurrentAiStreamEvent } from "./aiStreamGuard";

function createEvent(overrides: Partial<AiChatStreamEvent> = {}): AiChatStreamEvent {
  return {
    streamId: "stream-current",
    requestId: "request-current",
    petId: "pet-a",
    ok: true,
    type: "chunk",
    content: "partial",
    ...overrides
  };
}

describe("AI stream event isolation", () => {
  it("accepts early events for the current request before the stream ID invoke result arrives", () => {
    expect(
      isCurrentAiStreamEvent(createEvent(), {
        requestId: "request-current",
        petId: "pet-a"
      })
    ).toBe(true);
  });

  it("rejects late chunks from an old request or stream", () => {
    const active = {
      requestId: "request-current",
      streamId: "stream-current",
      petId: "pet-a"
    };

    expect(isCurrentAiStreamEvent(createEvent({ requestId: "request-old" }), active)).toBe(false);
    expect(isCurrentAiStreamEvent(createEvent({ streamId: "stream-old" }), active)).toBe(false);
    expect(isCurrentAiStreamEvent(createEvent({ petId: "pet-b" }), active)).toBe(false);
  });
});
