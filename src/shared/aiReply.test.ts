import { describe, expect, it } from "vitest";
import { parseFinalAiReply } from "./aiReply";
import { createAiReplyContract } from "./aiContract";

describe("parseFinalAiReply", () => {
  it("accepts complete structured and plain user-visible replies", () => {
    expect(parseFinalAiReply('{"reply":" hello ","emotion":"happy","voiceText":"hi"}')).toEqual({
      reply: "hello",
      emotion: "happy",
      voiceText: "hi",
      quality: "structured",
      completeForMemory: true
    });
    expect(parseFinalAiReply(" plain reply ")).toEqual({
      reply: "plain reply",
      quality: "plain-text",
      completeForMemory: true
    });
  });

  it("keeps renderer fallback text but rejects partial JSON for memory", () => {
    expect(parseFinalAiReply('{"reply":"visible fallback","emotion":"happy"')).toMatchObject({
      reply: "visible fallback",
      quality: "recovered",
      completeForMemory: false
    });
    expect(parseFinalAiReply('{"emotion":"happy"}')).toEqual({
      reply: "",
      quality: "invalid",
      completeForMemory: false
    });
  });

  it("removes reasoning and Markdown wrappers before parsing", () => {
    expect(
      parseFinalAiReply(
        '<think>内部推理不能展示</think>\n```json\n{"reply":"可以看到","emotion":"normal"}\n```'
      )
    ).toMatchObject({
      reply: "可以看到",
      emotion: "normal",
      quality: "structured",
      completeForMemory: true
    });
    expect(parseFinalAiReply("<analysis>内部内容</analysis>\n最终回答")).toEqual({
      reply: "最终回答",
      quality: "plain-text",
      completeForMemory: true
    });
  });

  it("selects the last complete valid reply from repeated JSON", () => {
    expect(
      parseFinalAiReply(
        '准备回答：\n{"reply":"第一次回复"}\n{"reply":"最终回复","voiceText":"最终语音"}'
      )
    ).toMatchObject({
      reply: "最终回复",
      voiceText: "最终语音",
      quality: "structured",
      completeForMemory: true
    });
  });

  it("handles braces and escaped quotes inside structured strings", () => {
    expect(
      parseFinalAiReply('{"reply":"这是 {内容}，并且说\\"你好\\"","emotion":"happy"}')
    ).toMatchObject({
      reply: '这是 {内容}，并且说"你好"',
      emotion: "happy",
      quality: "structured"
    });
  });

  it("keeps moodDelta internal only when it is a finite integer", () => {
    expect(parseFinalAiReply('{"reply":"完成","moodDelta":12}')).toMatchObject({
      reply: "完成", moodDelta: 12, quality: "structured"
    });
    expect(parseFinalAiReply('{"reply":"完成","moodDelta":1.5}')).not.toHaveProperty("moodDelta");
    expect(parseFinalAiReply('{"reply":"完成","moodDelta":"8"}')).not.toHaveProperty("moodDelta");
  });

  it("never exposes unclosed reasoning, invalid structured output, or oversized input", () => {
    expect(parseFinalAiReply("<think>尚未完成的内部推理")).toEqual({
      reply: "",
      quality: "invalid",
      completeForMemory: false
    });
    expect(parseFinalAiReply('{"reply":123,"emotion":"happy"}')).toEqual({
      reply: "",
      quality: "invalid",
      completeForMemory: false
    });
    expect(parseFinalAiReply('{"unexpected":"JSON must not leak"}')).toEqual({
      reply: "",
      quality: "invalid",
      completeForMemory: false
    });
    expect(parseFinalAiReply("a".repeat(128 * 1024 + 1))).toEqual({
      reply: "",
      quality: "invalid",
      completeForMemory: false
    });
  });

  it("enforces the active full protocol without discarding a safe visible reply", () => {
    const contract = createAiReplyContract({
      tier: "full",
      voiceTextRequired: true,
      emotionKeys: ["normal", "happy"]
    });
    expect(parseFinalAiReply(
      '{"reply":"完成","moodDelta":2,"voiceText":"done","emotion":"happy"}',
      contract
    )).toMatchObject({ quality: "structured", moodDelta: 2, completeForMemory: true });
    expect(parseFinalAiReply('{"reply":"缺字段","moodDelta":2}', contract)).toEqual({
      reply: "缺字段",
      quality: "recovered",
      completeForMemory: false
    });
    expect(parseFinalAiReply("普通文字", contract)).toEqual({
      reply: "普通文字",
      quality: "recovered",
      completeForMemory: false
    });
  });

  it("treats all reasoning-safe provider content literally in text compatibility mode", () => {
    const contract = createAiReplyContract({ tier: "text" });
    expect(parseFinalAiReply('{"reply":"可见","moodDelta":8,"emotion":"happy"}', contract)).toEqual({
      reply: '{"reply":"可见","moodDelta":8,"emotion":"happy"}',
      quality: "plain-text",
      completeForMemory: true
    });
    expect(parseFinalAiReply('{"example":true}', contract)).toEqual({
      reply: '{"example":true}',
      quality: "plain-text",
      completeForMemory: true
    });
    expect(parseFinalAiReply("```json\n{\"example\":true}\n```", contract)).toEqual({
      reply: "```json\n{\"example\":true}\n```",
      quality: "plain-text",
      completeForMemory: true
    });
  });
});
