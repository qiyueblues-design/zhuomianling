import { describe, expect, it } from "vitest";
import { parseFinalAiReply } from "./aiReply";

describe("parseFinalAiReply", () => {
  it("accepts complete structured and plain user-visible replies", () => {
    expect(parseFinalAiReply('{"reply":" hello ","emotion":"happy","voiceText":"hi"}')).toEqual({
      reply: "hello",
      emotion: "happy",
      voiceText: "hi",
      completeForMemory: true
    });
    expect(parseFinalAiReply(" plain reply ")).toEqual({
      reply: "plain reply",
      completeForMemory: true
    });
  });

  it("keeps renderer fallback text but rejects partial JSON for memory", () => {
    expect(parseFinalAiReply('{"reply":"visible fallback","emotion":"happy"')).toMatchObject({
      reply: "visible fallback",
      completeForMemory: false
    });
    expect(parseFinalAiReply('{"emotion":"happy"}')).toEqual({
      reply: '{"emotion":"happy"}',
      completeForMemory: false
    });
  });
});
