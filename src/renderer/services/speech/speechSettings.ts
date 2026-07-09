export interface SpeechFrontendSettings {
  autoEndEnabled: boolean;
  continuousConversationEnabled: boolean;
  voiceReplyEnabled: boolean;
  voiceReplyMode: "sentence" | "full";
  syncTextWithVoice: boolean;
  silenceSeconds: number;
  volumeThreshold: number;
}

export const speechFrontendSettingsKey = "desktop-pet:speech-settings";

export const defaultSpeechFrontendSettings: SpeechFrontendSettings = {
  autoEndEnabled: true,
  continuousConversationEnabled: false,
  voiceReplyEnabled: false,
  voiceReplyMode: "full",
  syncTextWithVoice: false,
  silenceSeconds: 1,
  volumeThreshold: 0.18
};

export function readSpeechFrontendSettings(): SpeechFrontendSettings {
  try {
    const rawSettings = window.localStorage.getItem(speechFrontendSettingsKey);

    if (!rawSettings) {
      return defaultSpeechFrontendSettings;
    }

    const parsed = JSON.parse(rawSettings) as Partial<SpeechFrontendSettings>;
    const silenceSeconds = Number(parsed.silenceSeconds);
    const volumeThreshold = Number(parsed.volumeThreshold);

    return {
      autoEndEnabled: parsed.autoEndEnabled ?? defaultSpeechFrontendSettings.autoEndEnabled,
      continuousConversationEnabled:
        parsed.continuousConversationEnabled ??
        defaultSpeechFrontendSettings.continuousConversationEnabled,
      voiceReplyEnabled:
        parsed.voiceReplyEnabled ?? defaultSpeechFrontendSettings.voiceReplyEnabled,
      voiceReplyMode:
        parsed.voiceReplyMode === "full" || parsed.voiceReplyMode === "sentence"
          ? parsed.voiceReplyMode
          : defaultSpeechFrontendSettings.voiceReplyMode,
      syncTextWithVoice: parsed.syncTextWithVoice ?? defaultSpeechFrontendSettings.syncTextWithVoice,
      silenceSeconds: [1, 2, 3].includes(silenceSeconds)
        ? silenceSeconds
        : defaultSpeechFrontendSettings.silenceSeconds,
      volumeThreshold:
        Number.isFinite(volumeThreshold) && volumeThreshold >= 0.04 && volumeThreshold <= 0.45
          ? volumeThreshold
          : defaultSpeechFrontendSettings.volumeThreshold
    };
  } catch {
    return defaultSpeechFrontendSettings;
  }
}

export function saveSpeechFrontendSettings(settings: SpeechFrontendSettings): void {
  window.localStorage.setItem(speechFrontendSettingsKey, JSON.stringify(settings));
}
