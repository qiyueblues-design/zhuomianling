import type { AiChatStreamEvent } from "../../shared/types/ai";

export interface ActiveAiStreamIdentity {
  requestId?: string;
  streamId?: string;
  petId?: string;
}

export function isCurrentAiStreamEvent(
  event: AiChatStreamEvent,
  active: ActiveAiStreamIdentity
): boolean {
  return Boolean(
    active.requestId &&
      event.requestId === active.requestId &&
      (!active.streamId || event.streamId === active.streamId) &&
      (!active.petId || event.petId === active.petId)
  );
}
