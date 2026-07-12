const readline = require("node:readline");

const tasks = new Map();
let configuredSecret = "";

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const ok = (result) => send({ id: request.id, ok: true, result });
  if (request.method === "handshake") {
    return ok({
      sidecarVersion: "0.1.0-fixture",
      protocolVersion: 1,
      pythonVersion: "3.13.7",
      memuVersion: null,
      schemaVersion: 1
    });
  }
  if (request.method === "health") {
    return ok({ status: "ready", pid: process.pid, rssBytes: process.memoryUsage().rss });
  }
  if (request.method === "configure") {
    configuredSecret = request.params.apiKey;
    return ok({
      configured: true,
      leakedInArgv: process.argv.some((value) => value.includes(configuredSecret)),
      leakedInEnv: Object.values(process.env).some((value) => String(value).includes(configuredSecret))
    });
  }
  if (request.method === "sleep" || request.method === "late") {
    const timer = setTimeout(() => {
      tasks.delete(request.id);
      ok({ petId: request.petId, value: request.params.value });
    }, request.params.delayMs);
    tasks.set(request.id, { timer, ignoreCancel: request.method === "late" });
    return;
  }
  if (request.method === "cancel") {
    const task = tasks.get(request.params.targetId);
    if (task && !task.ignoreCancel) {
      clearTimeout(task.timer);
      tasks.delete(request.params.targetId);
      send({
        id: request.params.targetId,
        ok: false,
        error: { code: "canceled", message: "Fixture canceled." }
      });
    }
    return ok({ canceled: Boolean(task), targetId: request.params.targetId });
  }
  if (request.method === "oversized") {
    return process.stdout.write(`${"x".repeat(70_000)}\n`);
  }
  if (request.method === "stderr") {
    process.stderr.write(`${request.params.value}\n`);
    return ok({ received: true });
  }
  if (request.method === "malformed") return process.stdout.write("not-json\n");
  if (request.method === "crash") return process.exit(70);
  if (request.method === "shutdown") {
    ok({ stopped: true });
    return setImmediate(() => process.exit(0));
  }
  send({ id: request.id, ok: false, error: { code: "unknown-method", message: "Unknown." } });
});
