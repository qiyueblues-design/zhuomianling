export interface PetCapabilities {
  chat: boolean;
  voiceInput?: boolean;
  voiceOutput: boolean;
  subtitles: boolean;
}

export interface PetFeature {
  title: string;
  description: string;
  status: "ready" | "planned";
}

export interface PetDetails {
  role: string;
  personality: string;
  scenes: string[];
  features: PetFeature[];
}

export type PetSubtitleTone = "soft" | "bright" | "calm";

export type BasePetLineEvent =
  | "ready"
  | "click"
  | "chatOpen"
  | "chatClose"
  | "userMessage"
  | "aiReply"
  | "idle"
  | "drag"
  | "rapidClick"
  | "clickThroughOn"
  | "clickThroughOff"
  | "closing"
  | "modelError";

export type PetLineEvent = BasePetLineEvent | (string & {});
export interface PetPresetLine {
  text: string;
  audioPath?: string;
}
export type PetLine = string | PetPresetLine;
export type PetLineMap = Partial<Record<PetLineEvent, PetLine[]>>;

export interface PetEventSettings {
  expression?: PetExpressionKey;
  expressionDurationMs?: number;
  source?: PetExpressionSourceItem;
  sourceDurationMs?: number;
  [key: string]: unknown;
}

export type PetEventSettingsMap = Partial<Record<PetLineEvent, PetEventSettings>>;

export interface PetSubtitleStyle {
  tone: PetSubtitleTone;
  maxWidth?: number;
}

export type BasePetExpressionKey =
  | "happy"
  | "nervous"
  | "normal"
  | "panic"
  | "focus"
  | "awake"
  | "offline"
  | "shy"
  | "ready"
  | "melt"
  | "impact"
  | "crying";

export type PetExpressionKey = BasePetExpressionKey | (string & {});
export type PetExpressionMap = Partial<Record<PetExpressionKey, string | number>>;
export type PetExpressionDescriptionMap = Partial<Record<PetExpressionKey, string>>;
export type PetExpressionSourceKind = "expression" | "motion";
export type PetExpressionSourceKindMap = Partial<Record<PetExpressionKey, PetExpressionSourceKind>>;
export type PetExpressionSourceFileMap = Partial<Record<PetExpressionKey, string>>;

export interface PetExpressionSourceItem {
  sourceFileName: string;
  runtimeName?: string | number;
  sourceKind: PetExpressionSourceKind;
  description?: string;
  effects?: PetExpressionEffect;
}

export interface PetExpressionParameterEffect {
  id: string;
  value: number;
}

export interface PetExpressionPartOpacityEffect {
  idOrIndex: string | number;
  opacity: number;
}

export interface PetExpressionEffect {
  parameters?: PetExpressionParameterEffect[];
  parts?: PetExpressionPartOpacityEffect[];
}

export type PetExpressionEffectMap = Partial<Record<PetExpressionKey, PetExpressionEffect>>;
export type PetChatLanguage = "zh" | "ja" | "en";
export type PetReplyLength = "short" | "medium" | "long";
export type PetVoiceLanguage = "zh" | "ja" | "en";
export type PetVoiceReplyMode = "sentence" | "full";
export type PetVoiceInputSilenceSeconds = 1 | 2 | 3;
export type BuiltInPetUiTheme = "soft" | "rock" | "pixel" | "journal" | "cyber" | "minimal";
export type PetUiTheme = BuiltInPetUiTheme | "custom";
export type PetExpressionSelectionMode = "semantic" | "random";
export type PetExpressionRandomScope = PetExpressionSourceKind | "all";

export interface PetCustomThemeTokens {
  background: string;
  surface: string;
  petSurface?: string;
  text: string;
  mutedText: string;
  accent: string;
  accentStrong?: string;
  border: string;
  danger?: string;
  shadow?: string;
  radius?: number;
}

export interface PetCustomTheme {
  id: string;
  name: string;
  description: string;
  version: number;
  author?: string;
  importedAt?: string;
  tokens: PetCustomThemeTokens;
}

export interface PetCustomThemeListResult {
  ok: boolean;
  message: string;
  themes: PetCustomTheme[];
}

export interface PetCustomThemeImportResult {
  ok: boolean;
  message: string;
  canceled?: boolean;
  theme?: PetCustomTheme;
}

export interface PetPersonaSettings {
  chatLanguage: PetChatLanguage;
  replyLength?: PetReplyLength;
}

export interface PetVoiceInputSettings {
  provider: "tencent-asr";
  appId: string;
  secretId: string;
  secretKey: string;
  connected: boolean;
  autoEndEnabled: boolean;
  silenceSeconds: PetVoiceInputSilenceSeconds;
  volumeThreshold: number;
  continuousConversationEnabled: boolean;
}

export interface PetVoiceModelSettings {
  enabled: boolean;
  connected: boolean;
  gptSoVitsRootPath?: string;
  sovitsModelPath?: string;
  gptModelPath?: string;
  referenceAudioPath?: string;
  referenceText: string;
  language: PetVoiceLanguage;
  playMode: PetVoiceReplyMode;
  syncTextWithVoice?: boolean;
}

export interface PetLive2DSettings {
  format?: "cubism2" | "cubism4-5";
  entryFileName?: string;
  textureCount: number;
  motionCount: number;
  expressionCount: number;
}

export interface PetUiSettings {
  theme: PetUiTheme;
  customThemeId?: string;
  customTheme?: PetCustomTheme;
}

export interface PetDefinition {
  id: string;
  name: string;
  description: string;
  modelPath: string;
  avatar?: string;
  avatarImage?: string;
  personaPrompt: string;
  defaultVoice?: string;
  personaSettings?: PetPersonaSettings;
  voiceInputSettings?: PetVoiceInputSettings;
  voiceModelSettings?: PetVoiceModelSettings;
  live2dSettings?: PetLive2DSettings;
  uiSettings?: PetUiSettings;
  capabilities: PetCapabilities;
  details: PetDetails;
  expressions?: PetExpressionMap;
  expressionDescriptions?: PetExpressionDescriptionMap;
  expressionSelectionMode?: PetExpressionSelectionMode;
  expressionRandomScope?: PetExpressionRandomScope;
  expressionSourceKinds?: PetExpressionSourceKindMap;
  expressionSourceFiles?: PetExpressionSourceFileMap;
  expressionSources?: PetExpressionSourceItem[];
  expressionEffects?: PetExpressionEffectMap;
  eventSettings?: PetEventSettingsMap;
  lines?: PetLineMap;
  subtitleStyle?: PetSubtitleStyle;
  isLocal?: boolean;
}

export interface LocalPetBasicInfoDraft {
  id?: string;
  name: string;
  avatarImage?: string;
  description: string;
  role: string;
  personality: string;
  scenes: string[];
}

export interface LocalPetPersonaDraft {
  petId: string;
  personaPrompt: string;
  chatLanguage: PetChatLanguage;
  replyLength?: PetReplyLength;
}

export interface LocalPetExpressionMappingItem {
  sourceFileName: string;
  runtimeName?: string | number;
  sourceKind: PetExpressionSourceKind;
  mappingKey: string;
  description: string;
  effects?: PetExpressionEffect;
}

export interface LocalPetExpressionMappingDraft {
  petId: string;
  mappings: LocalPetExpressionMappingItem[];
  sources?: PetExpressionSourceItem[];
  expressionSelectionMode?: PetExpressionSelectionMode;
  expressionRandomScope?: PetExpressionRandomScope;
}

export interface LocalPetEventSettingsItem extends PetEventSettings {
  event: PetLineEvent;
  lines: PetLine[];
}

export interface LocalPetEventSettingsDraft {
  petId: string;
  events: LocalPetEventSettingsItem[];
}

export interface LocalPetUiSettingsDraft {
  petId: string;
  theme: PetUiTheme;
  customThemeId?: string;
}

export interface LocalPetVoiceInputDraft {
  petId: string;
  appId: string;
  secretId: string;
  secretKey: string;
  connected: boolean;
  autoEndEnabled: boolean;
  silenceSeconds: PetVoiceInputSilenceSeconds;
  volumeThreshold: number;
  continuousConversationEnabled: boolean;
}

export type LocalPetVoiceResourceKind = "sovits" | "gpt" | "referenceAudio";

export interface LocalPetVoiceModelDraft {
  petId: string;
  enabled: boolean;
  connected: boolean;
  gptSoVitsRootPath?: string;
  sovitsModelPath?: string;
  gptModelPath?: string;
  referenceAudioPath?: string;
  referenceText: string;
  language: PetVoiceLanguage;
  playMode: PetVoiceReplyMode;
  syncTextWithVoice: boolean;
}

export interface LocalPetVoiceModelFilePickResult {
  ok: boolean;
  message: string;
  filePath?: string;
  fileName?: string;
}

export interface LocalPetVoiceModelConnectionResult {
  ok: boolean;
  message: string;
}

export interface LocalPetSaveResult {
  ok: boolean;
  message: string;
  pet?: PetDefinition;
}

export interface LocalPetAvatarImportResult {
  ok: boolean;
  message: string;
  avatarImage?: string;
  sourceImage?: string;
}

export interface LocalPetAvatarCropSaveRequest {
  petId?: string;
  dataUrl: string;
}

export interface LocalPetDeleteResult {
  ok: boolean;
  message: string;
  petId: string;
}
