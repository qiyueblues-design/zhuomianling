import { describe, expect, it } from "vitest";
import type { PetExpressionMap } from "../../shared/types/pet";
import {
  inferExpressionFromAiReply,
  resolveMappedExpression
} from "./aiReplyUtils";

describe("AI expression consumption boundary", () => {
  const expressions = {
    normal: "normal-source",
    happy: "happy-source"
  } satisfies PetExpressionMap;

  it("accepts only an emotion key configured by the current pet", () => {
    expect(resolveMappedExpression("happy", expressions, "normal")).toBe("happy");
    expect(resolveMappedExpression("provider-invented-key", expressions, "happy")).toBe("happy");
  });

  it("falls back to neutral when neither the requested nor inferred key is mapped", () => {
    expect(resolveMappedExpression("panic", expressions, "crying")).toBe("normal");
  });

  it("infers only a generic fallback from the safe visible reply", () => {
    expect(inferExpressionFromAiReply("太好了，当然可以呀！")).toBe("happy");
    expect(inferExpressionFromAiReply("我们先分析一下步骤，然后继续。")).toBe("focus");
    expect(inferExpressionFromAiReply("普通回复")).toBe("normal");
  });
});
