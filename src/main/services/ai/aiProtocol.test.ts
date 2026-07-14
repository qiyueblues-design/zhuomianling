import { describe, expect, it } from "vitest";
import {
  buildAiChatRequestBody,
  buildAiResponseFormat,
  getAiOutputModeFallbacks
} from "./aiProtocol";

describe("AI protocol output modes", () => {
  it("builds schema, JSON object, and compatibility request bodies", () => {
    expect(buildAiResponseFormat("json-schema")).toMatchObject({ type: "json_schema" });
    expect(buildAiResponseFormat("json-object")).toEqual({ type: "json_object" });
    expect(buildAiResponseFormat("plain-text")).toBeUndefined();

    const plainBody = buildAiChatRequestBody({
      model: "model-a",
      messages: [{ role: "user", content: "hello" }],
      mode: "plain-text",
      stream: true
    });
    expect(plainBody).not.toHaveProperty("response_format");
    expect(plainBody).toMatchObject({ model: "model-a", stream: true });
  });

  it("defines a strictly decreasing compatibility fallback order", () => {
    expect(getAiOutputModeFallbacks("json-schema")).toEqual([
      "json-schema",
      "json-object",
      "plain-text"
    ]);
    expect(getAiOutputModeFallbacks("json-object")).toEqual(["json-object", "plain-text"]);
    expect(getAiOutputModeFallbacks("plain-text")).toEqual(["plain-text"]);
  });
});
