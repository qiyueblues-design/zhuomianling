import asyncio
import importlib.util
import json
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


class NormalizationHandler(BaseHTTPRequestHandler):
    response_content = json.dumps({"memories": []})
    requests: list[dict] = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        self.__class__.requests.append({
            "path": self.path,
            "authorization": self.headers.get("Authorization"),
            "body": body,
        })
        response = json.dumps({
            "choices": [{"message": {"content": self.__class__.response_content}}]
        }).encode("utf-8")
        self.send_response(200)
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

    async def asyncTearDown(self):
        self.temp.cleanup()

    def index_path(self, pet_id: str, target: str = "current") -> Path:
        path = self.root / pet_id / "index" / target
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def test_two_pet_indexes_never_cross_contaminate_under_pressure(self):
        first = MemuPetIndex("pet-a", self.index_path("pet-a"))
        second = MemuPetIndex("pet-b", self.index_path("pet-b"))
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
        index = MemuPetIndex("pet-a", path)
        expected = [record("pet-a", f"memory-{number}", f"stable fact {number}") for number in range(6)]
        for item in expected:
            await index.upsert(item)
        before = index.inspect()
        await index.close()

        reopened = MemuPetIndex("pet-a", path)
        try:
            after = reopened.inspect()
            self.assertEqual(after["indexedCount"], len(expected))
            self.assertEqual(after["contentFingerprint"], before["contentFingerprint"])
            recalled = await reopened.retrieve("stable fact", 10)
            self.assertEqual({item["memory"]["id"] for item in recalled["items"]}, {item["id"] for item in expected})
        finally:
            await reopened.close()

    async def test_successful_conversation_proof_removes_raw_resource(self):
        index = MemuPetIndex("pet-a", self.index_path("pet-a"))
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
        index = MemuPetIndex("pet-a", self.index_path("pet-a"))
        try:
            NormalizationHandler.response_content = json.dumps({
                "memories": [{
                    "chapter": "preferences_habits",
                    "memoryType": "behavior",
                    "content": "  用户喜欢雨天散步  ",
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
            self.assertEqual(result["entries"][0]["content"], "用户喜欢雨天散步")
            self.assertEqual(result["entries"][0]["tags"], ["散步", "家"])
            self.assertEqual(result["entries"][0]["petId"], "pet-a")
            self.assertEqual(index.inspect()["indexedCount"], 0)
            self.assertEqual(list(index.resources_directory.iterdir()), [])
            request = NormalizationHandler.requests[0]
            self.assertEqual(request["path"], "/v1/chat/completions")
            self.assertEqual(request["authorization"], "Bearer http-test-secret")
            system_prompt = request["body"]["messages"][0]["content"]
            self.assertIn("不可信数据", system_prompt)
            self.assertIn("userText 的主要自然语言", system_prompt)
            self.assertIn("必须使用自然的简体中文", system_prompt)
            self.assertIn("不受 assistantReply 所用语言影响", system_prompt)
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
        index = MemuPetIndex("pet-a", self.index_path("pet-a"))
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

    async def test_failed_normalization_keeps_only_one_stable_transient_turn(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), NormalizationHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        index = MemuPetIndex("pet-a", self.index_path("pet-a"))
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
