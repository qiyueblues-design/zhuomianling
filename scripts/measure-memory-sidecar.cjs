const path = require("node:path");
const { MemorySidecarClient } = require("../dist/main/services/memory/MemorySidecarClient.js");

async function main() {
  const executablePath = process.env.MEMORY_SIDECAR_PYTHON;
  if (!executablePath || !path.isAbsolute(executablePath)) {
    throw new Error("MEMORY_SIDECAR_PYTHON must be an absolute application-owned Python 3.13 path.");
  }
  const sidecarRoot = path.resolve(__dirname, "..", "sidecar", "memory");
  const client = new MemorySidecarClient({
    executablePath,
    sidecarRoot,
    startupTimeoutMs: 3_000,
    shutdownTimeoutMs: 2_000
  });
  const cycles = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const first = await client.request("health");
    const second = await client.request("health");
    const controller = new AbortController();
    const cancellationStartedAt = performance.now();
    const pending = client
      .request(
        "sleep",
        { delayMs: 4_000, value: "never" },
        { petId: "pet-a", deadlineMs: 5_000, signal: controller.signal }
      )
      .catch((error) => error);
    setTimeout(() => controller.abort(), 25);
    const cancellation = await pending;
    const cancellationMs = performance.now() - cancellationStartedAt;
    const metrics = client.getMetrics();
    await client.shutdown();
    let orphan = true;
    try {
      process.kill(first.pid, 0);
    } catch {
      orphan = false;
    }
    cycles.push({
      cycle: cycle + 1,
      pid: first.pid,
      rssBytes: first.rssBytes,
      coldStartMs: metrics.lastColdStartMs,
      warmRequestMs: metrics.lastWarmRequestMs,
      secondHealthSamePid: second.pid === first.pid,
      cancellationCode: cancellation.code,
      cancellationMs,
      orphanAfterShutdown: orphan
    });
  }
  process.stdout.write(`${JSON.stringify({ cycles }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Memory sidecar measurement failed.");
  process.exitCode = 1;
});
