import {
  BookOpen,
  Bot,
  FolderOpen,
  Image,
  ListChecks,
  MessagesSquare,
  Mic2,
  MousePointerClick,
  Palette,
  Settings2,
  Smile,
  Volume2
} from "lucide-react";
import type { BuiltInPetUiTheme, PetExpressionKey, PetLineEvent } from "../../../shared/types/pet";

export type EditorTab = "basic" | "live2d" | "ai" | "dialogue" | "interaction";
export type AiSubTab = "aiConfig" | "persona" | "expressions" | "events";
export type DialogueSubTab = "voiceInput" | "voiceReply";
export type InteractionSubTab = "themeStyle" | "quickActions";
export type ActiveEditorPanel = EditorTab | AiSubTab | DialogueSubTab | InteractionSubTab;

export const uiThemeOptions: Array<{ id: BuiltInPetUiTheme; name: string; description: string }> = [
  { id: "soft", name: "软糖风", description: "轻柔、明亮，适合陪伴型桌宠。" },
  { id: "rock", name: "摇滚风", description: "黑金霓虹，适合乐队、舞台和高能角色。" },
  { id: "pixel", name: "像素风", description: "硬边块面和游戏机质感，适合复古、游戏角色。" },
  { id: "journal", name: "手账风", description: "纸张、贴纸和手写感，适合治愈、日常记录角色。" },
  { id: "cyber", name: "赛博风", description: "高对比霓虹和玻璃面板，适合未来感、机械系角色。" },
  { id: "minimal", name: "极简风", description: "黑白留白和清晰线条，适合冷静、效率型角色。" }
];

export const editorTabs: Array<{
  id: Exclude<EditorTab, "ai" | "dialogue" | "interaction">;
  label: string;
  icon: typeof Settings2;
}> = [
  { id: "basic", label: "基础信息", icon: Image },
  { id: "live2d", label: "Live2D", icon: FolderOpen }
];

export const aiSubTabs: Array<{ id: AiSubTab; label: string; icon: typeof Settings2 }> = [
  { id: "aiConfig", label: "LLM配置", icon: Bot },
  { id: "persona", label: "角色人设", icon: BookOpen },
  { id: "events", label: "事件配置", icon: ListChecks },
  { id: "expressions", label: "表现映射", icon: Smile }
];

export const dialogueSubTabs: Array<{ id: DialogueSubTab; label: string; icon: typeof Settings2 }> = [
  { id: "voiceInput", label: "语音输入", icon: Mic2 },
  { id: "voiceReply", label: "声音模型", icon: Volume2 }
];

export const interactionSubTabs: Array<{
  id: InteractionSubTab;
  label: string;
  icon: typeof Settings2;
}> = [
  { id: "themeStyle", label: "主题风格", icon: Palette },
  { id: "quickActions", label: "快捷操作", icon: MousePointerClick }
];

export const expressionOrder: PetExpressionKey[] = [
  "happy",
  "nervous",
  "normal",
  "panic",
  "focus",
  "awake",
  "offline",
  "shy",
  "ready",
  "melt",
  "impact",
  "crying"
];

export const commonMappingKeys = [
  "happy",
  "sad",
  "angry",
  "surprised",
  "shy",
  "nervous",
  "normal",
  "panic",
  "focus",
  "sleepy",
  "awake",
  "idle",
  "ready",
  "thinking",
  "confused",
  "excited",
  "crying",
  "melt",
  "impact",
  "offline"
] as const;

export const eventLabels: Array<{
  id: PetLineEvent;
  label: string;
  fallbackExpression: PetExpressionKey;
  expressionDurationMs: number;
}> = [
  { id: "ready", label: "模型加载完成", fallbackExpression: "nervous", expressionDurationMs: 2200 },
  { id: "click", label: "点击模型", fallbackExpression: "shy", expressionDurationMs: 2800 },
  { id: "rapidClick", label: "连续快速点击", fallbackExpression: "melt", expressionDurationMs: 3200 },
  { id: "drag", label: "拖拽模型", fallbackExpression: "focus", expressionDurationMs: 2400 },
  { id: "chatOpen", label: "打开聊天", fallbackExpression: "panic", expressionDurationMs: 1800 },
  { id: "chatClose", label: "关闭聊天", fallbackExpression: "crying", expressionDurationMs: 1800 },
  { id: "clickThroughOn", label: "开启穿透", fallbackExpression: "ready", expressionDurationMs: 2200 },
  { id: "clickThroughOff", label: "关闭穿透", fallbackExpression: "happy", expressionDurationMs: 2200 },
  { id: "idle", label: "长时间无操作", fallbackExpression: "offline", expressionDurationMs: 3600 },
  { id: "closing", label: "关闭桌宠", fallbackExpression: "crying", expressionDurationMs: 1800 }
];

export const commonSceneTags = ["桌面陪伴", "学习工作", "文本聊天", "任务提醒", "情绪陪伴", "音乐练习"];
