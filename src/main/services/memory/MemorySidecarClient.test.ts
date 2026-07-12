import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySidecarClient } from "./MemorySidecarClient";
import { shutdownAllMemorySidecars } from "./memorySidecarRuntime";

const fixturePath = path.resolve(__dirname, "fixtures", "fakeMemorySidecar.cjs");
const sidecarRoot = path.resolve(__dirname, "../../../..");
const clients: MemorySidecarClient[] = [];

function createClient(onDiagnostic?: (event: { kind: "stderr" | "protocol" | "exit"; bytes?: number }) => void) {
  const client = new MemorySidecarClient({
    executablePath: process.execPath,
    sidecarRoot,
    testCommandArguments: [fixturePath],
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
    onDiagnostic
  });
  clients.push(client);
  return client;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()));
});

describe("MemorySidecarClient lifecycle", () => {
  it("deduplicates cold start and records cold/warm health metrics", async () => {
    const client = createClient();
    const [first, second] = await Promise.all([client.ensureStarted(), client.ensureStarted()]);
    const health = await client.request<{ status: string; pid: number; rssBytes: number }>("health");

    expect(first).toEqual(second);
    expect(first.pythonVersion).toBe("3.13.7");
    expect(health).toMatchObject({ status: "ready", pid: expect.any(Number) });
    expect(health.rssBytes).toBeGreaterThan(0);
    expect(client.getMetrics()).toMatchObject({
      startCount: 1,
      lastColdStartMs: expect.any(Number),
      lastWarmRequestMs: expect.any(Number)
    });
  });

  it("passes secrets only in stdin and never exposes raw stderr diagnostics", async () => {
    const diagnostics: Array<{ kind: string; bytes?: number }> = [];
    const client = createClient((event) => diagnostics.push(event));
    const secret = "fixture-sidecar-secret-never-metadata";
    const configured = await client.request<{
      configured: boolean;
      leakedInArgv: boolean;
      leakedInEnv: boolean;
    }>("configure", { profileId: "fixture", apiKey: secret });
    await client.request("stderr", { value: secret });

    expect(configured).toEqual({ configured: true, leakedInArgv: false, leakedInEnv: false });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(diagnostics).toContainEqual({ kind: "stderr", bytes: Buffer.byteLength(`${secret}\n`) });
  });

  it("propagates AbortSignal cancellation and remains usable", async () => {
    const client = createClient();
    const controller = new AbortController();
    const startedAt = performance.now();
    const pending = client.request(
      "sleep",
      { delayMs: 4_000, value: "never" },
      { petId: "pet-a", deadlineMs: 5_000, signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 25);

    await expect(pending).rejects.toMatchObject({ code: "canceled" });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await expect(client.request("health")).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects invalid pet IDs and cyclic payloads before starting a process", async () => {
    const client = createClient();
    await expect(client.request("health", {}, { petId: "../pet" })).rejects.toMatchObject({
      code: "internal"
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(client.request("health", cyclic)).rejects.toMatchObject({ code: "internal" });
    expect(client.getMetrics().startCount).toBe(0);
  });

  it("times out, sends cancel, and discards a deliberately late response", async () => {
    const client = createClient();
    await expect(
      client.request(
        "late",
        { delayMs: 100, value: "late-value" },
        { petId: "pet-a", deadlineMs: 20 }
      )
    ).rejects.toMatchObject({ code: "timeout" });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await expect(client.request("health")).resolves.toMatchObject({ status: "ready" });
    expect(client.getMetrics().startCount).toBe(1);
  });

  it("degrades on a crash and starts a fresh process for the next request", async () => {
    const client = createClient();
    const firstHealth = await client.request<{ pid: number }>("health");
    await expect(client.request("crash", {}, { deadlineMs: 1_000 })).rejects.toMatchObject({
      code: "unavailable"
    });
    const secondHealth = await client.request<{ pid: number }>("health");

    expect(secondHealth.pid).not.toBe(firstHealth.pid);
    expect(client.getMetrics().startCount).toBe(2);
  });

  it.each(["malformed", "oversized"])(
    "kills a sidecar that emits %s output and recovers on the next call",
    async (method) => {
      const diagnostics: Array<{ kind: string }> = [];
      const client = createClient((event) => diagnostics.push(event));
      await expect(client.request(method, {}, { deadlineMs: 1_000 })).rejects.toMatchObject({
        code: "invalid-response"
      });
      await expect(client.request("health")).resolves.toMatchObject({ status: "ready" });
      expect(diagnostics).toContainEqual({ kind: "protocol" });
      expect(client.getMetrics().startCount).toBe(2);
    }
  );

  it("performs repeatable graceful shutdown without orphan processes", async () => {
    const client = createClient();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const health = await client.request<{ pid: number }>("health");
      const shutdownA = client.shutdown();
      const shutdownB = client.shutdown();
      expect(shutdownA).toBe(shutdownB);
      await shutdownA;
      expect(isPidRunning(health.pid)).toBe(false);
    }
    expect(client.getMetrics().startCount).toBe(3);
  });

  it("app-wide cleanup stops every sidecar started by the application", async () => {
    const first = createClient();
    const second = createClient();
    const [firstHealth, secondHealth] = await Promise.all([
      first.request<{ pid: number }>("health"),
      second.request<{ pid: number }>("health")
    ]);

    await shutdownAllMemorySidecars();

    expect(isPidRunning(firstHealth.pid)).toBe(false);
    expect(isPidRunning(secondHealth.pid)).toBe(false);
  });
});
