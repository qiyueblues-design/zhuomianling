from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 65_536
MAX_DEPTH = 16
MAX_ARRAY_ITEMS = 100
MAX_OBJECT_KEYS = 128
MAX_STRING_CHARS = 32_768
MAX_ID_CHARS = 128
MAX_DEADLINE_MS = 60_000
ALLOWED_REQUEST_FIELDS = frozenset({"id", "method", "petId", "deadlineMs", "params"})


class ProtocolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class Request:
    request_id: str
    method: str
    pet_id: str | None
    deadline_ms: int
    params: dict[str, Any]


def _is_valid_pet_id(value: object) -> bool:
    if not isinstance(value, str) or value != value.strip() or not 1 <= len(value) <= 64:
        return False
    return value[0].isalnum() and all(character.isalnum() or character in "_-" for character in value)


def validate_budget(value: object) -> None:
    stack: list[tuple[object, int]] = [(value, 1)]
    total_string_chars = 0
    while stack:
        current, depth = stack.pop()
        if depth > MAX_DEPTH:
            raise ProtocolError("invalid-request", "Protocol object exceeds maximum depth.")
        if isinstance(current, str):
            total_string_chars += len(current)
            if total_string_chars > MAX_STRING_CHARS:
                raise ProtocolError("invalid-request", "Protocol strings exceed their shared budget.")
        elif isinstance(current, list):
            if len(current) > MAX_ARRAY_ITEMS:
                raise ProtocolError("invalid-request", "Protocol array exceeds its item budget.")
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, dict):
            if len(current) > MAX_OBJECT_KEYS:
                raise ProtocolError("invalid-request", "Protocol object exceeds its key budget.")
            for key, item in current.items():
                if not isinstance(key, str):
                    raise ProtocolError("invalid-request", "Protocol object keys must be strings.")
                total_string_chars += len(key)
                if total_string_chars > MAX_STRING_CHARS:
                    raise ProtocolError("invalid-request", "Protocol strings exceed their shared budget.")
                stack.append((item, depth + 1))
        elif isinstance(current, float) and not math.isfinite(current):
            raise ProtocolError("invalid-request", "Protocol numbers must be finite.")
        elif current is not None and not isinstance(current, (bool, int, float)):
            raise ProtocolError("invalid-request", "Protocol contains an unsupported value.")


def _reject_constant(_value: str) -> None:
    raise ProtocolError("invalid-json", "Protocol numbers must be finite.")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("invalid-json", "Protocol object contains duplicate keys.")
        result[key] = value
    return result


def parse_request(line: bytes) -> Request:
    if len(line) > MAX_LINE_BYTES:
        raise ProtocolError("invalid-request", "Protocol line exceeds its byte budget.")
    try:
        decoded = line.decode("utf-8")
        value = json.loads(
            decoded,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("invalid-json", "Protocol line is not valid UTF-8 JSON.") from error
    validate_budget(value)
    if not isinstance(value, dict):
        raise ProtocolError("invalid-request", "Protocol request must be an object.")
    unknown = set(value) - ALLOWED_REQUEST_FIELDS
    if unknown:
        raise ProtocolError("invalid-request", "Protocol request contains unknown fields.")
    request_id = value.get("id")
    method = value.get("method")
    deadline_ms = value.get("deadlineMs")
    params = value.get("params", {})
    pet_id = value.get("petId")
    if not isinstance(request_id, str) or not request_id or len(request_id) > MAX_ID_CHARS:
        raise ProtocolError("invalid-request", "Protocol request ID is invalid.")
    if not isinstance(method, str) or not method or len(method) > 64:
        raise ProtocolError("invalid-request", "Protocol method is invalid.")
    if not isinstance(deadline_ms, int) or isinstance(deadline_ms, bool) or not 1 <= deadline_ms <= MAX_DEADLINE_MS:
        raise ProtocolError("invalid-request", "Protocol deadline is invalid.")
    if not isinstance(params, dict):
        raise ProtocolError("invalid-request", "Protocol params must be an object.")
    if pet_id is not None and not _is_valid_pet_id(pet_id):
        raise ProtocolError("invalid-request", "Protocol pet ID is invalid.")
    return Request(request_id, method, pet_id, deadline_ms, params)


def encode_response(request_id: str | None, *, result: object = None, error: dict[str, object] | None = None) -> bytes:
    value = (
        {"id": request_id, "ok": False, "error": error}
        if error is not None
        else {"id": request_id, "ok": True, "result": result}
    )
    try:
        validate_budget(value)
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    except (ProtocolError, TypeError, ValueError):
        encoded = b""
    if not encoded or len(encoded) > MAX_LINE_BYTES:
        fallback = {
            "id": request_id,
            "ok": False,
            "error": {"code": "output-budget", "message": "Sidecar response exceeds its byte budget."},
        }
        encoded = json.dumps(fallback, separators=(",", ":")).encode("utf-8") + b"\n"
    return encoded
