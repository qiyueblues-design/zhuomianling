import { describe, expect, it } from "vitest";
import {
  buildAiReplyJsonSchema,
  createAiReplyContract,
  getAiProtocolTierForMode
} from "./aiContract";

describe("AI reply contract", () => {
  it("builds the minimal full desktop-pet protocol", () => {
    const contract = createAiReplyContract({ tier: "full" });
    expect(contract.requiredFields).toEqual(["reply", "moodDelta"]);
    expect(buildAiReplyJsonSchema(contract)).toMatchObject({
      type: "object",
      properties: {
        reply: { type: "string" },
        moodDelta: { type: "integer", minimum: -12, maximum: 12 }
      },
      required: ["reply", "moodDelta"],
      additionalProperties: false
    });
  });

  it("adds only the enabled voice and semantic expression fields", () => {
    const contract = createAiReplyContract({
      tier: "full",
      voiceTextRequired: true,
      emotionKeys: ["happy", "normal", "happy", " "]
    });
    expect(contract.requiredFields).toEqual(["voiceText", "reply", "moodDelta", "emotion"]);
    expect(buildAiReplyJsonSchema(contract)).toMatchObject({
      properties: {
        voiceText: { type: "string" },
        emotion: { type: "string", enum: ["happy", "normal"] }
      }
    });
    expect(Object.keys(
      (buildAiReplyJsonSchema(contract)?.properties ?? {}) as Record<string, unknown>
    )).toEqual(["voiceText", "reply", "moodDelta", "emotion"]);
  });

  it("reduces text compatibility to a visible reply only", () => {
    const contract = createAiReplyContract({
      tier: "text",
      voiceTextRequired: true,
      emotionKeys: ["happy"]
    });
    expect(contract).toMatchObject({
      tier: "text",
      requiredFields: ["reply"],
      allowedFields: ["reply"],
      voiceTextRequired: false,
      emotionRequired: false
    });
    expect(buildAiReplyJsonSchema(contract)).toBeUndefined();
    expect(getAiProtocolTierForMode("plain-text")).toBe("text");
    expect(getAiProtocolTierForMode("json-object")).toBe("full");
    expect(getAiProtocolTierForMode("prompt-json")).toBe("full");
  });
});
