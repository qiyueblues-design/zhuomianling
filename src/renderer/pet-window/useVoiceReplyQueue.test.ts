import { describe, expect, it } from "vitest";
import {
  createVoiceReplyAudioSafely,
  getUnqueuedFinalVoiceSegments,
  normalizeVoiceReplyText,
  shouldCompleteVoiceReply
} from "./useVoiceReplyQueue";

describe("voice reply final-text reconciliation", () => {
  it("turns malformed synthesis payload conversion into a retryable miss", () => {
    expect(
      createVoiceReplyAudioSafely(
        "invalid",
        "audio/wav",
        () => {
          throw new Error("invalid base64");
        },
        () => "unused"
      )
    ).toBeUndefined();

    expect(
      createVoiceReplyAudioSafely(
        "valid",
        "audio/wav",
        () => new Blob(),
        () => {
          throw new Error("object URL unavailable");
        }
      )
    ).toBeUndefined();
  });

  it("normalizes whitespace before comparing streamed and final text", () => {
    expect(normalizeVoiceReplyText("  第一段\n  第二段  ")).toBe("第一段 第二段");
  });

  it("queues every final segment when streaming produced no complete sentence", () => {
    expect(getUnqueuedFinalVoiceSegments("第一句。第二句！", [])).toEqual([
      "第一句。",
      "第二句！"
    ]);
  });

  it("only queues the final voiceText remainder after streamed sentences", () => {
    expect(
      getUnqueuedFinalVoiceSegments("第一句。 第二句！第三句？", ["第一句。", "第二句！"])
    ).toEqual(["第三句？"]);
  });

  it("deduplicates matching streamed segments when final formatting changed", () => {
    expect(
      getUnqueuedFinalVoiceSegments("开场。补充说明。结尾！", ["开场。", "结尾！"])
    ).toEqual(["补充说明。"]);
  });

  it("does not report playback drained before the AI reply is finalized", () => {
    expect(
      shouldCompleteVoiceReply({
        currentRequest: true,
        finalized: false,
        notified: false,
        playing: false,
        queuedItems: 0
      })
    ).toBe(false);
    expect(
      shouldCompleteVoiceReply({
        currentRequest: true,
        finalized: true,
        notified: false,
        playing: false,
        queuedItems: 0
      })
    ).toBe(true);
  });

  it("only reports completion once and never while audio remains", () => {
    expect(
      shouldCompleteVoiceReply({
        currentRequest: true,
        finalized: true,
        notified: false,
        playing: true,
        queuedItems: 0
      })
    ).toBe(false);
    expect(
      shouldCompleteVoiceReply({
        currentRequest: true,
        finalized: true,
        notified: true,
        playing: false,
        queuedItems: 0
      })
    ).toBe(false);
  });
});
