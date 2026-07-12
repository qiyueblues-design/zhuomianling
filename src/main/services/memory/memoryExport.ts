import type {
  MemoryExportOptions,
  MemoryExportResult,
  MemoryRecord,
  MemorySourceTurn
} from "../../../shared/types/memory";
import { MEMORY_CHAPTERS } from "../../../shared/types/memory";
import { assertMemoryRecord } from "../../../shared/validation/memory";

const chapterLabels = {
  about_you: "关于你",
  preferences_habits: "偏好习惯",
  important_events: "重要事件",
  relationships_goals: "关系与目标"
} as const;

export function createMemoryExportFileName(
  petName: string | undefined,
  petId: string,
  extension: "md" | "json"
): string {
  const sanitizedName = (petName ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  const isReservedWindowsName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(sanitizedName);
  const fileStem = sanitizedName && !isReservedWindowsName ? sanitizedName : petId;
  return `${fileStem}-memory.${extension}`;
}

export function exportMemorySnapshot(
  petId: string,
  records: MemoryRecord[],
  sourceTurns: MemorySourceTurn[],
  options: MemoryExportOptions
): MemoryExportResult {
  records.forEach((record) => {
    assertMemoryRecord(record);
    if (record.petId !== petId) throw new Error("Memory export crossed pet boundaries.");
  });
  const active = records.filter((record) => !record.deletedAt);

  if (options.format === "json") {
    const value = {
      schemaVersion: 1,
      petId,
      exportedAt: new Date().toISOString(),
      memories: active.map((record) => ({
        id: record.id,
        chapter: record.chapter,
        memoryType: record.memoryType,
        content: record.content,
        tags: record.tags,
        important: record.important,
        origin: record.origin,
        sourceTime: record.sourceTime,
        sourceAvailable: record.sourceAvailable,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        revision: record.revision
      })),
      ...(options.includeSources
        ? {
            sources: sourceTurns
              .filter((turn) => turn.petId === petId)
              .map(({ requestId, userText, assistantReply, occurredAt }) => ({
                requestId,
                userText,
                assistantReply,
                occurredAt
              }))
          }
        : {})
    };
    return {
      format: "json",
      content: `${JSON.stringify(value, null, 2)}\n`,
      recordCount: active.length
    };
  }

  const lines = ["# 桌面灵记忆导出", "", `宠物 ID：${petId}`, ""];
  for (const chapter of MEMORY_CHAPTERS) {
    lines.push(`## ${chapterLabels[chapter]}`, "");
    const chapterRecords = active.filter((record) => record.chapter === chapter);
    if (chapterRecords.length === 0) {
      lines.push("_暂无记忆_", "");
      continue;
    }
    for (const record of chapterRecords) {
      lines.push(`### ${record.important ? "★ " : ""}${record.updatedAt}`, "", record.content, "");
      if (record.tags.length) lines.push(`标签：${record.tags.join("、")}`, "");
      lines.push(`来源：${record.origin} · revision ${record.revision}`, "");
    }
  }
  if (options.includeSources) {
    lines.push("## 原始来源", "");
    for (const turn of sourceTurns.filter((item) => item.petId === petId)) {
      lines.push(`### ${turn.occurredAt}`, "", `用户：${turn.userText}`, "", `回复：${turn.assistantReply}`, "");
    }
  }
  return { format: "markdown", content: `${lines.join("\n").trimEnd()}\n`, recordCount: active.length };
}
