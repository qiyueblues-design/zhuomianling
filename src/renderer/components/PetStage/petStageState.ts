import type {
  LocalPetVoiceModelDraft,
  PetVoiceModelSettings
} from "../../../shared/types/pet";

export interface VoiceReadiness {
  ready: boolean;
  text: string;
  issue?: VoiceConfigurationIssue;
}

export interface VoiceConfigurationIssue {
  code: "root-path" | "model-files" | "reference-audio" | "reference-text";
  summary: string;
  guidance: string;
}

function hasText(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

export function getVoiceReadiness(
  settings: PetVoiceModelSettings | undefined
): VoiceReadiness {
  if (!hasText(settings?.gptSoVitsRootPath)) {
    const issue: VoiceConfigurationIssue = {
      code: "root-path",
      summary: "未配置 GPT-SoVITS 本地路径",
      guidance: "请前往“编辑 → 对话 → 声音模型 → 运行环境”设置。"
    };
    return { ready: false, text: issue.summary, issue };
  }

  if (!hasText(settings.sovitsModelPath) || !hasText(settings.gptModelPath)) {
    const issue: VoiceConfigurationIssue = {
      code: "model-files",
      summary: "未完整选择 GPT / SoVITS 模型文件",
      guidance: "请前往“编辑 → 对话 → 声音模型 → 模型文件”补充。"
    };
    return { ready: false, text: issue.summary, issue };
  }

  if (!hasText(settings.referenceAudioPath)) {
    const issue: VoiceConfigurationIssue = {
      code: "reference-audio",
      summary: "未配置参考音频",
      guidance: "请前往“编辑 → 对话 → 声音模型 → 参考音频”选择文件。"
    };
    return { ready: false, text: issue.summary, issue };
  }

  if (!hasText(settings.referenceText)) {
    const issue: VoiceConfigurationIssue = {
      code: "reference-text",
      summary: "参考文本缺失",
      guidance: "请前往“编辑 → 对话 → 声音模型 → 参考文本”补充音频对应文字。"
    };
    return { ready: false, text: issue.summary, issue };
  }

  return { ready: true, text: settings.connected ? "已连接" : "可连接" };
}

export function buildVoiceDraft(
  petId: string,
  settings: PetVoiceModelSettings | undefined,
  enabled: boolean,
  connected: boolean
): LocalPetVoiceModelDraft | undefined {
  if (
    !hasText(settings?.gptSoVitsRootPath) ||
    !hasText(settings.sovitsModelPath) ||
    !hasText(settings.gptModelPath) ||
    !hasText(settings.referenceAudioPath) ||
    !hasText(settings.referenceText)
  ) {
    return undefined;
  }

  return {
    petId,
    enabled,
    connected,
    gptSoVitsRootPath: settings.gptSoVitsRootPath,
    sovitsModelPath: settings.sovitsModelPath,
    gptModelPath: settings.gptModelPath,
    referenceAudioPath: settings.referenceAudioPath,
    referenceText: settings.referenceText.trim(),
    referenceLanguage: settings.referenceLanguage ?? settings.language,
    language: settings.language,
    playMode: "sentence",
    inferenceDevice: settings.inferenceDevice ?? "auto",
    halfPrecision: settings.halfPrecision ?? true,
    syncTextWithVoice: settings.syncTextWithVoice ?? true
  };
}
