import { describe, expect, it } from "vitest";
import {
  advanceMemoryBookPage,
  createMemoryBookRouteState,
  formatMemoryDate,
  formatMemoryDateTime,
  getMemoryBookRequestPageSizes,
  getMemoryBookRestoreScrollTop,
  MEMORY_CHAPTER_META,
  memoryErrorMessage,
  resetMemoryBookPagination
} from "./memoryBookState";

describe("memory book route state", () => {
  it("formats source conversation timestamps with date and minute precision", () => {
    expect(formatMemoryDateTime("2026-07-14T10:05:00.000Z")).not.toBe("时间未知");
    expect(formatMemoryDateTime("invalid")).toBe("时间未知");
  });
  it("starts at a keyboard-openable cover with bounded first page", () => {
    expect(createMemoryBookRouteState()).toMatchObject({
      section: "cover",
      chapter: "all",
      displayMode: "book",
      cursors: [undefined],
      pageIndex: 0
    });
  });

  it("fills both paper pages without exceeding the five-record IPC limit", () => {
    expect(getMemoryBookRequestPageSizes("book", false)).toEqual([3, 3]);
    expect(getMemoryBookRequestPageSizes("book", true)).toEqual([3]);
    expect(getMemoryBookRequestPageSizes("list", false)).toEqual([5]);
  });

  it("keeps chapter descriptions aligned with the automatic organizer rules", () => {
    expect(MEMORY_CHAPTER_META.preferences_habits.description).toBe("偏好、习惯与稳定互动方式");
    expect(MEMORY_CHAPTER_META.important_events.description).toBe("共同经历、具体承诺与重要行动");
    expect(MEMORY_CHAPTER_META.relationships_goals.description).toBe("称呼、相处约定、边界与长期目标");
  });

  it("resets cursor history whenever filters change", () => {
    const initial = { ...createMemoryBookRouteState(), cursors: [undefined, "next"], pageIndex: 1 };
    expect(resetMemoryBookPagination(initial, { chapter: "important_events" })).toMatchObject({
      chapter: "important_events",
      cursors: [undefined],
      pageIndex: 0
    });
  });

  it("provides safe date and structured ledger error copy", () => {
    expect(formatMemoryDate("not-a-date")).toBe("时间未知");
    expect(memoryErrorMessage({ code: "ledger-corrupted", message: "backup available", retryable: false }))
      .toContain("没有覆盖原文件");
  });

  it("keeps bounded cursor history usable for more than 500 records", () => {
    let state = createMemoryBookRouteState();
    for (let page = 1; page <= 100; page += 1) {
      state = advanceMemoryBookPage(state, `cursor-${page}`);
    }
    expect(state.pageIndex).toBe(100);
    expect(state.cursors).toHaveLength(101);
    expect(state.cursors[100]).toBe("cursor-100");
  });

  it("never restores a scrolled cover that can hide the return navigation", () => {
    const cover = { ...createMemoryBookRouteState(), scrollTop: 480 };
    expect(getMemoryBookRestoreScrollTop(cover)).toBe(0);
    expect(getMemoryBookRestoreScrollTop({ ...cover, section: "reading" })).toBe(480);
  });
});
