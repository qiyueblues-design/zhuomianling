import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemorySidecarClient } from "./MemorySidecarClient";

const pythonPath = process.env.MEMORY_SIDECAR_PYTHON;
const sidecarRoot = path.resolve(__dirname, "../../../../sidecar/memory");
const fakePythonSidecar = path.join(sidecarRoot, "tests", "fixtures", "fake_protocol_sidecar.py");

describe.skipIf(!pythonPath)("Python 3.13 memory sidecar integration", () => {
  it("handshakes, reports RSS, cancels real work, and exits cleanly", async () => {
    const client = new MemorySidecarClient({
      executablePath: pythonPath!,
      sidecarRoot,
      startupTimeoutMs: 3_000,
      shutdownTimeoutMs: 2_000
    });
    try {
      const handshake = await client.ensureStarted();
      const health = await client.request<{ pid: number; rssBytes: number; status: string }>("health");
      const controller = new AbortController();
      const pending = client.request(
        "sleep",
        { delayMs: 4_000, value: "never" },
        { petId: "pet-a", deadlineMs: 5_000, signal: controller.signal }
      );
      setTimeout(() => controller.abort(), 25);

      await expect(pending).rejects.toMatchObject({ code: "canceled" });
      expect(handshake.pythonVersion).toMatch(/^3\.13\./);
      expect(health).toMatchObject({ status: "ready", pid: expect.any(Number) });
      expect(health.rssBytes).toBeGreaterThan(0);
      await expect(client.request("crash", {}, { deadlineMs: 1_000 })).rejects.toMatchObject({
        code: "unavailable"
      });
      await expect(client.request("health")).rejects.toMatchObject({ code: "unavailable" });
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const recovered = await client.request<{ pid: number; status: string }>("health");
      expect(recovered.status).toBe("ready");
      expect(recovered.pid).not.toBe(health.pid);
    } finally {
      await client.shutdown();
    }
  });

  it.each(["malformed", "oversized"])(
    "rejects %s output from a fake Python sidecar and restarts cleanly",
    async (method) => {
      const client = new MemorySidecarClient({
        executablePath: pythonPath!,
        sidecarRoot,
        testCommandArguments: ["-u", fakePythonSidecar],
        startupTimeoutMs: 3_000,
        shutdownTimeoutMs: 2_000
      });
      try {
        await expect(client.request(method, {}, { deadlineMs: 1_000 })).rejects.toMatchObject({
          code: "invalid-response"
        });
        await expect(client.request("health")).rejects.toMatchObject({ code: "unavailable" });
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        await expect(client.request("health")).resolves.toMatchObject({ status: "ready" });
      } finally {
        await client.shutdown();
      }
    }
  );
});
