from __future__ import annotations

import asyncio
import hashlib
import math
import os
import threading
from pathlib import Path
from typing import Any

from .protocol import ProtocolError


MODEL_ID = "BAAI/bge-small-zh-v1.5"
MODEL_REVISION = "7999e1d3359715c523056ef9478215996d62a620"
CONVERSION_ID = "desktop-pet/export-bge-int8.py"
CONVERSION_REVISION = "m10-v1-torch2.9.1-transformers4.57.6-onnx1.20.1-ort1.27.0"
MODEL_FILE_NAME = "onnx/model_int8.onnx"
MODEL_FILE_SHA256 = "848c2ccd9277d9b36e830d1cc6c27644b78764b210d7409078d7db6f06b6ed20"
TOKENIZER_FILE_NAME = "tokenizer.json"
TOKENIZER_SHA256 = "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26"
QUANTIZATION = "QInt8-per-channel-reduced-range"
EMBEDDING_DIMENSION = 512
EMBEDDING_DTYPE = "float32-le"
EMBEDDING_NORMALIZATION = "l2"
EMBEDDING_POOLING = "cls"
EMBEDDING_BLOB_BYTES = EMBEDDING_DIMENSION * 4
INDEX_SCHEMA_VERSION = 2
MODEL_FINGERPRINT = (
    "bge-small-zh-v1.5-int8:v2:"
    "848c2ccd9277d9b3:48cea5d44424912a:512:f32le:cls:l2"
)


INDEX_METADATA = {
    "schema_version": str(INDEX_SCHEMA_VERSION),
    "model_id": MODEL_ID,
    "model_revision": MODEL_REVISION,
    "conversion_id": CONVERSION_ID,
    "conversion_revision": CONVERSION_REVISION,
    "model_file_sha256": MODEL_FILE_SHA256,
    "tokenizer_sha256": TOKENIZER_SHA256,
    "quantization": QUANTIZATION,
    "dimension": str(EMBEDDING_DIMENSION),
    "dtype": EMBEDDING_DTYPE,
    "normalization": EMBEDDING_NORMALIZATION,
    "pooling": EMBEDDING_POOLING,
    "model_fingerprint": MODEL_FINGERPRINT,
    "fts_tokenizer": "trigram",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_model_file(root: Path, relative_name: str) -> Path:
    candidate = root.joinpath(*relative_name.split("/"))
    try:
        root_real = root.resolve(strict=True)
        cursor = root
        for part in relative_name.split("/"):
            cursor = cursor / part
            if cursor.is_symlink():
                raise ProtocolError("invalid-config", "Local embedding model assets are unsafe.")
        candidate_real = candidate.resolve(strict=True)
        candidate_real.relative_to(root_real)
    except (FileNotFoundError, OSError, ValueError) as error:
        raise ProtocolError("invalid-config", "Local embedding model assets are unavailable.") from error
    if root.is_symlink() or candidate.is_symlink() or not candidate_real.is_file():
        raise ProtocolError("invalid-config", "Local embedding model assets are unsafe.")
    return candidate_real


class BgeEmbeddingRuntime:
    """Process-wide lazy ONNX runtime for the local Chinese embedding model."""

    def __init__(self, model_root: Path):
        if not model_root.is_absolute():
            raise ProtocolError("invalid-config", "Local embedding model root is invalid.")
        self.model_root = model_root
        self._load_lock = threading.Lock()
        self._run_lock = threading.Lock()
        self._session: Any | None = None
        self._tokenizer: Any | None = None
        self._numpy: Any | None = None
        self._onnxruntime: Any | None = None
        self._input_names: frozenset[str] = frozenset()

    @property
    def loaded(self) -> bool:
        return self._session is not None

    def _load(self) -> None:
        if self._session is not None:
            return
        with self._load_lock:
            if self._session is not None:
                return
            model_path = _safe_model_file(self.model_root, MODEL_FILE_NAME)
            tokenizer_path = _safe_model_file(self.model_root, TOKENIZER_FILE_NAME)
            if _sha256(model_path) != MODEL_FILE_SHA256 or _sha256(tokenizer_path) != TOKENIZER_SHA256:
                raise ProtocolError("invalid-config", "Local embedding model fingerprint does not match.")
            try:
                import numpy
                import onnxruntime
                from tokenizers import Tokenizer
            except ImportError as error:
                raise ProtocolError("invalid-config", "Local embedding runtime is unavailable.") from error

            options = onnxruntime.SessionOptions()
            options.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
            options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
            options.inter_op_num_threads = 1
            options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
            try:
                session = onnxruntime.InferenceSession(
                    str(model_path),
                    sess_options=options,
                    providers=["CPUExecutionProvider"],
                )
                tokenizer = Tokenizer.from_file(str(tokenizer_path))
                tokenizer.enable_truncation(max_length=512)
                tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
            except Exception as error:
                raise ProtocolError("invalid-config", "Local embedding model could not be loaded.") from error

            input_names = frozenset(item.name for item in session.get_inputs())
            if not {"input_ids", "attention_mask"}.issubset(input_names):
                raise ProtocolError("invalid-config", "Local embedding model inputs are incompatible.")
            self._numpy = numpy
            self._onnxruntime = onnxruntime
            self._tokenizer = tokenizer
            self._session = session
            self._input_names = input_names

    def _embed_sync(self, texts: list[str], run_options: Any) -> list[list[float]]:
        self._load()
        if self._session is None or self._tokenizer is None or self._numpy is None:
            raise ProtocolError("unavailable", "Local embedding runtime is unavailable.")
        with self._run_lock:
            encodings = self._tokenizer.encode_batch(texts)
            numpy = self._numpy
            feed: dict[str, Any] = {
                "input_ids": numpy.asarray([encoding.ids for encoding in encodings], dtype=numpy.int64),
                "attention_mask": numpy.asarray(
                    [encoding.attention_mask for encoding in encodings], dtype=numpy.int64
                ),
            }
            if "token_type_ids" in self._input_names:
                feed["token_type_ids"] = numpy.asarray(
                    [encoding.type_ids for encoding in encodings], dtype=numpy.int64
                )
            try:
                hidden_state = self._session.run(["last_hidden_state"], feed, run_options)[0]
            except Exception as error:
                if bool(getattr(run_options, "terminate", False)):
                    raise asyncio.CancelledError from error
                raise ProtocolError("unavailable", "Local embedding inference failed.") from error
            vectors = numpy.asarray(hidden_state[:, 0, :], dtype=numpy.float32)
            if vectors.ndim != 2 or vectors.shape != (len(texts), EMBEDDING_DIMENSION):
                raise ProtocolError("index-dirty", "Local embedding output has an invalid shape.")
            norms = numpy.linalg.norm(vectors, axis=1, keepdims=True)
            if not numpy.isfinite(vectors).all() or not numpy.isfinite(norms).all() or (norms <= 0).any():
                raise ProtocolError("index-dirty", "Local embedding output contains invalid values.")
            vectors = vectors / norms
            result = vectors.astype("<f4", copy=False).tolist()
            if any(
                len(vector) != EMBEDDING_DIMENSION
                or any(not math.isfinite(float(value)) for value in vector)
                for vector in result
            ):
                raise ProtocolError("index-dirty", "Local embedding output is invalid.")
            return result

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts or len(texts) > 32 or any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ProtocolError("invalid-request", "Embedding input is invalid.")
        try:
            import onnxruntime
        except ImportError as error:
            raise ProtocolError("invalid-config", "Local embedding runtime is unavailable.") from error
        run_options = onnxruntime.RunOptions()
        operation = asyncio.create_task(asyncio.to_thread(self._embed_sync, list(texts), run_options))
        try:
            return await operation
        except asyncio.CancelledError:
            try:
                run_options.terminate = True
            except Exception:
                pass
            operation.cancel()
            raise


class BgeEmbeddingClient:
    """Minimal memU embedding client backed by the shared local runtime."""

    def __init__(self, runtime: BgeEmbeddingRuntime):
        self.runtime = runtime

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return await self.runtime.embed(texts)

    async def chat(self, *_args: object, **_kwargs: object) -> str:
        raise ProtocolError("invalid-config", "A memory normalization provider is not configured.")


_runtime: BgeEmbeddingRuntime | None = None
_runtime_root: Path | None = None


def get_embedding_runtime() -> BgeEmbeddingRuntime:
    global _runtime, _runtime_root
    raw_root = os.environ.get("DESKTOP_PET_MEMORY_MODEL_ROOT", "")
    if not raw_root:
        raise ProtocolError("invalid-config", "Local embedding model is not configured.")
    root = Path(raw_root)
    if not root.is_absolute() or root.is_symlink():
        raise ProtocolError("invalid-config", "Local embedding model root is invalid.")
    try:
        resolved = root.resolve(strict=True)
    except OSError as error:
        raise ProtocolError("invalid-config", "Local embedding model is unavailable.") from error
    if _runtime is None:
        _runtime = BgeEmbeddingRuntime(resolved)
        _runtime_root = resolved
    elif resolved != _runtime_root:
        raise ProtocolError("invalid-config", "Local embedding model root changed during runtime.")
    return _runtime


def embedding_runtime_loaded() -> bool:
    return bool(_runtime is not None and _runtime.loaded)
