import asyncio
import hashlib
import importlib.util
import json
import math
import re
import sqlite3
import struct
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import AsyncMock


MEMU_AVAILABLE = importlib.util.find_spec("memu") is not None

if MEMU_AVAILABLE:
    from desktop_pet_memory_sidecar.memu_backend import MemuPetIndex
    from desktop_pet_memory_sidecar.protocol import ProtocolError


class FakeEmbeddingRuntime:
    """512-dimensional deterministic test double; production never uses this path."""

    async def embed(self, texts: list[str]) -> list[list[float]]:
        result: list[list[float]] = []
        for text in texts:
            vector = [0.0] * 512
            tokens = re.findall(r"[A-Za-z0-9_+.-]+|[\u3400-\u9fff]", text.casefold()) or [text]
            for token in tokens:
                digest = hashlib.sha256(token.encode("utf-8")).digest()
                vector[int.from_bytes(digest[:2], "little") % len(vector)] += 1.0
            magnitude = math.sqrt(sum(value * value for value in vector)) or 1.0
            result.append([value / magnitude for value in vector])
        return result


class NormalizationHandler(BaseHTTPRequestHandler):
    response_content = json.dumps({"memories": []})
    requests: list[dict] = []
    response_statuses: list[int] = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        self.__class__.requests.append({
            "path": self.path,
            "authorization": self.headers.get("Authorization"),
            "body": body,
        })
        status = self.__class__.response_statuses.pop(0) if self.__class__.response_statuses else 200
        response = json.dumps({
            "choices": [{"message": {"content": self.__class__.response_content}}]
        }).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format, *_args):
        pass


def record(pet_id: str, memory_id: str, content: str) -> dict:
    return {
        "id": memory_id,
        "petId": pet_id,
        "chapter": "preferences_habits",
        "memoryType": "behavior",
        "content": content,
        "tags": ["test"],
        "important": False,
        "origin": "manual",
        "sourceAvailable": False,
        "createdAt": "2026-07-13T00:00:00.000Z",
        "updatedAt": "2026-07-13T00:00:00.000Z",
        "revision": 1,
    }


@unittest.skipUnless(MEMU_AVAILABLE, "locked memu-py development dependency is not on sys.path")
class MemuBackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        NormalizationHandler.requests = []
        NormalizationHandler.response_content = json.dumps({"memories": []})
        NormalizationHandler.response_statuses = []
        self.embedding_runtime = FakeEmbeddingRuntime()

    async def asyncTearDown(self):
        self.temp.cleanup()

    def index_path(self, pet_id: str, target: str = "current") -> Path:
        path = self.root / pet_id / "index" / target
        path.mkdir(parents=True, exist_ok=True)
        return path

    def open_index(self, pet_id: str, target: str = "current") -> MemuPetIndex:
        return MemuPetIndex(
            pet_id,
            self.index_path(pet_id, target),
            embedding_runtime=self.embedding_runtime,
        )

    async def test_two_pet_indexes_never_cross_contaminate_under_pressure(self):
        first = self.open_index("pet-a")
        second = self.open_index("pet-b")
        try:
            await asyncio.gather(*[
                first.upsert(record("pet-a", f"a-{index}", f"alpha tea preference {index}"))
                for index in range(20)
            ], *[
                second.upsert(record("pet-b", f"b-{index}", f"beta coffee preference {index}"))
                for index in range(20)
            ])
            first_result, second_result = await asyncio.gather(
                first.retrieve("alpha tea", 10), second.retrieve("beta coffee", 10)
            )
            self.assertTrue(first_result["items"])
            self.assertTrue(second_result["items"])
            self.assertTrue(all(item["memory"]["petId"] == "pet-a" for item in first_result["items"]))
            self.assertTrue(all(item["memory"]["petId"] == "pet-b" for item in second_result["items"]))
            self.assertNotIn("embedding", repr(first_result))
            self.assertNotIn(str(self.root), repr(first_result))
        finally:
            await first.close()
            await second.close()

    async def test_reopen_and_rebuild_reproduce_the_authority_visible_set(self):
        path = self.index_path("pet-a", "staging-rebuild")
        index = MemuPetIndex("pet-a", path, embedding_runtime=self.embedding_runtime)
        expected = [record("pet-a", f"memory-{number}", f"stable fact {number}") for number in range(6)]
        for item in expected:
            await index.upsert(item)
        before = index.inspect()
        await index.close()

        reopened = MemuPetIndex("pet-a", path, embedding_runtime=self.embedding_runtime)
        try:
            after = reopened.inspect()
            self.assertEqual(after["indexedCount"], len(expected))
            self.assertEqual(after["contentFingerprint"], before["contentFingerprint"])
            recalled = await reopened.retrieve("stable fact", 10)
            self.assertEqual({item["memory"]["id"] for item in recalled["items"]}, {item["id"] for item in expected})
        finally:
            await reopened.close()

    async def test_forget_and_clear_physically_remove_derived_content_and_wal(self):
        path = self.index_path("pet-a")
        database_path = path / "index.sqlite3"
        index = MemuPetIndex("pet-a", path, embedding_runtime=self.embedding_runtime)
        private_text = "sensitive-derived-content-fixture"
        await index.upsert(record("pet-a", "private-1", private_text))
        await index.forget("private-1")
        await index.close()

        self.assertNotIn(private_text.encode("utf-8"), database_path.read_bytes())
        self.assertFalse(Path(f"{database_path}-wal").exists())
        reopened = MemuPetIndex("pet-a", path, embedding_runtime=self.embedding_runtime)
        await reopened.upsert(record("pet-a", "private-2", f"{private_text}-two"))
        await reopened.upsert(record("pet-a", "private-3", f"{private_text}-three"))
        await reopened.clear()
        await reopened.close()
        self.assertNotIn(private_text.encode("utf-8"), database_path.read_bytes())
        self.assertFalse(Path(f"{database_path}-wal").exists())

    async def test_v2_index_uses_normalized_512_float_blob_and_trigram_evidence(self):
        path = self.index_path("pet-a")
        database_path = path / "index.sqlite3"
        index = self.open_index("pet-a")
        named = record("pet-a", "name-1", "用户希望被称为若叶睦")
        named["tags"] = ["若叶睦", "称呼"]
        await index.upsert(named)
        result = await index.retrieve("你应该怎么称呼我？若叶睦吗？", 5)
        self.assertEqual(result["answerPolicy"], "verified")
        self.assertEqual(result["items"][0]["memory"]["id"], "name-1")
        inspection = index.inspect()
        self.assertEqual(inspection["embeddingBlobBytes"], 2048)
        self.assertEqual(inspection["keywordCount"], 1)
        await index.close()

        connection = sqlite3.connect(database_path)
        try:
            columns = {row[1]: row[2] for row in connection.execute("PRAGMA table_info(desktop_memories)")}
            self.assertEqual(columns, {
                "desktop_id": "TEXT", "record_json": "TEXT", "embedding": "BLOB"
            })
            storage = connection.execute(
                "SELECT typeof(embedding),length(embedding) FROM desktop_memories"
            ).fetchone()
            self.assertEqual(storage, ("blob", 2048))
            metadata = dict(connection.execute("SELECT key,value FROM adapter_metadata"))
            self.assertEqual(metadata["dimension"], "512")
            self.assertEqual(metadata["dtype"], "float32-le")
            self.assertEqual(metadata["normalization"], "l2")
            self.assertEqual(metadata["pooling"], "cls")
        finally:
            connection.close()

    async def test_non_finite_embedding_blob_is_rejected_on_reopen(self):
        path = self.index_path("pet-a")
        index = self.open_index("pet-a")
        await index.upsert(record("pet-a", "memory-1", "finite fixture"))
        await index.close()
        connection = sqlite3.connect(path / "index.sqlite3")
        connection.execute(
            "UPDATE desktop_memories SET embedding=? WHERE desktop_id='memory-1'",
            (struct.pack("<512f", math.nan, *([0.0] * 511)),),
        )
        connection.commit()
        connection.close()
        with self.assertRaisesRegex(ProtocolError, "invalid values"):
            self.open_index("pet-a")

    async def test_legacy_index_allows_normalization_but_requires_staging_for_index_work(self):
        path = self.index_path("pet-a")
        connection = sqlite3.connect(path / "index.sqlite3")
        connection.execute(
            "CREATE TABLE desktop_memories(desktop_id TEXT PRIMARY KEY,record_json TEXT NOT NULL,embedding_json TEXT NOT NULL) STRICT"
        )
        connection.execute("CREATE TABLE adapter_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT")
        connection.execute("INSERT INTO adapter_metadata VALUES('schema_version','1')")
        connection.commit()
        connection.close()
        index = MemuPetIndex("pet-a", path, embedding_runtime=self.embedding_runtime)
        try:
            with self.assertRaisesRegex(ProtocolError, "staging rebuild"):
                index.inspect()
            index._normalize_conversation = AsyncMock(return_value=[])
            result = await index.memorize({
                "requestId": "legacy-normalize",
                "userText": "这轮没有长期记忆",
                "assistantReply": "好的",
                "occurredAt": "2026-07-13T00:00:00.000Z",
                "retainSource": False,
            }, {
                "apiKey": "secret",
                "baseUrl": "https://example.com/v1",
                "chatModel": "model",
                "provider": "openai-compatible",
            })
            self.assertEqual(result, {"entries": []})
        finally:
            await index.close()

    async def test_successful_conversation_proof_removes_raw_resource(self):
        index = self.open_index("pet-a")
        try:
            normalized = record("pet-a", "auto-1", "我喜欢散步")
            normalized["origin"] = "automatic"
            index._normalize_conversation = AsyncMock(return_value=[normalized])
            result = await index.memorize({
                "requestId": "request-1",
                "userText": "我喜欢散步",
                "assistantReply": "记住啦",
                "occurredAt": "2026-07-13T00:00:00.000Z",
                "retainSource": False,
            }, {
                "apiKey": "secret",
                "baseUrl": "https://example.com/v1",
                "chatModel": "model",
                "provider": "openai-compatible",
            })
            self.assertEqual(len(result["entries"]), 1)
            self.assertEqual(list(index.resources_directory.iterdir()), [])
            self.assertEqual(index.inspect()["indexedCount"], 0)
        finally:
            await index.close()

    async def test_http_normalization_returns_validated_entries_without_index_mutation(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), NormalizationHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        index = self.open_index("pet-a")
        try:
            NormalizationHandler.response_content = json.dumps({
                "memories": [{
                    "chapter": "preferences_habits",
                    "memoryType": "behavior",
                    "content": "  你喜欢雨天散步  ",
                    "tags": ["散步", "家", "walking"],
                }]
            }, ensure_ascii=False)
            result = await index.memorize({
                "requestId": "request-http",
                "userText": "我喜欢雨天散步",
                "assistantReply": "我记住了",
                "occurredAt": "2026-07-13T00:00:00.000Z",
                "retainSource": False,
            }, {
                "apiKey": "http-test-secret",
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                "chatModel": "model",
                "provider": "openai-compatible",
            })
            self.assertEqual(result["entries"][0]["content"], "你喜欢雨天散步")
            self.assertEqual(result["entries"][0]["tags"], ["散步", "家"])
            self.assertEqual(result["entries"][0]["petId"], "pet-a")
            self.assertEqual(index.inspect()["indexedCount"], 0)
            self.assertEqual(list(index.resources_directory.iterdir()), [])
            request = NormalizationHandler.requests[0]
            self.assertEqual(request["path"], "/v1/chat/completions")
            self.assertEqual(request["authorization"], "Bearer http-test-secret")
            self.assertEqual(request["body"]["response_format"]["type"], "json_schema")
            memory_schema = request["body"]["response_format"]["json_schema"]["schema"]
            self.assertEqual(memory_schema["required"], ["memories"])
            self.assertFalse(memory_schema["additionalProperties"])
            system_prompt = request["body"]["messages"][0]["content"]
            self.assertIn("不可信数据", system_prompt)
            self.assertIn("userText 的主要自然语言", system_prompt)
            self.assertIn("必须使用自然的简体中文", system_prompt)
            self.assertIn("不受 assistantReply 所用语言影响", system_prompt)
            self.assertIn("‘我’始终指当前桌宠/助手", system_prompt)
            self.assertIn("‘你’始终指当前用户", system_prompt)
            self.assertIn("用户说‘我喜欢喝奶茶’应整理为‘你喜欢喝奶茶’", system_prompt)
            self.assertIn("用户说‘你喜欢喝奶茶’应整理为‘我喜欢喝奶茶’", system_prompt)
            self.assertIn("用户说‘你称赞我很可爱’应整理为‘我称赞你很可爱’", system_prompt)
            self.assertIn("不能因为缺少另一个人称而省略判断", system_prompt)
            self.assertIn("用户与桌宠共同确认的称呼、约定、边界和稳定互动方式", system_prompt)
            self.assertIn("桌宠在 assistantReply 中明确作出的具体承诺", system_prompt)
            self.assertIn("本轮真实发生的共同经历", system_prompt)
            self.assertIn("我以后称呼你为小睦", system_prompt)
            self.assertIn("我答应继续陪你完成这件事", system_prompt)
            self.assertIn("即时情绪，不得保存", system_prompt)
            self.assertIn("普通回应，不得单独保存", system_prompt)
            self.assertIn("与核心人格有关的变化不能由本轮回复自行确立", system_prompt)
            self.assertIn("共同经历、桌宠具体承诺或已完成的重要行为放入 important_events", system_prompt)
            self.assertIn("身份、背景和稳定属性→profile", system_prompt)
            self.assertIn("偏好、习惯、边界和稳定互动方式→behavior", system_prompt)
            conversation = json.loads(request["body"]["messages"][1]["content"])
            self.assertEqual(conversation, {
                "assistantReply": "我记住了",
                "userText": "我喜欢雨天散步",
            })
            self.assertEqual(await index.test_provider({
                "apiKey": "http-test-secret",
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                "chatModel": "model",
                "provider": "openai-compatible",
            }), {"ready": True})
            self.assertEqual(list(index.resources_directory.iterdir()), [])
            self.assertEqual(index.inspect()["indexedCount"], 0)
        finally:
            await index.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    async def test_chinese_user_text_rejects_an_english_normalized_memory(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), NormalizationHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        index = self.open_index("pet-a")
        try:
            NormalizationHandler.response_content = json.dumps({
                "memories": [{
                    "chapter": "important_events",
                    "memoryType": "event",
                    "content": "User is going home tomorrow at 5pm.",
                    "tags": ["travel", "home"],
                }]
            })
            with self.assertRaisesRegex(ProtocolError, "language does not match userText"):
                await index.memorize({
                    "requestId": "request-language-mismatch",
                    "userText": "我明天下午五点回家",
                    "assistantReply": "好的，我记住了",
                    "occurredAt": "2026-07-13T00:00:00.000Z",
                    "retainSource": False,
                }, {
                    "apiKey": "http-test-secret",
                    "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                    "chatModel": "model",
                    "provider": "openai-compatible",
                })
            self.assertEqual(index.inspect()["indexedCount"], 0)
        finally:
            await index.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    async def test_normalization_falls_back_to_json_object_only_for_compatibility_status(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), NormalizationHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        index = self.open_index("pet-a")
        try:
            NormalizationHandler.response_statuses = [400, 200]
            NormalizationHandler.response_content = json.dumps({"memories": []})
            result = await index.memorize({
                "requestId": "request-format-fallback",
                "userText": "这轮没有长期信息",
                "assistantReply": "好的",
                "occurredAt": "2026-07-13T00:00:00.000Z",
                "retainSource": False,
            }, {
                "apiKey": "http-test-secret",
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                "chatModel": "model",
                "provider": "openai-compatible",
            })

            self.assertEqual(result, {"entries": []})
            self.assertEqual(len(NormalizationHandler.requests), 2)
            self.assertEqual(
                NormalizationHandler.requests[0]["body"]["response_format"]["type"],
                "json_schema",
            )
            self.assertEqual(
                NormalizationHandler.requests[1]["body"]["response_format"]["type"],
                "json_object",
            )
        finally:
            await index.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    async def test_normalization_does_not_format_fallback_on_authentication_error(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), NormalizationHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        index = self.open_index("pet-a")
        try:
            NormalizationHandler.response_statuses = [401]
            with self.assertRaises(Exception):
                await index.memorize({
                    "requestId": "request-auth-failure",
                    "userText": "我喜欢散步",
                    "assistantReply": "我记住了",
                    "occurredAt": "2026-07-13T00:00:00.000Z",
                    "retainSource": False,
                }, {
                    "apiKey": "invalid-secret",
                    "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                    "chatModel": "model",
                    "provider": "openai-compatible",
                })

            self.assertEqual(len(NormalizationHandler.requests), 1)
            self.assertEqual(
                NormalizationHandler.requests[0]["body"]["response_format"]["type"],
                "json_schema",
            )
        finally:
            await index.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    async def test_failed_normalization_keeps_only_one_stable_transient_turn(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), NormalizationHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        index = self.open_index("pet-a")
        turn = {
            "requestId": "request-failure",
            "userText": "temporary request",
            "assistantReply": "temporary answer",
            "occurredAt": "2026-07-13T00:00:00.000Z",
            "retainSource": False,
        }
        provider = {
            "apiKey": "http-test-secret",
            "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
            "chatModel": "model",
            "provider": "openai-compatible",
        }
        try:
            NormalizationHandler.response_content = "not-json"
            for _ in range(2):
                with self.assertRaises(ProtocolError):
                    await index.memorize(turn, provider)
            resources = list(index.resources_directory.iterdir())
            self.assertEqual(len(resources), 1)
            self.assertEqual(json.loads(resources[0].read_text(encoding="utf-8")), turn)
            self.assertEqual(index.inspect()["indexedCount"], 0)
        finally:
            await index.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
