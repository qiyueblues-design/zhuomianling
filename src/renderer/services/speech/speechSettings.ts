export interface SpeechFrontendSettings {
  autoEndEnabled: boolean;
  continuousConversationEnabled: boolean;
  voiceReplyEnabled: boolean;
  voiceReplyMode: "sentence";
  syncTextWithVoice: boolean;
  silenceSeconds: number;
  volumeThreshold: number;
}

export const speechFrontendSettingsKey = "desktop-pet:speech-settings";
const minSilenceSeconds = 0.4;
const maxSilenceSeconds = 2;

function normalizeSilenceSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultSpeechFrontendSettings.silenceSeconds;
  }

  return Math.min(Math.max(Math.round(value * 10) / 10, minSilenceSeconds), maxSilenceSeconds);
}

export const defaultSpeechFrontendSettings: SpeechFrontendSettings = {
  autoEndEnabled: true,
  continuousConversationEnabled: false,
  voiceReplyEnabled: false,
  voiceReplyMode: "sentence",
  syncTextWithVoice: true,
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
      voiceReplyMode: "sentence",
      syncTextWithVoice: parsed.syncTextWithVoice ?? defaultSpeechFrontendSettings.syncTextWithVoice,
      silenceSeconds: normalizeSilenceSeconds(silenceSeconds),
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
