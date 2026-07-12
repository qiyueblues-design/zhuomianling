import type { MemoryChapter, MemoryErrorDto, MemoryRecord } from "../../../shared/types/memory";

export type MemoryBookDisplayMode = "book" | "list";
export type MemoryBookSection = "cover" | "reading";
export type MemoryBookChapterFilter = MemoryChapter | "all";

export interface MemoryBookRouteState {
  section: MemoryBookSection;
  chapter: MemoryBookChapterFilter;
  displayMode: MemoryBookDisplayMode;
  query: string;
  importantOnly: boolean;
  sort: "newest" | "oldest";
  fromTime: string;
  toTime: string;
  animationsEnabled: boolean;
  cursors: Array<string | undefined>;
  pageIndex: number;
  scrollTop: number;
}

export const MEMORY_CHAPTER_META = {
  about_you: { label: "关于你", shortLabel: "你", description: "身份、经历与稳定背景" },
  preferences_habits: { label: "偏好与习惯", shortLabel: "习惯", description: "喜欢、讨厌与日常规律" },
  important_events: { label: "重要事件", shortLabel: "事件", description: "值得记住的时刻与变化" },
  relationships_goals: { label: "关系与目标", shortLabel: "目标", description: "重要的人、承诺与未来方向" }
} as const satisfies Record<MemoryChapter, { label: string; shortLabel: string; description: string }>;

export const MEMORY_ORIGIN_LABELS = {
  automatic: "自动整理",
  manual: "手动记录",
  imported: "导入"
} as const;

export function createMemoryBookRouteState(): MemoryBookRouteState {
  return {
    section: "cover",
    chapter: "all",
    displayMode: "book",
    query: "",
    importantOnly: false,
    sort: "newest",
    fromTime: "",
    toTime: "",
    animationsEnabled: true,
    cursors: [undefined],
    pageIndex: 0,
    scrollTop: 0
  };
}

export function resetMemoryBookPagination(
  state: MemoryBookRouteState,
  patch: Partial<MemoryBookRouteState>
): MemoryBookRouteState {
  return { ...state, ...patch, cursors: [undefined], pageIndex: 0 };
}

export function advanceMemoryBookPage(
  state: MemoryBookRouteState,
  nextCursor: string | undefined
): MemoryBookRouteState {
  if (!nextCursor) return state;
  const cursors = state.cursors.slice(0, state.pageIndex + 1);
  cursors.push(nextCursor);
  return { ...state, cursors, pageIndex: state.pageIndex + 1 };
}

export function getMemoryBookRestoreScrollTop(state: MemoryBookRouteState): number {
  return state.section === "reading" ? Math.max(0, state.scrollTop) : 0;
}

export function formatMemoryDate(value: string | undefined): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(date);
}

export function memoryErrorMessage(error: MemoryErrorDto): string {
  const prefix: Partial<Record<MemoryErrorDto["code"], string>> = {
    "ledger-corrupted": "记忆账本已损坏，程序没有覆盖原文件。",
    "index-dirty": "派生索引需要重建，账本内容仍可阅读和管理。",
    "invalid-config": "记忆整理服务尚未正确配置。",
    unavailable: "记忆服务当前不可用，账本内容仍保留在本机。",
    "storage-unavailable": "本机记忆存储暂时不可用。",
    conflict: "这条记忆已在别处更新，请刷新后重试。"
  };
  return `${prefix[error.code] ?? "记忆操作失败。"}${error.message ? ` ${error.message}` : ""}`;
}

export function getVisiblePageRecords(records: MemoryRecord[], displayMode: MemoryBookDisplayMode): MemoryRecord[] {
  return displayMode === "book" ? records.slice(0, 5) : records;
}
