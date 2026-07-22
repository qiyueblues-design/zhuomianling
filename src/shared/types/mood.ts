import type { PetExpressionSourceItem, PetMoodSettings } from "./pet";
import type { PetMoodRangeId, SystemMoodEvent } from "../mood";

export interface PetMoodMeterPosition { left: number; top: number }
export interface PetMoodDisplayState { value: number; rangeId: PetMoodRangeId; label: string; meterPosition?: PetMoodMeterPosition }
export interface PetMoodReplySnapshot { ownerId: number; petId: string; requestId: string; value: number; rangeId: PetMoodRangeId; createdAt: number }
export interface PersistedPetMoodState {
  schemaVersion: 1;
  baseValue: number;
  baseChangedAt: number;
  eventCooldowns?: Partial<Record<SystemMoodEvent, number>>;
  globalEventCooldownUntil?: number;
  meterPosition?: PetMoodMeterPosition;
}
export interface MoodMutationResult { changed: boolean; state: PetMoodDisplayState; previousRangeId?: PetMoodRangeId; enteredRangeId?: PetMoodRangeId }
export interface PetMoodRangeEnteredEvent {
  id: number;
  rangeId: PetMoodRangeId;
  source?: PetExpressionSourceItem;
  line?: string;
}
export interface PetMoodEditorState { display: PetMoodDisplayState; settings?: PetMoodSettings }
export interface LocalPetMoodSettingsDraft { petId: string; settings: PetMoodSettings }
export interface PetMoodVoiceImportRequest { petId: string; rangeId: PetMoodRangeId; referenceText: string }
export interface PetMoodVoiceRemoveRequest { petId: string; rangeId: PetMoodRangeId }
export interface PetMoodEnterPreviewRequest { petId: string; rangeId: PetMoodRangeId; source: PetExpressionSourceItem }
export interface PetMoodVoiceImportResult { ok: boolean; message: string; canceled?: boolean; fileName?: string; persisted?: boolean }
