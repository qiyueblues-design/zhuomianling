from __future__ import annotations

import asyncio
import os
import sys
import threading
from typing import Any

from .protocol import MAX_LINE_BYTES, ProtocolError, Request, encode_response, parse_request
from .service import SidecarService, warmup_memu_runtime


class SidecarServer:
    def __init__(self) -> None:
        self.service = SidecarService()
        self.tasks: dict[str, asyncio.Task[Any]] = {}
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.shutdown_event = asyncio.Event()
        self.parse_errors = 0

    def _start_reader(self, loop: asyncio.AbstractEventLoop) -> None:
        def read_lines() -> None:
            while True:
                line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
                if not line:
                    loop.call_soon_threadsafe(self.queue.put_nowait, None)
                    return
                if len(line) > MAX_LINE_BYTES and not line.endswith(b"\n"):
                    while True:
                        remainder = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
                        if not remainder or remainder.endswith(b"\n"):
                            break
                loop.call_soon_threadsafe(self.queue.put_nowait, line)

        threading.Thread(target=read_lines, name="memory-sidecar-stdin", daemon=True).start()

    @staticmethod
    def _write(payload: bytes) -> None:
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()

    async def _execute(self, request: Request) -> None:
        should_shutdown = request.method == "shutdown"
        try:
            async with asyncio.timeout(request.deadline_ms / 1000):
                result = await self.service.handle(request, self.tasks)
            self._write(encode_response(request.request_id, result=result))
        except asyncio.CancelledError:
            self._write(
                encode_response(
                    request.request_id,
                    error={"code": "canceled", "message": "Sidecar operation was canceled."},
                )
            )
        except TimeoutError:
            self._write(
                encode_response(
                    request.request_id,
                    error={"code": "timeout", "message": "Sidecar operation timed out."},
                )
            )
        except ProtocolError as error:
            self._write(
                encode_response(
                    request.request_id,
                    error={"code": error.code, "message": error.message},
                )
            )
        except Exception:
            print("memory-sidecar: internal operation failure", file=sys.stderr, flush=True)
            self._write(
                encode_response(
                    request.request_id,
                    error={"code": "internal", "message": "Sidecar operation failed."},
                )
            )
        finally:
            self.tasks.pop(request.request_id, None)
            if should_shutdown:
                self.shutdown_event.set()

    async def serve(self) -> None:
        warmup_memu_runtime()
        loop = asyncio.get_running_loop()
        self._start_reader(loop)
        while not self.shutdown_event.is_set():
            get_line = asyncio.create_task(self.queue.get())
            stopping = asyncio.create_task(self.shutdown_event.wait())
            done, pending = await asyncio.wait(
                {get_line, stopping}, return_when=asyncio.FIRST_COMPLETED
            )
            for waiter in pending:
                waiter.cancel()
            if stopping in done and stopping.result():
                break
            line = get_line.result()
            if line is None:
                break
            request_id: str | None = None
            try:
                request = parse_request(line)
                request_id = request.request_id
                self.parse_errors = 0
                if request.request_id in self.tasks:
                    raise ProtocolError("invalid-request", "Duplicate in-flight request ID.")
                task = asyncio.create_task(self._execute(request))
                self.tasks[request.request_id] = task
            except ProtocolError as error:
                self.parse_errors += 1
                self._write(
                    encode_response(
                        request_id,
                        error={"code": error.code, "message": error.message},
                    )
                )
                if self.parse_errors >= 3:
                    break
        remaining = [task for task in self.tasks.values() if not task.done()]
        for task in remaining:
            task.cancel()
        if remaining:
            await asyncio.gather(*remaining, return_exceptions=True)
        await self.service.pool.close()
        self.service.secrets.clear()
        self.service.providers.clear()


def main() -> None:
    asyncio.run(SidecarServer().serve())
    sys.stdout.flush()
    sys.stderr.flush()
    # Windows cannot portably cancel a buffered read held by the dedicated stdin
    # thread. All protocol tasks and in-memory secrets are already cleaned above.
    os._exit(0)


if __name__ == "__main__":
    main()
