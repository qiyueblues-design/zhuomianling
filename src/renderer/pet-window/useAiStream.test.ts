import { describe, expect, it } from "vitest";
import type { PetDefinition } from "../../shared/types/pet";
import type { SpeechFrontendSettings } from "../services/speech/speechSettings";
import { createAiStreamSettingsSnapshot } from "./useAiStream";

const voiceSettings: SpeechFrontendSettings = {
  autoEndEnabled: true,
  continuousConversationEnabled: true,
  voiceReplyEnabled: true,
  voiceReplyMode: "sentence",
  syncTextWithVoice: true,
  silenceSeconds: 1,
  volumeThreshold: 0.18
};

describe("AI stream settings snapshot", () => {
  it("freezes voice and synchronization behavior for the active request", () => {
    const mutableSettings = { ...voiceSettings };
    const snapshot = createAiStreamSettingsSnapshot(mutableSettings);

    mutableSettings.voiceReplyEnabled = false;
    mutableSettings.syncTextWithVoice = false;

    expect(snapshot).toEqual({
      voiceReplyEnabled: true,
      syncTextWithVoice: true,
      useReplyAsVoiceText: true
    });
  });

  it("selects voiceText streaming when chat and voice languages differ", () => {
    const petDefinition = {
      personaSettings: { chatLanguage: "zh" },
      voiceModelSettings: { language: "ja" }
    } as unknown as PetDefinition;

    expect(createAiStreamSettingsSnapshot(voiceSettings, petDefinition)).toMatchObject({
      voiceReplyEnabled: true,
      syncTextWithVoice: true,
      useReplyAsVoiceText: false
    });
  });

  it("never enables synchronization for a request without voice reply", () => {
    expect(
      createAiStreamSettingsSnapshot({ ...voiceSettings, voiceReplyEnabled: false })
    ).toMatchObject({
      voiceReplyEnabled: false,
      syncTextWithVoice: false,
      useReplyAsVoiceText: false
    });
  });
});
