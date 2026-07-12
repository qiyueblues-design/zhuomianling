import json
import os
import sys


def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "handshake":
        send(
            {
                "id": request["id"],
                "ok": True,
                "result": {
                    "sidecarVersion": "fake-python",
                    "protocolVersion": 1,
                    "pythonVersion": "3.13.7",
                    "memuVersion": None,
                    "schemaVersion": 1,
                },
            }
        )
    elif request["method"] == "health":
        send({"id": request["id"], "ok": True, "result": {"status": "ready", "pid": os.getpid()}})
    elif request["method"] == "malformed":
        sys.stdout.write("not-json\n")
        sys.stdout.flush()
    elif request["method"] == "oversized":
        sys.stdout.write("x" * 70_000 + "\n")
        sys.stdout.flush()
    elif request["method"] == "shutdown":
        send({"id": request["id"], "ok": True, "result": {"stopped": True}})
        break
