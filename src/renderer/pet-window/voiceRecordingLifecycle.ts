export type VoiceRecordingPhase = "idle" | "connecting" | "recording" | "transcribing";

export type VoiceRecordingToken = number;

/**
 * Coordinates voice-recording phase transitions without owning browser audio
 * resources. Callers keep the token returned by begin() and re-check it after
 * every asynchronous boundary before retaining a microphone stream or ASR
 * session.
 */
export class VoiceRecordingLifecycle {
  private currentPhase: VoiceRecordingPhase = "idle";
  private currentGeneration = 0;
  private available = true;

  get phase(): VoiceRecordingPhase {
    return this.currentPhase;
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /**
   * Disabling recording also invalidates an in-flight start attempt. This is
   * used when chat is hidden, click-through is enabled, or the window closes.
   */
  setAvailable(value: boolean): void {
    this.available = value;

    if (!value) {
      this.cancel();
    }
  }

  /**
   * Acquires the synchronous connecting lock. A second begin() cannot pass
   * before React (or any other UI observer) has rendered the new phase.
   */
  begin(): VoiceRecordingToken | undefined {
    if (!this.available || this.currentPhase !== "idle") {
      return undefined;
    }

    this.currentGeneration += 1;
    this.currentPhase = "connecting";
    return this.currentGeneration;
  }

  /** Returns false for a canceled, completed, or superseded async attempt. */
  isCurrent(token: VoiceRecordingToken): boolean {
    return (
      this.available &&
      this.currentPhase !== "idle" &&
      token === this.currentGeneration
    );
  }

  markRecording(token: VoiceRecordingToken): boolean {
    if (
      !this.available ||
      this.currentPhase !== "connecting" ||
      token !== this.currentGeneration
    ) {
      return false;
    }

    this.currentPhase = "recording";
    return true;
  }

  beginTranscribing(): boolean {
    if (this.currentPhase !== "recording") {
      return false;
    }

    this.currentPhase = "transcribing";
    return true;
  }

  finishTranscribing(): boolean {
    if (this.currentPhase !== "transcribing") {
      return false;
    }

    this.currentGeneration += 1;
    this.currentPhase = "idle";
    return true;
  }

  /**
   * Invalidates the active generation and returns to idle. Repeated cleanup is
   * intentionally harmless so multiple visibility/window teardown paths can
   * share one cancellation routine.
   */
  cancel(): boolean {
    if (this.currentPhase === "idle") {
      return false;
    }

    this.currentGeneration += 1;
    this.currentPhase = "idle";
    return true;
  }
}
