import { describe, expect, it } from "vitest";
import { VoiceRecordingLifecycle } from "./voiceRecordingLifecycle";

describe("VoiceRecordingLifecycle", () => {
  it("locks connecting synchronously and rejects a repeated begin", () => {
    const lifecycle = new VoiceRecordingLifecycle();

    const token = lifecycle.begin();
    const repeatedToken = lifecycle.begin();

    expect(token).toBeDefined();
    expect(lifecycle.phase).toBe("connecting");
    expect(repeatedToken).toBeUndefined();
    expect(lifecycle.isCurrent(token!)).toBe(true);
  });

  it("refuses to begin while unavailable and can begin after being enabled", () => {
    const lifecycle = new VoiceRecordingLifecycle();

    lifecycle.setAvailable(false);

    expect(lifecycle.isAvailable).toBe(false);
    expect(lifecycle.begin()).toBeUndefined();
    expect(lifecycle.phase).toBe("idle");

    lifecycle.setAvailable(true);
    const token = lifecycle.begin();

    expect(token).toBeDefined();
    expect(lifecycle.isCurrent(token!)).toBe(true);
  });

  it("invalidates a late connecting result when availability is removed", () => {
    const lifecycle = new VoiceRecordingLifecycle();
    const token = lifecycle.begin();

    expect(token).toBeDefined();

    lifecycle.setAvailable(false);

    expect(lifecycle.phase).toBe("idle");
    expect(lifecycle.isCurrent(token!)).toBe(false);
    expect(lifecycle.markRecording(token!)).toBe(false);
  });

  it("does not let a canceled attempt take over a newer recording", () => {
    const lifecycle = new VoiceRecordingLifecycle();
    const staleToken = lifecycle.begin();

    lifecycle.setAvailable(false);
    lifecycle.setAvailable(true);
    const currentToken = lifecycle.begin();

    expect(staleToken).toBeDefined();
    expect(currentToken).toBeDefined();
    expect(lifecycle.isCurrent(staleToken!)).toBe(false);
    expect(lifecycle.markRecording(staleToken!)).toBe(false);
    expect(lifecycle.markRecording(currentToken!)).toBe(true);
    expect(lifecycle.phase).toBe("recording");
  });

  it("supports the complete connecting, recording, and transcribing flow", () => {
    const lifecycle = new VoiceRecordingLifecycle();
    const token = lifecycle.begin();

    expect(token).toBeDefined();
    expect(lifecycle.markRecording(token!)).toBe(true);
    expect(lifecycle.phase).toBe("recording");
    expect(lifecycle.beginTranscribing()).toBe(true);
    expect(lifecycle.phase).toBe("transcribing");
    expect(lifecycle.finishTranscribing()).toBe(true);
    expect(lifecycle.phase).toBe("idle");
    expect(lifecycle.isCurrent(token!)).toBe(false);
  });

  it("cancels active work idempotently", () => {
    const lifecycle = new VoiceRecordingLifecycle();
    const token = lifecycle.begin();

    expect(token).toBeDefined();
    expect(lifecycle.markRecording(token!)).toBe(true);
    expect(lifecycle.cancel()).toBe(true);
    expect(lifecycle.cancel()).toBe(false);
    expect(lifecycle.phase).toBe("idle");
    expect(lifecycle.isCurrent(token!)).toBe(false);
  });
});
