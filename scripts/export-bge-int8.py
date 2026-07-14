from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path


MODEL_ID = "BAAI/bge-small-zh-v1.5"
MODEL_REVISION = "7999e1d3359715c523056ef9478215996d62a620"
EXPECTED_SOURCE_HASHES = {
    "config.json": "3853a7979202c348751b753e36f579c41d8da7d36af617d3d907e1fc9b441f2a",
    "model.safetensors": "354763b9b1357bc9c44f62c6be2276321081ed2567773608c0d0785b61d5a026",
    "special_tokens_map.json": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    "tokenizer.json": "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
    "tokenizer_config.json": "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a",
    "vocab.txt": "45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c",
}
TOKENIZER_FILES = (
    "config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def require_safe_directory(path: Path, label: str) -> Path:
    if not path.is_absolute():
        raise RuntimeError(f"{label} must be absolute")
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError(f"{label} must be an existing non-symlink directory")
    return path.resolve(strict=True)


def verify_sources(source_root: Path) -> None:
    for relative_name, expected_hash in EXPECTED_SOURCE_HASHES.items():
        source = source_root / relative_name
        if source.is_symlink() or not source.is_file() or sha256(source) != expected_hash:
            raise RuntimeError(f"official model source failed verification: {relative_name}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export the pinned official BAAI BGE weights to a local INT8 ONNX model."
    )
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--export-site-packages", type=Path, required=True)
    parser.add_argument("--runtime-site-packages", type=Path, required=True)
    args = parser.parse_args()

    source_root = require_safe_directory(args.source_root, "source root")
    export_site = require_safe_directory(args.export_site_packages, "export site-packages")
    runtime_site = require_safe_directory(args.runtime_site_packages, "runtime site-packages")
    output_root = args.output_root.resolve()
    if output_root.is_symlink():
        raise RuntimeError("output root must not be a symlink")
    output_root.mkdir(parents=True, exist_ok=True)
    verify_sources(source_root)

    # The pinned export stack uses tokenizers 0.22.x while the production
    # runtime uses 0.23.x. Keep exporter packages first for Transformers and
    # append the runtime root only to provide ONNX Runtime quantization.
    sys.path[:0] = [str(export_site), str(runtime_site)]
    import numpy
    import onnx
    import onnxruntime
    import torch
    import transformers
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from transformers import AutoModel

    class LastHiddenState(torch.nn.Module):
        def __init__(self, model: torch.nn.Module):
            super().__init__()
            self.model = model

        def forward(
            self,
            input_ids: torch.Tensor,
            attention_mask: torch.Tensor,
            token_type_ids: torch.Tensor,
        ) -> torch.Tensor:
            return self.model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                token_type_ids=token_type_ids,
                return_dict=False,
            )[0]

    fp32_path = output_root / "model.fp32.onnx"
    model_path = output_root / "onnx" / "model_int8.onnx"
    model_path.parent.mkdir(parents=True, exist_ok=True)
    model = AutoModel.from_pretrained(source_root, local_files_only=True).eval()
    wrapper = LastHiddenState(model).eval()
    sample = torch.tensor([[101, 2769, 4263, 6887, 102]], dtype=torch.long)
    attention = torch.ones_like(sample)
    token_types = torch.zeros_like(sample)
    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            (sample, attention, token_types),
            fp32_path,
            input_names=["input_ids", "attention_mask", "token_type_ids"],
            output_names=["last_hidden_state"],
            dynamic_axes={
                "input_ids": {0: "batch", 1: "sequence"},
                "attention_mask": {0: "batch", 1: "sequence"},
                "token_type_ids": {0: "batch", 1: "sequence"},
                "last_hidden_state": {0: "batch", 1: "sequence"},
            },
            opset_version=17,
            do_constant_folding=True,
            dynamo=False,
        )
    onnx.checker.check_model(onnx.load(fp32_path))
    quantize_dynamic(
        fp32_path,
        model_path,
        per_channel=True,
        reduce_range=True,
        weight_type=QuantType.QInt8,
    )
    fp32_path.unlink()

    session = onnxruntime.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_names = sorted(item.name for item in session.get_inputs())
    if input_names != ["attention_mask", "input_ids", "token_type_ids"]:
        raise RuntimeError("exported model inputs are incompatible")
    result = session.run(
        ["last_hidden_state"],
        {
            "input_ids": sample.numpy(),
            "attention_mask": attention.numpy(),
            "token_type_ids": token_types.numpy(),
        },
    )[0]
    if result.shape != (1, 5, 512) or result.dtype != numpy.float32 or not numpy.isfinite(result).all():
        raise RuntimeError("exported model output is incompatible")

    for name in TOKENIZER_FILES:
        shutil.copy2(source_root / name, output_root / name)

    manifest = {
        "schemaVersion": 1,
        "source": {
            "modelId": MODEL_ID,
            "revision": MODEL_REVISION,
            "declaredLicense": "MIT",
            "files": {
                name: {"bytes": (source_root / name).stat().st_size, "sha256": digest}
                for name, digest in sorted(EXPECTED_SOURCE_HASHES.items())
            },
        },
        "conversion": {
            "producer": "desktop-pet-memory-sidecar",
            "quantization": "QInt8-per-channel-reduced-range",
            "opset": 17,
            "pooling": "CLS",
            "normalization": "L2 at runtime",
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "onnx": onnx.__version__,
            "onnxruntime": onnxruntime.__version__,
        },
        "output": {
            "path": "onnx/model_int8.onnx",
            "bytes": model_path.stat().st_size,
            "sha256": sha256(model_path),
            "tokenizerSha256": sha256(output_root / "tokenizer.json"),
            "dimension": 512,
            "dtype": "float32",
        },
    }
    (output_root / "asset-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest["output"], separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
