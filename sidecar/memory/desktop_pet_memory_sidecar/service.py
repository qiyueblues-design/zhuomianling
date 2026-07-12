from __future__ import annotations

import asyncio
import ctypes
import importlib.metadata
import os
import platform
import sys
from typing import Any
from urllib.parse import urlparse

from . import __version__
from .protocol import PROTOCOL_VERSION, ProtocolError, Request
from .service_pool import MemuServicePool


def warmup_memu_runtime() -> None:
    """Load native memU/numpy modules before the Windows stdin reader thread starts.

    Python 3.13's embeddable runtime can deadlock while loading numpy's native module
    if another thread is already blocked in buffered stdin. A missing optional M4
    dependency remains valid for the M3 protocol-only sidecar.
    """
    try:
        import memu  # noqa: F401
    except ImportError:
        return


def _rss_bytes() -> int | None:
    if sys.platform == "win32":
        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        get_current_process = ctypes.windll.kernel32.GetCurrentProcess
        get_current_process.restype = ctypes.c_void_p
        get_process_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
        get_process_memory_info.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ProcessMemoryCounters),
            ctypes.c_ulong,
        ]
        get_process_memory_info.restype = ctypes.c_int
        process = get_current_process()
        if get_process_memory_info(process, ctypes.byref(counters), counters.cb):
            return int(counters.WorkingSetSize)
        return None
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(usage if sys.platform == "darwin" else usage * 1024)
    except (ImportError, OSError):
        return None


class SidecarService:
    def __init__(self) -> None:
        self.handshake_complete = False
        self.accepting = True
        self.secrets: dict[str, str] = {}
        self.providers: dict[str, dict[str, str]] = {}
        self.pool = MemuServicePool()

    @staticmethod
    def _memu_version() -> str | None:
        try:
            return importlib.metadata.version("memu-py")
        except importlib.metadata.PackageNotFoundError:
            return None

    async def handle(self, request: Request, tasks: dict[str, asyncio.Task[Any]]) -> object:
        if request.method == "handshake":
            if request.pet_id is not None or request.params:
                raise ProtocolError("invalid-request", "Handshake does not accept pet or params.")
            self.handshake_complete = True
            return {
                "sidecarVersion": __version__,
                "protocolVersion": PROTOCOL_VERSION,
                "pythonVersion": platform.python_version(),
                "memuVersion": self._memu_version(),
                "schemaVersion": 1,
            }
        if not self.handshake_complete:
            raise ProtocolError("handshake-required", "Protocol handshake is required.")
        if not self.accepting and request.method != "shutdown":
            raise ProtocolError("unavailable", "Sidecar is shutting down.")
        if request.method == "health":
            if request.pet_id is not None or request.params:
                raise ProtocolError("invalid-request", "Health does not accept pet or params.")
            return {"status": "ready", "pid": os.getpid(), "rssBytes": _rss_bytes()}
        if request.method == "configure":
            return self._configure(request)
        if request.method == "configureMemoryProvider":
            return self._configure_memory_provider(request)
        if request.method == "retrieve":
            return await self._retrieve(request)
        if request.method == "memorize":
            return await self._memorize(request)
        if request.method == "testMemoryProvider":
            return await self._test_memory_provider(request)
        if request.method == "upsert":
            return await self._upsert(request)
        if request.method == "forget":
            return await self._forget(request)
        if request.method == "rebuildBegin":
            return await self._rebuild_begin(request)
        if request.method == "rebuildAppend":
            return await self._rebuild_append(request)
        if request.method == "rebuildFinish":
            return await self._rebuild_finish(request)
        if request.method == "inspectIndex":
            return await self._inspect_index(request)
        if request.method == "closePet":
            return await self._close_pet(request)
        if request.method == "sleep":
            return await self._sleep(request)
        if request.method == "cancel":
            return self._cancel(request, tasks)
        if request.method == "shutdown":
            if request.pet_id is not None or request.params:
                raise ProtocolError("invalid-request", "Shutdown does not accept pet or params.")
            self.accepting = False
            current = asyncio.current_task()
            to_cancel = [task for task in tasks.values() if task is not current and not task.done()]
            for task in to_cancel:
                task.cancel()
            if to_cancel:
                await asyncio.gather(*to_cancel, return_exceptions=True)
            await self.pool.close()
            self.secrets.clear()
            self.providers.clear()
            return {"stopped": True}
        if request.method == "crash":
            if request.pet_id is not None or request.params:
                raise ProtocolError("invalid-request", "Crash does not accept pet or params.")
            os._exit(70)
        raise ProtocolError("unknown-method", "Unknown sidecar method.")

    def _configure(self, request: Request) -> object:
        if request.pet_id is not None or set(request.params) != {"profileId", "apiKey"}:
            raise ProtocolError("invalid-request", "Configure params are invalid.")
        profile_id = request.params.get("profileId")
        api_key = request.params.get("apiKey")
        if not isinstance(profile_id, str) or not profile_id.strip() or len(profile_id) > 128:
            raise ProtocolError("invalid-request", "Provider profile ID is invalid.")
        if not isinstance(api_key, str) or not api_key or len(api_key) > 4096:
            raise ProtocolError("invalid-request", "Provider API key is invalid.")
        self.secrets[profile_id] = api_key
        return {"configured": True, "profileId": profile_id}

    def _configure_memory_provider(self, request: Request) -> object:
        expected = {"profileId", "apiKey", "baseUrl", "chatModel", "provider"}
        if request.pet_id is not None or set(request.params) != expected:
            raise ProtocolError("invalid-request", "Memory provider params are invalid.")
        profile_id = request.params.get("profileId")
        api_key = request.params.get("apiKey")
        base_url = request.params.get("baseUrl")
        chat_model = request.params.get("chatModel")
        provider = request.params.get("provider")
        parsed_url = urlparse(base_url) if isinstance(base_url, str) else None
        if not isinstance(profile_id, str) or not profile_id.strip() or len(profile_id) > 128:
            raise ProtocolError("invalid-request", "Memory provider profile is invalid.")
        if not isinstance(api_key, str) or not api_key or len(api_key) > 4096:
            raise ProtocolError("invalid-request", "Memory provider key is invalid.")
        if (
            not isinstance(base_url, str)
            or len(base_url) > 2048
            or parsed_url is None
            or parsed_url.scheme not in {"http", "https"}
            or not parsed_url.netloc
            or parsed_url.username
            or parsed_url.password
        ):
            raise ProtocolError("invalid-request", "Memory provider URL is invalid.")
        if not isinstance(chat_model, str) or not chat_model.strip() or len(chat_model) > 256:
            raise ProtocolError("invalid-request", "Memory provider model is invalid.")
        if provider != "openai-compatible":
            raise ProtocolError("invalid-config", "Memory provider is unsupported.")
        self.providers[profile_id] = {
            "apiKey": api_key,
            "baseUrl": base_url,
            "chatModel": chat_model,
            "provider": provider,
        }
        return {"configured": True, "profileId": profile_id}

    async def _sleep(self, request: Request) -> object:
        if request.pet_id is None or set(request.params) - {"delayMs", "value"}:
            raise ProtocolError("invalid-request", "Sleep params are invalid.")
        delay_ms = request.params.get("delayMs")
        if not isinstance(delay_ms, int) or isinstance(delay_ms, bool) or not 0 <= delay_ms <= 60_000:
            raise ProtocolError("invalid-request", "Sleep delay is invalid.")
        await asyncio.sleep(delay_ms / 1000)
        return {"petId": request.pet_id, "value": request.params.get("value")}

    @staticmethod
    def _require_pet(request: Request, expected: set[str]) -> None:
        if request.pet_id is None or set(request.params) != expected:
            raise ProtocolError("invalid-request", "Memory index params are invalid.")

    async def _retrieve(self, request: Request) -> object:
        self._require_pet(request, {"indexPath", "query", "limit"})
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        return await index.retrieve(request.params["query"], request.params["limit"])

    async def _memorize(self, request: Request) -> object:
        self._require_pet(request, {"indexPath", "turn", "profileId"})
        profile_id = request.params["profileId"]
        if not isinstance(profile_id, str) or profile_id not in self.providers:
            raise ProtocolError("invalid-config", "Memory normalization provider is not configured.")
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        return await index.memorize(request.params["turn"], self.providers[profile_id])

    async def _test_memory_provider(self, request: Request) -> object:
        self._require_pet(request, {"indexPath", "profileId"})
        profile_id = request.params["profileId"]
        if not isinstance(profile_id, str) or profile_id not in self.providers:
            raise ProtocolError("invalid-config", "Memory normalization provider is not configured.")
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        return await index.test_provider(self.providers[profile_id])

    async def _upsert(self, request: Request) -> object:
        self._require_pet(request, {"indexPath", "memory"})
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        await index.upsert(request.params["memory"])
        return {"applied": True}

    async def _forget(self, request: Request) -> object:
        self._require_pet(request, {"indexPath", "memoryId"})
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        await index.forget(request.params["memoryId"])
        return {"applied": True}

    async def _rebuild_begin(self, request: Request) -> object:
        self._require_pet(request, {"indexPath"})
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        await index.clear()
        return {"started": True}

    async def _rebuild_append(self, request: Request) -> object:
        self._require_pet(request, {"indexPath", "records"})
        records = request.params["records"]
        if not isinstance(records, list) or not 1 <= len(records) <= 25:
            raise ProtocolError("invalid-request", "Rebuild batch is invalid.")
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        for record in records:
            await index.upsert(record)
        return {"appendedCount": len(records)}

    async def _rebuild_finish(self, request: Request) -> object:
        self._require_pet(request, {"indexPath", "expectedCount", "expectedContentFingerprint"})
        expected = request.params["expectedCount"]
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise ProtocolError("invalid-request", "Rebuild count is invalid.")
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        result = index.inspect()
        if result["indexedCount"] != expected:
            raise ProtocolError("index-dirty", "Rebuilt index count did not match its authority snapshot.")
        expected_fingerprint = request.params["expectedContentFingerprint"]
        if (
            not isinstance(expected_fingerprint, str)
            or len(expected_fingerprint) != 64
            or result["contentFingerprint"] != expected_fingerprint
        ):
            raise ProtocolError("index-dirty", "Rebuilt index content did not match its authority snapshot.")
        return result

    async def _inspect_index(self, request: Request) -> object:
        self._require_pet(request, {"indexPath"})
        index = await self.pool.get(request.pet_id, request.params["indexPath"])
        return index.inspect()

    async def _close_pet(self, request: Request) -> object:
        self._require_pet(request, set())
        return {"closed": await self.pool.close_pet(request.pet_id)}

    @staticmethod
    def _cancel(request: Request, tasks: dict[str, asyncio.Task[Any]]) -> object:
        if request.pet_id is not None or set(request.params) != {"targetId"}:
            raise ProtocolError("invalid-request", "Cancel params are invalid.")
        target_id = request.params.get("targetId")
        if not isinstance(target_id, str):
            raise ProtocolError("invalid-request", "Cancel target is invalid.")
        task = tasks.get(target_id)
        canceled = bool(task and not task.done())
        if canceled:
            task.cancel()
        return {"canceled": canceled, "targetId": target_id}
