from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

from .memu_backend import MODEL_FINGERPRINT, MemuPetIndex, validate_index_path


@dataclass(slots=True)
class _PoolEntry:
    path: Path
    index: MemuPetIndex


class MemuServicePool:
    def __init__(self) -> None:
        self._entries: dict[str, _PoolEntry] = {}
        self._lock = asyncio.Lock()

    async def get(self, pet_id: str, index_path: object) -> MemuPetIndex:
        path = validate_index_path(index_path)
        async with self._lock:
            existing = self._entries.get(pet_id)
            if existing is not None and existing.path == path:
                return existing.index
            if existing is not None:
                await existing.index.close()
            index = MemuPetIndex(pet_id, path, MODEL_FINGERPRINT)
            self._entries[pet_id] = _PoolEntry(path, index)
            return index

    async def close_pet(self, pet_id: str) -> bool:
        async with self._lock:
            entry = self._entries.pop(pet_id, None)
            if entry is None:
                return False
            await entry.index.close()
            return True

    async def close(self) -> None:
        async with self._lock:
            entries = list(self._entries.values())
            self._entries.clear()
            for entry in entries:
                await entry.index.close()
