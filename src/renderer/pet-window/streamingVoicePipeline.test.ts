import { describe, expect, it } from "vitest";
import { AiStreamNormalizer } from "../../main/services/ai/aiStreamNormalizer";
import { StreamingVoiceCommitter } from "./streamingVoiceCommitter";

function appendSafeReply(
  normalizer: AiStreamNormalizer,
  committer: StreamingVoiceCommitter,
  rawDelta: string
): string[] {
  const snapshot = normalizer.append(rawDelta);
  expect(snapshot.overflowed).toBe(false);
  return committer.append(snapshot.reply);
}

describe("safe streaming voice pipeline", () => {
  it("commits a structured reply sentence before the provider stream is finalized", () => {
    const normalizer = new AiStreamNormalizer();
    const committer = new StreamingVoiceCommitter();

    expect(appendSafeReply(normalizer, committer, '<think>不能朗读</think>\n```json\n{"reply":"第一句。')).toEqual([]);
    const beforeDone = appendSafeReply(
      normalizer,
      committer,
      '第二句仍在生成","emotion":"normal"}'
    );

    expect(beforeDone).toEqual(["第一句。"]);
    expect(beforeDone.join("")).not.toMatch(/think|reply|emotion|```|不能朗读/);
    expect(normalizer.finalize()).toMatchObject({ reply: "第一句。第二句仍在生成" });
    expect(committer.finalize(normalizer.finalize().reply)).toEqual(["第二句仍在生成"]);
  });

  it("can commit a separate normalized voiceText field before done", () => {
    const normalizer = new AiStreamNormalizer();
    const committer = new StreamingVoiceCommitter();

    let snapshot = normalizer.append('{"reply":"聊天正文。","voiceText":"Voice sentence.');
    expect(committer.append(snapshot.voiceText ?? "")).toEqual([]);

    snapshot = normalizer.append(' More voice is coming","emotion":"normal"}');
    expect(committer.append(snapshot.voiceText ?? "")).toEqual(["Voice sentence."]);
    expect(committer.finalize(normalizer.finalize().voiceText)).toEqual([
      "More voice is coming"
    ]);
  });

  it("streams plain text incrementally and flushes an unpunctuated final tail", () => {
    const normalizer = new AiStreamNormalizer();
    const committer = new StreamingVoiceCommitter();

    expect(appendSafeReply(normalizer, committer, "普通第一句。后半")).toEqual([
      "普通第一句。"
    ]);
    expect(appendSafeReply(normalizer, committer, "句没有标点")).toEqual([]);
    expect(committer.finalize(normalizer.finalize().reply)).toEqual(["后半句没有标点"]);
  });

  it("never speaks a later repeated JSON candidate after the visible stream freezes", () => {
    const normalizer = new AiStreamNormalizer();
    const committer = new StreamingVoiceCommitter();

    expect(appendSafeReply(normalizer, committer, '{"reply":"草稿句。 后续')).toEqual([
      "草稿句。"
    ]);
    expect(
      appendSafeReply(normalizer, committer, '内容"}\n{"reply":"不应切换到最终句。"}')
    ).toEqual([]);

    const finalized = normalizer.finalize();
    expect(finalized).toMatchObject({ reply: "草稿句。 后续", quality: "recovered" });
    expect(committer.finalize(finalized.reply)).toEqual(["后续"]);
  });
});
