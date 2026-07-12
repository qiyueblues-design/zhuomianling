import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path


SIDECAR_ROOT = str(Path(__file__).resolve().parents[1])
BOOTSTRAP = (
    "import runpy,sys;"
    "root=sys.argv.pop(1);"
    "sys.path.insert(0,root);"
    "runpy.run_module('desktop_pet_memory_sidecar',run_name='__main__')"
)


class SidecarIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.process = subprocess.Popen(
            [sys.executable, "-u", "-c", BOOTSTRAP, SIDECAR_ROOT],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

    def tearDown(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.stderr.close()

    def exchange(self, value):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def handshake(self):
        return self.exchange(
            {"id": "handshake", "method": "handshake", "deadlineMs": 1000, "params": {}}
        )

    def test_handshake_health_secret_and_shutdown(self):
        handshake = self.handshake()
        self.assertEqual(handshake["result"]["protocolVersion"], 1)
        health = self.exchange(
            {"id": "health", "method": "health", "deadlineMs": 1000, "params": {}}
        )
        self.assertEqual(health["result"]["status"], "ready")
        secret = "fixture-secret-never-echo"
        configured = self.exchange(
            {
                "id": "configure",
                "method": "configure",
                "deadlineMs": 1000,
                "params": {"profileId": "fixture", "apiKey": secret},
            }
        )
        self.assertTrue(configured["result"]["configured"])
        self.assertNotIn(secret, json.dumps(configured))
        memory_secret = "memory-provider-secret-never-echo"
        memory_configured = self.exchange(
            {
                "id": "configure-memory-provider",
                "method": "configureMemoryProvider",
                "deadlineMs": 1000,
                "params": {
                    "profileId": "memory-fixture",
                    "apiKey": memory_secret,
                    "baseUrl": "https://memory.example.com/v1",
                    "chatModel": "memory-model",
                    "provider": "openai-compatible",
                },
            }
        )
        self.assertTrue(memory_configured["result"]["configured"])
        self.assertNotIn(memory_secret, json.dumps(memory_configured))
        shutdown = self.exchange(
            {"id": "shutdown", "method": "shutdown", "deadlineMs": 1000, "params": {}}
        )
        self.assertTrue(shutdown["result"]["stopped"])
        self.process.wait(timeout=5)
        stderr = self.process.stderr.read()
        self.assertNotIn(secret, stderr)
        self.assertNotIn(memory_secret, stderr)

    def test_cancel_stops_real_async_task(self):
        self.handshake()
        self.process.stdin.write(
            json.dumps(
                {
                    "id": "slow",
                    "method": "sleep",
                    "petId": "pet-a",
                    "deadlineMs": 5000,
                    "params": {"delayMs": 4000},
                }
            )
            + "\n"
        )
        self.process.stdin.flush()
        started = time.perf_counter()
        canceled = self.exchange(
            {
                "id": "cancel",
                "method": "cancel",
                "deadlineMs": 1000,
                "params": {"targetId": "slow"},
            }
        )
        slow = json.loads(self.process.stdout.readline())
        responses = {canceled["id"]: canceled, slow["id"]: slow}
        self.assertTrue(responses["cancel"]["result"]["canceled"])
        self.assertEqual(responses["slow"]["error"]["code"], "canceled")
        self.assertLess(time.perf_counter() - started, 1.5)

    def test_three_consecutive_parse_errors_stop_the_process(self):
        for _ in range(3):
            self.process.stdin.write("not-json\n")
            self.process.stdin.flush()
            response = json.loads(self.process.stdout.readline())
            self.assertEqual(response["error"]["code"], "invalid-json")
        self.process.wait(timeout=5)
        self.assertEqual(self.process.returncode, 0)


if __name__ == "__main__":
    unittest.main()
