import { describe, expect, it } from "vitest";
import {
  advanceMemoryBookPage,
  createMemoryBookRouteState,
  formatMemoryDate,
  getMemoryBookRestoreScrollTop,
  memoryErrorMessage,
  resetMemoryBookPagination
} from "./memoryBookState";

describe("memory book route state", () => {
  it("starts at a keyboard-openable cover with bounded first page", () => {
    expect(createMemoryBookRouteState()).toMatchObject({
      section: "cover",
      chapter: "all",
      displayMode: "book",
      cursors: [undefined],
      pageIndex: 0
    });
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
