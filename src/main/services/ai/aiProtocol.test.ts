import { describe, expect, it } from "vitest";
import {
  buildAiChatRequestBody,
  buildAiResponseFormat,
  getAiOutputModeFallbacks
} from "./aiProtocol";
import { createAiReplyContract } from "../../../shared/aiContract";

describe("AI protocol output modes", () => {
  it("builds schema, JSON object, and compatibility request bodies", () => {
    expect(buildAiResponseFormat("json-schema")).toMatchObject({
      type: "json_schema",
      json_schema: {
        strict: true,
        schema: {
          required: ["reply", "moodDelta"],
          properties: {
            moodDelta: { type: "integer", minimum: -12, maximum: 12 }
          }
        }
      }
    });
    expect(buildAiResponseFormat("json-object")).toEqual({ type: "json_object" });
    expect(buildAiResponseFormat("prompt-json")).toBeUndefined();
    expect(buildAiResponseFormat("plain-text")).toBeUndefined();

    const plainBody = buildAiChatRequestBody({
      model: "model-a",
      messages: [{ role: "user", content: "hello" }],
      mode: "plain-text",
      stream: true
    });
    expect(plainBody).not.toHaveProperty("response_format");
    expect(plainBody).toMatchObject({ model: "model-a", stream: true });

    const dynamic = buildAiResponseFormat("json-schema", createAiReplyContract({
      tier: "full",
      voiceTextRequired: true,
      emotionKeys: ["normal", "happy"]
    }));
    expect(dynamic).toMatchObject({
      json_schema: {
        schema: {
          required: ["voiceText", "reply", "moodDelta", "emotion"],
          properties: { emotion: { enum: ["normal", "happy"] } }
        }
      }
    });
  });

  it("defines a strictly decreasing compatibility fallback order", () => {
    expect(getAiOutputModeFallbacks("json-schema")).toEqual([
      "json-schema",
      "json-object",
      "prompt-json",
      "plain-text"
    ]);
    expect(getAiOutputModeFallbacks("json-object")).toEqual(["json-object", "prompt-json", "plain-text"]);
    expect(getAiOutputModeFallbacks("prompt-json")).toEqual(["prompt-json", "plain-text"]);
    expect(getAiOutputModeFallbacks("plain-text")).toEqual(["plain-text"]);
  });

  it("rejects a text-tier contract paired with a structured output mode", () => {
    expect(() => buildAiResponseFormat(
      "json-object",
      createAiReplyContract({ tier: "text" })
    )).toThrow(/full desktop-pet protocol/);
  });
});
