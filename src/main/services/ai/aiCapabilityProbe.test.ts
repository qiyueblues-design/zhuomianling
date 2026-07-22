import { afterEach, describe, expect, it, vi } from "vitest";
import { probeAiOutputCapability } from "./aiCapabilityProbe";

function streamResponse(content: string): Response {
  const data = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(data, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function rejectedResponse(): Response {
  return new Response(JSON.stringify({ error: { message: "unsupported" } }), {
    status: 400,
    headers: { "Content-Type": "application/json" }
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "fixture failure" } }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI output capability probe", () => {
  it("selects streaming JSON Schema when the first probe succeeds", async () => {
    const fetchMock = vi.fn(async () => streamResponse('{"reply":"probe-ok","moodDelta":0}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret",
      checkedAt: "2026-07-15T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      tested: true,
      capability: {
        mode: "json-schema",
        protocolTier: "full",
        streaming: true,
        confidence: "tested"
      }
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.response_format.type).toBe("json_schema");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("falls back from schema to streaming JSON Object", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(streamResponse('{"reply":"probe-ok","moodDelta":0}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret"
    });

    expect(result.capability).toMatchObject({
      mode: "json-object",
      protocolTier: "full",
      streaming: true,
      confidence: "tested"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the full protocol through prompt JSON when response_format is unsupported", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(streamResponse('{"reply":"probe-ok","moodDelta":0}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret"
    });

    expect(result.capability).toMatchObject({
      mode: "prompt-json",
      protocolTier: "full",
      streaming: true,
      confidence: "tested",
      probeVersion: 2
    });
    const body = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(body).not.toHaveProperty("response_format");
    expect(body.messages[0].content).toContain("reply 和 moodDelta");
  });

  it("recognizes a non-streaming compatibility response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "probe-ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret"
    });

    expect(result.capability).toMatchObject({
      mode: "plain-text",
      protocolTier: "text",
      streaming: false,
      confidence: "tested"
    });
  });

  it("does not classify JSON missing moodDelta as the full desktop-pet protocol", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse('{"reply":"probe-ok"}'))
      .mockResolvedValueOnce(streamResponse('{"reply":"probe-ok"}'))
      .mockResolvedValueOnce(streamResponse('{"reply":"probe-ok"}'))
      .mockResolvedValueOnce(streamResponse("probe-ok"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret"
    });

    expect(result.capability).toMatchObject({
      mode: "plain-text",
      protocolTier: "text",
      confidence: "tested"
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not mistake a JSON envelope for literal plain-text compatibility", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.response_format
        ? rejectedResponse()
        : streamResponse('{"reply":"probe-ok"}');
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret"
    });

    expect(result).toMatchObject({ tested: false, failureKind: "invalid-response" });
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("retries without streaming when every streaming mode is rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(rejectedResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"reply":"probe-ok","moodDelta":0}' } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret"
    });

    expect(result.capability).toMatchObject({
      mode: "json-schema",
      protocolTier: "full",
      streaming: false,
      confidence: "tested"
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).stream).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)).stream).toBe(false);
  });

  it("returns a bounded compatibility fallback when probing cannot connect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret"
    });

    expect(result).toMatchObject({
      tested: false,
      failureKind: "network",
      capability: {
        mode: "plain-text",
        protocolTier: "text",
        streaming: true,
        confidence: "fallback"
      }
    });
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [429, "rate-limit"],
    [503, "server"]
  ] as const)("stops on non-compatibility HTTP %i without probing another format", async (status, failureKind) => {
    const fetchMock = vi.fn(async () => errorResponse(status));
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeAiOutputCapability({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "secret"
    });

    expect(result).toMatchObject({ tested: false, failureKind, status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
