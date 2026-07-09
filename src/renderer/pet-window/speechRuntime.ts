import type {
  PetEventSettings,
  PetVoiceInputSettings,
  PetVoiceModelSettings
} from "../../shared/types/pet";
import {
  readSpeechFrontendSettings,
  type SpeechFrontendSettings
} from "../services/speech/speechSettings";

export const defaultEventSettings: Record<
  string,
  PetEventSettings & { expressionDurationMs: number }
> = {
  ready: {
    expression: "nervous",
    expressionDurationMs: 2200
  },
  click: {
    expression: "shy",
    expressionDurationMs: 2800
  },
  rapidClick: {
    expression: "melt",
    expressionDurationMs: 3200
  },
  drag: {
    expression: "focus",
    expressionDurationMs: 2400
  },
  chatOpen: {
    expression: "panic",
    expressionDurationMs: 1800
  },
  chatClose: {
    expression: "crying",
    expressionDurationMs: 1800
  },
  clickThroughOn: {
    expression: "ready",
    expressionDurationMs: 2200
  },
  clickThroughOff: {
    expression: "happy",
    expressionDurationMs: 2200
  },
  idle: {
    expression: "offline",
    expressionDurationMs: 3600
  },
  closing: {
    expression: "crying",
    expressionDurationMs: 1800
  },
  modelError: {
    expression: "panic",
    expressionDurationMs: 4200
  },
  userMessage: {
    expression: "focus",
    expressionDurationMs: 1800
  }
};

export function buildSpeechSettings(
  voiceInputSettings?: PetVoiceInputSettings,
  voiceModelSettings?: PetVoiceModelSettings,
  fallbackSettings: SpeechFrontendSettings = readSpeechFrontendSettings()
): SpeechFrontendSettings {
  const voiceReplySettings = voiceModelSettings
    ? {
        voiceReplyEnabled: voiceModelSettings.enabled && voiceModelSettings.connected,
        voiceReplyMode: voiceModelSettings.playMode,
        syncTextWithVoice: voiceModelSettings.syncTextWithVoice ?? false
      }
    : {};

  if (!voiceInputSettings?.connected) {
    return {
      ...fallbackSettings,
      ...voiceReplySettings
    };
  }

  return {
    ...fallbackSettings,
    ...voiceReplySettings,
    autoEndEnabled: voiceInputSettings.autoEndEnabled,
    continuousConversationEnabled: voiceInputSettings.continuousConversationEnabled,
    silenceSeconds: voiceInputSettings.silenceSeconds,
    volumeThreshold: voiceInputSettings.volumeThreshold
  };
}
