from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import math
import os
import sqlite3
import statistics
import tempfile
import time
import unittest
from pathlib import Path


RUNTIME_AVAILABLE = all(
    importlib.util.find_spec(module) is not None
    for module in ("memu", "numpy", "onnxruntime", "tokenizers")
)
MODEL_ROOT = os.environ.get("DESKTOP_PET_MEMORY_MODEL_ROOT")

if RUNTIME_AVAILABLE:
    from desktop_pet_memory_sidecar.embedding_runtime import (
        BgeEmbeddingRuntime,
        EMBEDDING_BLOB_BYTES,
    )
    from desktop_pet_memory_sidecar.memu_backend import MemuPetIndex


def _record(memory: dict[str, object]) -> dict[str, object]:
    return {
        "petId": "pet-a",
        "chapter": "preferences_habits",
        "memoryType": "behavior",
        "important": False,
        "origin": "manual",
        "sourceAvailable": False,
        "createdAt": "2026-07-13T00:00:00.000Z",
        "updatedAt": "2026-07-13T00:00:00.000Z",
        "revision": 1,
        **memory,
    }


def _legacy_hash_embedding(text: str) -> list[float]:
    vector = [0.0] * 64
    tokens = [token for token in text.casefold().split() if token] or [text.casefold()]
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:4], "big") % len(vector)
        vector[bucket] += -1.0 if digest[4] & 1 else 1.0
    magnitude = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / magnitude for value in vector]


@unittest.skipUnless(RUNTIME_AVAILABLE and MODEL_ROOT, "local BGE development runtime is unavailable")
class BgeEmbeddingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = BgeEmbeddingRuntime(Path(MODEL_ROOT).resolve())

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_lazy_runtime_returns_finite_normalized_semantic_vectors(self):
        self.assertFalse(self.runtime.loaded)
        vectors = await self.runtime.embed([
            "用户喜欢喝咖啡",
            "你还记得我喜欢喝什么吗",
            "用户养了一只猫",
        ])
        self.assertTrue(self.runtime.loaded)
        self.assertTrue(all(len(vector) == 512 for vector in vectors))
        self.assertTrue(all(math.isfinite(value) for vector in vectors for value in vector))
        for vector in vectors:
            self.assertAlmostEqual(math.sqrt(sum(value * value for value in vector)), 1.0, places=5)
        similarity = lambda left, right: sum(a * b for a, b in zip(left, right, strict=True))
        self.assertGreater(similarity(vectors[0], vectors[1]), similarity(vectors[2], vectors[1]) + 0.15)

    async def test_chinese_hybrid_recall_eval_and_compact_blob_storage(self):
        fixture_path = Path(__file__).parent / "fixtures" / "chinese_recall_cases.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        index_path = self.root / "pet-a" / "index" / "current"
        index_path.mkdir(parents=True)
        index = MemuPetIndex("pet-a", index_path, embedding_runtime=self.runtime)
        try:
            await index.upsert_many([_record(memory) for memory in fixture["memories"]])
            expected_queries = [item for item in fixture["queries"] if item["expected"] is not None]
            no_answer_queries = [item for item in fixture["queries"] if item["expected"] is None]
            correct = 0
            legacy_correct = 0
            warm_latencies: list[float] = []
            legacy_memories = {
                item["id"]: _legacy_hash_embedding(item["content"])
                for item in fixture["memories"]
            }
            for item in expected_queries:
                started_at = time.perf_counter()
                result = await index.retrieve(item["query"], 4)
                warm_latencies.append((time.perf_counter() - started_at) * 1000)
                if result["items"] and result["items"][0]["memory"]["id"] == item["expected"]:
                    correct += 1
                legacy_query = _legacy_hash_embedding(item["query"])
                legacy_top = max(
                    legacy_memories,
                    key=lambda memory_id: (
                        sum(
                            left * right
                            for left, right in zip(legacy_query, legacy_memories[memory_id], strict=True)
                        ),
                        memory_id,
                    ),
                )
                if legacy_top == item["expected"]:
                    legacy_correct += 1
            self.assertGreaterEqual(correct / len(expected_queries), 0.95)
            self.assertGreater(correct, legacy_correct + len(expected_queries) // 2)
            for item in no_answer_queries:
                result = await index.retrieve(item["query"], 4)
                self.assertEqual(result, {"items": [], "answerPolicy": "unknown"})

            ordered = sorted(warm_latencies)
            p95 = ordered[min(len(ordered) - 1, math.ceil(len(ordered) * 0.95) - 1)]
            self.assertLess(statistics.median(warm_latencies), 150)
            self.assertLess(p95, 350)
            inspection = index.inspect()
            self.assertEqual(inspection["embeddingBlobBytes"], EMBEDDING_BLOB_BYTES)
            self.assertEqual(inspection["indexedCount"], len(fixture["memories"]))
        finally:
            await index.close()

        connection = sqlite3.connect(index_path / "index.sqlite3")
        try:
            rows = connection.execute(
                "SELECT typeof(embedding),length(embedding) FROM desktop_memories"
            ).fetchall()
            self.assertTrue(rows)
            self.assertTrue(all(row == ("blob", 2048) for row in rows))
        finally:
            connection.close()

    async def test_conflicting_memory_check_is_not_promoted_to_a_hard_answer(self):
        index_path = self.root / "pet-a" / "index" / "current"
        index_path.mkdir(parents=True)
        index = MemuPetIndex("pet-a", index_path, embedding_runtime=self.runtime)
        try:
            await index.upsert_many([
                _record({"id": "coffee", "content": "用户喜欢喝咖啡", "tags": ["饮品"]}),
                _record({"id": "tea", "content": "用户喜欢喝茉莉花茶", "tags": ["饮品"]}),
            ])
            result = await index.retrieve("你记得我喜欢喝什么饮品吗？", 4)
            self.assertEqual(result, {"items": [], "answerPolicy": "unknown"})
        finally:
            await index.close()


if __name__ == "__main__":
    unittest.main()
