import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemuMemoryBackend } from "./MemuMemoryBackend";
import { MemoryIndexCoordinator } from "./MemoryIndexCoordinator";
import { MemoryLedger } from "./MemoryLedger";
import { MemorySidecarClient } from "./MemorySidecarClient";

const pythonPath = process.env.MEMORY_SIDECAR_PYTHON;
const memuRoot = process.env.MEMORY_SIDECAR_MEMU_ROOT;
const sidecarRoot = path.resolve(__dirname, "../../../../sidecar/memory");

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-memu-test-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe.skipIf(!pythonPath || !memuRoot)("real memU 1.5.1 derived index", () => {
  it("normalizes through the configured provider without mutating the derived index", async () => {
    const requests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        });
        const content = JSON.stringify({
          memories: [{
            chapter: "preferences_habits",
            memoryType: "behavior",
            content: "用户喜欢雨天散步",
            tags: ["散步"]
          }]
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Provider fixture did not bind a TCP port.");
    const client = new MemorySidecarClient({
      executablePath: pythonPath!,
      sidecarRoot,
      dependencyRoots: [memuRoot!],
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 5_000
    });
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const backend = new MemuMemoryBackend({ client, indexDirectoryForPet });
    const signal = new AbortController().signal;
    try {
      await backend.configureNormalizationProvider({
        petId: "pet-a",
        profileId: "provider-a",
        apiKey: "provider-secret",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        chatModel: "normalizer"
      }, signal);
      await backend.testNormalizationProvider("pet-a", signal);
      const result = await backend.memorize({
        petId: "pet-a",
        requestId: "request-normalize",
        userText: "我喜欢雨天散步",
        assistantReply: "我记住了",
        occurredAt: "2026-07-13T00:00:00.000Z",
        retainSource: false
      }, signal);

      expect(result.entries).toEqual([
        expect.objectContaining({
          petId: "pet-a",
          chapter: "preferences_habits",
          memoryType: "behavior",
          content: "用户喜欢雨天散步",
          origin: "automatic"
        })
      ]);
      expect(JSON.stringify(result)).not.toContain("provider-secret");
      expect(requests).toHaveLength(2);
      expect(requests[0]?.authorization).toBe("Bearer provider-secret");
      expect(requests[1]?.authorization).toBe("Bearer provider-secret");
      const normalizeMessages = requests[1]?.body.messages as Array<{ role: string; content: string }>;
      expect(normalizeMessages[0]?.content).toContain("userText 的主要自然语言");
      expect(normalizeMessages[0]?.content).toContain("必须使用自然的简体中文");
      await expect(fs.readdir(path.join(indexDirectoryForPet("pet-a"), "current", "resources"))).resolves.toEqual([]);
    } finally {
      await backend.close(new AbortController().signal).catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("keeps pets isolated and rebuilds a deleted current index from ledger authority", async () => {
    const client = new MemorySidecarClient({
      executablePath: pythonPath!,
      sidecarRoot,
      dependencyRoots: [memuRoot!],
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 5_000
    });
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const backend = new MemuMemoryBackend({ client, indexDirectoryForPet });
    const coordinator = new MemoryIndexCoordinator({
      backend,
      indexDirectoryForPet,
      modelFingerprint: backend.modelFingerprint
    });
    const petA = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    const petB = await MemoryLedger.open("pet-b", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-b", "memory")
    });
    const signal = new AbortController().signal;
    try {
      for (let index = 0; index < 8; index += 1) {
        await petA.create({
          petId: "pet-a",
          chapter: "preferences_habits",
          memoryType: "behavior",
          content: `alpha jasmine tea preference ${index}`,
          tags: ["alpha"]
        });
        await petB.create({
          petId: "pet-b",
          chapter: "preferences_habits",
          memoryType: "behavior",
          content: `beta coffee preference ${index}`,
          tags: ["beta"]
        });
      }

      const initial = await Promise.all([
        coordinator.synchronize(petA, signal),
        coordinator.synchronize(petB, signal)
      ]);
      expect(initial).toEqual([
        { rebuilt: true, appliedCount: 8 },
        { rebuilt: true, appliedCount: 8 }
      ]);

      const [alpha, beta] = await Promise.all([
        backend.retrieve({ petId: "pet-a", query: "alpha jasmine tea", limit: 10, contextBudgetChars: 2_048 }, signal),
        backend.retrieve({ petId: "pet-b", query: "beta coffee", limit: 10, contextBudgetChars: 2_048 }, signal)
      ]);
      expect(alpha.items).toHaveLength(8);
      expect(beta.items).toHaveLength(8);
      expect(alpha.items.every(({ memory }) => memory.petId === "pet-a")).toBe(true);
      expect(beta.items.every(({ memory }) => memory.petId === "pet-b")).toBe(true);
      expect(JSON.stringify({ alpha, beta })).not.toMatch(/embedding|indexPath|resource_id|local_path/);

      const expectedIds = petA.snapshot().map(({ id }) => id).sort();
      await backend.closePet("pet-a", signal);
      await fs.rm(path.join(indexDirectoryForPet("pet-a"), "current"), { recursive: true });
      const rebuilt = await coordinator.synchronize(petA, signal);
      expect(rebuilt).toEqual({ rebuilt: true, appliedCount: 8 });
      const after = await backend.retrieve(
        { petId: "pet-a", query: "alpha jasmine tea", limit: 10, contextBudgetChars: 2_048 },
        signal
      );
      expect(after.items.map(({ memory }) => memory.id).sort()).toEqual(expectedIds);
      expect(petA.getIndexMetadata()).toMatchObject({
        dirty: false,
        modelFingerprint: backend.modelFingerprint
      });
    } finally {
      petA.close();
      petB.close();
      await backend.close(new AbortController().signal).catch(() => undefined);
    }
  }, 60_000);
});
