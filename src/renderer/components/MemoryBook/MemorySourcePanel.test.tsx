import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemorySourcePanel } from "./MemorySourcePanel";

describe("MemorySourcePanel", () => {
  it("renders the retained turn as distinct user and pet chat bubbles", () => {
    const markup = renderToStaticMarkup(
      <MemorySourcePanel
        petName="若叶睦"
        source={{
          userText: "我喜欢喝咖啡",
          assistantReply: "咖啡很苦，不过我记住了。",
          occurredAt: "2026-07-14T11:40:00.000Z",
          organizedAt: "2026-07-14T11:40:02.000Z"
        }}
        loading={false}
        memoryWasEdited={false}
        onRetry={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(markup).toContain('aria-label="你当时说"');
    expect(markup).toContain('aria-label="若叶睦 当时回复"');
    expect(markup.match(/memorySourceBubble/g)).toHaveLength(2);
    expect(markup).not.toContain(">最终回复<");
  });
});
