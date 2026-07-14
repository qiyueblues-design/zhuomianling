import { describe, expect, it } from "vitest";
import {
  maxAiReplyInputCharacters,
  maxAiReplyTextCharacters
} from "../../../shared/aiReply";
import { AiStreamNormalizer } from "./aiStreamNormalizer";

describe("AiStreamNormalizer", () => {
  it("hides a reasoning tag split across arbitrary chunks", () => {
    const normalizer = new AiStreamNormalizer();

    expect(normalizer.append("<th")).toMatchObject({ changed: false, reply: "" });
    expect(normalizer.append("ink>不能显示")).toMatchObject({ changed: false, reply: "" });
    expect(normalizer.append("</thi")).toMatchObject({ changed: false, reply: "" });
    expect(normalizer.append('nk>\n{"reply":"你')).toMatchObject({
      changed: true,
      reply: "你",
      replyDelta: "你"
    });
    expect(normalizer.append('好","voiceText":"你好')).toMatchObject({
      changed: true,
      reply: "你好",
      replyDelta: "好",
      voiceText: "你好",
      voiceTextDelta: "你好"
    });
  });

  it("holds a split Markdown fence and never exposes the JSON envelope", () => {
    const normalizer = new AiStreamNormalizer();

    expect(normalizer.append("```jso")).toMatchObject({ changed: false, reply: "" });
    expect(normalizer.append('n\n{"emotion":"happy",')).toMatchObject({
      changed: false,
      reply: ""
    });
    expect(normalizer.append('"reply":"可见内容')).toMatchObject({
      changed: true,
      reply: "可见内容"
    });
  });

  it("passes ordinary text incrementally and never rewrites an emitted reply", () => {
    const plain = new AiStreamNormalizer();
    expect(plain.append("普通")).toMatchObject({ reply: "普通", replyDelta: "普通" });
    expect(plain.append("回复")).toMatchObject({ reply: "普通回复", replyDelta: "回复" });

    const repeated = new AiStreamNormalizer();
    repeated.append('{"reply":"草稿"}');
    expect(repeated.append('\n{"reply":"最终')).toMatchObject({
      reply: "草稿",
      replyDelta: undefined
    });
    repeated.append('回复","voiceText":"最终语音"}');
    const finalized = repeated.finalize();
    expect(finalized).toMatchObject({
      reply: "草稿",
      quality: "recovered",
      completeForMemory: false
    });
    expect(finalized).not.toHaveProperty("voiceText");
  });

  it("rejects input beyond the shared parser budget without retaining the extra chunk", () => {
    const normalizer = new AiStreamNormalizer();
    expect(normalizer.append("a".repeat(maxAiReplyTextCharacters))).toMatchObject({
      overflowed: false
    });
    expect(normalizer.append("b")).toMatchObject({
      overflowed: true,
      changed: false
    });

    const rawBudget = new AiStreamNormalizer();
    expect(rawBudget.append(`<think>${"x".repeat(maxAiReplyInputCharacters - 20)}`)).toMatchObject({
      overflowed: false,
      reply: ""
    });
    expect(rawBudget.append("overflowing-tail")).toMatchObject({ overflowed: true });
  });
});
