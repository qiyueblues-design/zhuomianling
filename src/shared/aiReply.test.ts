import { describe, expect, it } from "vitest";
import { parseFinalAiReply } from "./aiReply";

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
});
