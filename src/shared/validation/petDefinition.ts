import type {
  PetDefinition,
  PetVoiceLanguage,
  PetVoiceModelSettings
} from "../types/pet";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordOrEmpty(value: unknown, fieldName: string): UnknownRecord {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error(`桌宠配置字段 ${fieldName} 的类型无效。`);
  }

  return value;
}

function stringOrDefault(value: unknown, fallback: string, fieldName: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new Error(`桌宠配置字段 ${fieldName} 的类型无效。`);
  }

  return value;
}

function booleanOrDefault(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`桌宠配置字段 ${fieldName} 的类型无效。`);
  }

  return value;
}

function stringArrayOrDefault(value: unknown, fallback: string[], fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [...fallback];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`桌宠配置字段 ${fieldName} 的类型无效。`);
  }

  return [...value];
}

function normalizeVoiceModelSettings(value: unknown): PetVoiceModelSettings | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const settings = recordOrEmpty(value, "voiceModelSettings");
  const language = ["zh", "ja", "en"].includes(String(settings.language))
    ? settings.language as PetVoiceLanguage
    : "zh";

  return {
    ...settings,
    enabled: booleanOrDefault(settings.enabled, false, "voiceModelSettings.enabled"),
    connected: booleanOrDefault(settings.connected, false, "voiceModelSettings.connected"),
    gptSoVitsRootPath: stringOrDefault(
      settings.gptSoVitsRootPath,
      "",
      "voiceModelSettings.gptSoVitsRootPath"
    ),
    sovitsModelPath: stringOrDefault(
      settings.sovitsModelPath,
      "",
      "voiceModelSettings.sovitsModelPath"
    ),
    gptModelPath: stringOrDefault(
      settings.gptModelPath,
      "",
      "voiceModelSettings.gptModelPath"
    ),
    referenceAudioPath: stringOrDefault(
      settings.referenceAudioPath,
      "",
      "voiceModelSettings.referenceAudioPath"
    ),
    referenceText: stringOrDefault(
      settings.referenceText,
      "",
      "voiceModelSettings.referenceText"
    ),
    referenceLanguage: ["zh", "ja", "en"].includes(String(settings.referenceLanguage))
      ? settings.referenceLanguage as PetVoiceLanguage
      : language,
    language,
    playMode: "sentence",
    inferenceDevice: ["auto", "cuda", "cpu"].includes(String(settings.inferenceDevice))
      ? settings.inferenceDevice as PetVoiceModelSettings["inferenceDevice"]
      : "auto",
    halfPrecision: booleanOrDefault(
      settings.halfPrecision,
      true,
      "voiceModelSettings.halfPrecision"
    ),
    syncTextWithVoice: booleanOrDefault(
      settings.syncTextWithVoice,
      true,
      "voiceModelSettings.syncTextWithVoice"
    )
  } as PetVoiceModelSettings;
}

/**
 * 将历史版本中尚未存在的字段补成当前运行时默认值。
 * 该函数只返回内存副本；读取旧配置本身不会触发磁盘写入。
 */
export function normalizeLegacyPetDefinition(pet: PetDefinition): PetDefinition {
  const rawPet = pet as unknown as UnknownRecord;
  const capabilities = recordOrEmpty(rawPet.capabilities, "capabilities");
  const details = recordOrEmpty(rawPet.details, "details");
  const uiSettings = recordOrEmpty(rawPet.uiSettings, "uiSettings");
  const subtitleStyle = recordOrEmpty(rawPet.subtitleStyle, "subtitleStyle");
  const legacyScenes = details.scenes ?? details.scenarios;

  return {
    ...pet,
    description: stringOrDefault(rawPet.description, "", "description"),
    modelPath: stringOrDefault(rawPet.modelPath, "", "modelPath"),
    personaPrompt: stringOrDefault(rawPet.personaPrompt, "", "personaPrompt"),
    capabilities: {
      ...capabilities,
      chat: booleanOrDefault(capabilities.chat, false, "capabilities.chat"),
      voiceInput: booleanOrDefault(
        capabilities.voiceInput,
        false,
        "capabilities.voiceInput"
      ),
      voiceOutput: booleanOrDefault(
        capabilities.voiceOutput,
        false,
        "capabilities.voiceOutput"
      ),
      subtitles: booleanOrDefault(capabilities.subtitles, true, "capabilities.subtitles")
    },
    details: {
      ...details,
      role: stringOrDefault(details.role, "", "details.role"),
      personality: stringOrDefault(details.personality, "", "details.personality"),
      scenes: stringArrayOrDefault(legacyScenes, [], "details.scenes"),
      features: Array.isArray(details.features) ? details.features : []
    },
    voiceModelSettings: normalizeVoiceModelSettings(rawPet.voiceModelSettings),
    uiSettings: {
      ...uiSettings,
      theme: typeof uiSettings.theme === "string" ? uiSettings.theme : "soft",
      clickThroughOpacity: typeof uiSettings.clickThroughOpacity === "number"
        ? uiSettings.clickThroughOpacity
        : 0.45,
      cursorFollowEnabled: booleanOrDefault(
        uiSettings.cursorFollowEnabled,
        true,
        "uiSettings.cursorFollowEnabled"
      )
    } as PetDefinition["uiSettings"],
    subtitleStyle: {
      ...subtitleStyle,
      tone: ["soft", "bright", "calm"].includes(String(subtitleStyle.tone))
        ? subtitleStyle.tone
        : "soft"
    } as PetDefinition["subtitleStyle"]
  };
}
