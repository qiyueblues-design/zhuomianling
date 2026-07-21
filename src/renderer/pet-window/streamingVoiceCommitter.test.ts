import { describe, expect, it } from "vitest";
import { StreamingVoiceCommitter } from "./streamingVoiceCommitter";

describe("StreamingVoiceCommitter", () => {
  it("commits complete Chinese sentences once and keeps an unfinished tail", () => {
    const committer = new StreamingVoiceCommitter();

    expect(committer.append("第一句。第二")).toEqual(["第一句。"]);
    expect(committer.append("第一句。第二句！第三")).toEqual(["第二句！"]);
    expect(committer.append("第一句。第二句！第三句")).toEqual([]);
    expect(committer.finalize("第一句。第二句！第三句")).toEqual(["第三句"]);
    expect(committer.finalize("第一句。第二句！第三句")).toEqual([]);
  });

  it("waits one update to include closing punctuation with a sentence", () => {
    const committer = new StreamingVoiceCommitter();

    expect(committer.append("她说：“你好！")).toEqual([]);
    expect(committer.append("她说：“你好！”接下来")).toEqual(["她说：“你好！”"]);
    expect(committer.finalize()).toEqual(["接下来"]);
  });

  it("supports Japanese and English sentence endings without splitting decimals", () => {
    const committer = new StreamingVoiceCommitter();

    expect(committer.append("そうです。 Next sentence! Value is 1.5 units. More")).toEqual([
      "そうです。",
      "Next sentence!",
      "Value is 1.5 units."
    ]);
    expect(committer.finalize()).toEqual(["More"]);
  });

  it("keeps ASCII and CJK ellipses in one committed segment", () => {
    const committer = new StreamingVoiceCommitter();

    expect(committer.append("等等... 后面还有。 下一段…… 然后")).toEqual([
      "等等...",
      "后面还有。",
      "下一段……"
    ]);
    expect(committer.finalize()).toEqual(["然后"]);
  });

  it("uses a secondary boundary for a long clause", () => {
    const committer = new StreamingVoiceCommitter();
    const clause = `${"很长的内容".repeat(8)}，`;

    expect(committer.append(`${clause}后续`)).toEqual([clause]);
    expect(committer.finalize()).toEqual(["后续"]);
  });

  it("bounds a segment even when the model emits no punctuation", () => {
    const committer = new StreamingVoiceCommitter();
    const longText = "长".repeat(85);

    expect(committer.append(longText)).toEqual(["长".repeat(80)]);
    expect(committer.finalize()).toEqual(["长".repeat(5)]);
  });

  it("normalizes whitespace across chunks before comparing the cumulative prefix", () => {
    const committer = new StreamingVoiceCommitter();

    expect(committer.append("第一句。\n第二")).toEqual(["第一句。"]);
    expect(committer.append("第一句。 第二句！ 下一段")).toEqual(["第二句！"]);
    expect(committer.finalize()).toEqual(["下一段"]);
  });

  it("stops committing after a non-monotonic revision", () => {
    const committer = new StreamingVoiceCommitter();

    expect(committer.append("草稿第一句。 后续")).toEqual(["草稿第一句。"]);
    expect(committer.append("改写后的第一句。 后续")).toEqual([]);
    expect(committer.hasRevision()).toBe(true);
    expect(committer.finalize("改写后的第一句。 后续完成。")).toEqual([]);
  });
});
