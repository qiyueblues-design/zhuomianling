import fs from "node:fs/promises";
import {
  calculateEffectiveMood,
  clampMoodValue,
  getMoodRange,
  moodDecayDelayMs,
  moodDecayStepMs,
  moodGlobalEventCooldownMs,
  systemMoodEventRules,
  type SystemMoodEvent
} from "../../../shared/mood";
import type {
  MoodMutationResult,
  PersistedPetMoodState,
  PetMoodDisplayState,
  PetMoodMeterPosition,
  PetMoodReplySnapshot
} from "../../../shared/types/mood";
import { parsePersistedMoodState } from "../../../shared/validation/mood";
import { assertValidPetId } from "../../../shared/validation/petId";
import { writeJsonFileAtomically } from "../config/durableJsonFile";
import { withPetConfigWriteLock } from "../config/petConfigWriteQueue";
import { getMoodDirectoryPath, getMoodStatePath } from "./moodPaths";

type Listener = (state: PetMoodDisplayState) => void;
type MutationListener = (petId: string, result: MoodMutationResult) => void;

export class MoodService {
  private readonly snapshots = new Map<string, PetMoodReplySnapshot>();
  private readonly appliedAiRequests = new Set<string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly mutationListeners = new Set<MutationListener>();
  private decayTimer?: NodeJS.Timeout;

  private snapshotKey(ownerId: number, petId: string, requestId: string): string {
    return `${ownerId}:${petId}:${requestId}`;
  }

  private async readState(petId: string, now = Date.now()): Promise<PersistedPetMoodState> {
    assertValidPetId(petId);
    try {
      const parsed = JSON.parse((await fs.readFile(getMoodStatePath(petId), "utf8")).replace(/^\uFEFF/, "")) as unknown;
      return parsePersistedMoodState(parsed, now);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { schemaVersion: 1, baseValue: 0, baseChangedAt: now };
      }
      if (error instanceof SyntaxError) throw new Error("MOOD_STATE_CORRUPTED");
      throw error;
    }
  }

  private display(state: PersistedPetMoodState, now: number): PetMoodDisplayState {
    const value = calculateEffectiveMood(state.baseValue, state.baseChangedAt, now);
    const range = getMoodRange(value);
    return { value, rangeId: range.id, label: range.label, meterPosition: state.meterPosition };
  }

  async getDisplayState(petId: string, now = Date.now()): Promise<PetMoodDisplayState> {
    return this.display(await this.readState(petId, now), now);
  }

  async createReplySnapshot(ownerId: number, petId: string, requestId: string, now = Date.now()): Promise<PetMoodReplySnapshot> {
    const state = await this.getDisplayState(petId, now);
    const snapshot = Object.freeze({ ownerId, petId, requestId, value: state.value, rangeId: state.rangeId, createdAt: now });
    this.snapshots.set(this.snapshotKey(ownerId, petId, requestId), snapshot);
    if (this.snapshots.size > 256) this.snapshots.delete(this.snapshots.keys().next().value as string);
    return snapshot;
  }

  getReplySnapshot(ownerId: number, petId: string, requestId: string): PetMoodReplySnapshot | undefined {
    return this.snapshots.get(this.snapshotKey(ownerId, petId, requestId));
  }

  releaseReplySnapshot(ownerId: number, petId: string, requestId: string): void {
    this.snapshots.delete(this.snapshotKey(ownerId, petId, requestId));
  }

  private async mutate(petId: string, now: number, mutation: (state: PersistedPetMoodState, effective: number) => number | undefined): Promise<MoodMutationResult> {
    return withPetConfigWriteLock(assertValidPetId(petId), async () => {
      const state = await this.readState(petId, now);
      const before = this.display(state, now);
      const nextValue = mutation(state, before.value);
      if (nextValue === undefined || clampMoodValue(nextValue) === before.value) return { changed: false, state: before };
      state.baseValue = clampMoodValue(nextValue);
      state.baseChangedAt = now;
      await fs.mkdir(getMoodDirectoryPath(petId), { recursive: true });
      await writeJsonFileAtomically(getMoodStatePath(petId), state);
      const after = this.display(state, now);
      this.emit(petId, after);
      void this.rescheduleDecayTimer();
      const result = { changed: true, state: after, previousRangeId: before.rangeId, enteredRangeId: before.rangeId === after.rangeId ? undefined : after.rangeId };
      for (const listener of this.mutationListeners) listener(petId, result);
      return result;
    });
  }

  async applySystemEvent(petId: string, event: SystemMoodEvent, now = Date.now()): Promise<MoodMutationResult> {
    const rule = systemMoodEventRules[event];
    if (!rule) throw new Error("未知的心情事件。");
    return this.mutate(petId, now, (state, effective) => {
      if ((state.eventCooldowns?.[event] ?? 0) > now || (state.globalEventCooldownUntil ?? 0) > now) return undefined;
      state.eventCooldowns = { ...state.eventCooldowns, [event]: now + rule.cooldownMs };
      state.globalEventCooldownUntil = now + moodGlobalEventCooldownMs;
      return effective + rule.delta;
    });
  }

  async applyAiDelta(petId: string, requestId: string, delta: number, now = Date.now()): Promise<MoodMutationResult> {
    const key = `${assertValidPetId(petId)}:${requestId}`;
    if (this.appliedAiRequests.has(key)) return { changed: false, state: await this.getDisplayState(petId, now) };
    this.appliedAiRequests.add(key);
    if (!Number.isInteger(delta) || !Number.isFinite(delta) || delta === 0) return { changed: false, state: await this.getDisplayState(petId, now) };
    try {
      return await this.mutate(petId, now, (_state, effective) => effective + Math.max(-12, Math.min(12, delta)));
    } catch (error) {
      this.appliedAiRequests.delete(key);
      throw error;
    }
  }

  async saveMeterPosition(petId: string, position: PetMoodMeterPosition, now = Date.now()): Promise<void> {
    await withPetConfigWriteLock(assertValidPetId(petId), async () => {
      const state = await this.readState(petId, now);
      state.meterPosition = position;
      await fs.mkdir(getMoodDirectoryPath(petId), { recursive: true });
      await writeJsonFileAtomically(getMoodStatePath(petId), state);
      this.emit(petId, this.display(state, now));
    });
  }

  subscribe(petId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(petId) ?? new Set<Listener>();
    listeners.add(listener); this.listeners.set(petId, listeners);
    void this.rescheduleDecayTimer();
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(petId); void this.rescheduleDecayTimer(); };
  }

  private async rescheduleDecayTimer(): Promise<void> {
    clearTimeout(this.decayTimer); this.decayTimer = undefined;
    let nextAt = Number.POSITIVE_INFINITY; const now = Date.now();
    for (const petId of this.listeners.keys()) {
      try {
        const state = await this.readState(petId, now);
        const effective = calculateEffectiveMood(state.baseValue, state.baseChangedAt, now);
        if (effective === 0) continue;
        const elapsed = Math.max(0, now - state.baseChangedAt - moodDecayDelayMs);
        const steps = Math.floor(elapsed / moodDecayStepMs);
        nextAt = Math.min(nextAt, state.baseChangedAt + moodDecayDelayMs + (steps + 1) * moodDecayStepMs);
      } catch { /* Explicit reads surface corruption; timers never overwrite it. */ }
    }
    if (!Number.isFinite(nextAt)) return;
    this.decayTimer = setTimeout(() => {
      const tickNow = Date.now();
      for (const petId of this.listeners.keys()) void this.getDisplayState(petId, tickNow).then((state) => this.emit(petId, state)).catch(() => undefined);
      void this.rescheduleDecayTimer();
    }, Math.max(1, nextAt - now));
  }

  subscribeMutations(listener: MutationListener): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  private emit(petId: string, state: PetMoodDisplayState): void { for (const listener of this.listeners.get(petId) ?? []) listener(state); }
  disposeOwner(ownerId: number): void { for (const [key, value] of this.snapshots) if (value.ownerId === ownerId) this.snapshots.delete(key); }
  async deletePetState(petId: string): Promise<void> { await fs.rm(getMoodDirectoryPath(assertValidPetId(petId)), { recursive: true, force: true }); this.listeners.delete(petId); }
}

export const moodService = new MoodService();
