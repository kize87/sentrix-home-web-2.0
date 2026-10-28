#!/usr/bin/env python3
"""Export a deterministic Hugging Face subset to WAV + JSONL manifest."""

from __future__ import annotations

import argparse
import io
import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="准备 Hugging Face 音频评测子集")
    parser.add_argument("--dataset", required=True, help="HF 数据集名称、本地下载目录或 Parquet 文件")
    parser.add_argument("--config", default="", help="例如 FLEURS 的 cmn_hans_cn")
    parser.add_argument("--split", default="test")
    parser.add_argument("--audio-column", default="audio")
    parser.add_argument("--text-column", default="transcription")
    parser.add_argument("--id-column", default="id")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        from datasets import Audio, Dataset, DatasetDict, load_dataset, load_from_disk
    except ImportError as error:
        raise SystemExit("缺少 datasets，请安装 requirements.txt") from error

    source = Path(args.dataset).expanduser()
    is_saved_dataset = source.exists() and any(
        (source / marker).exists() for marker in ("dataset_dict.json", "state.json")
    )
    if is_saved_dataset:
        loaded = load_from_disk(str(source))
        dataset = loaded[args.split] if isinstance(loaded, DatasetDict) else loaded
    elif source.is_file() and source.suffix.lower() == ".parquet":
        dataset = load_dataset("parquet", data_files={args.split: str(source)}, split=args.split)
    else:
        dataset = load_dataset(
            str(source.resolve()) if source.exists() else args.dataset,
            args.config or None,
            split=args.split,
        )
    if not isinstance(dataset, Dataset):
        raise SystemExit(f"没有得到 Dataset，实际类型：{type(dataset).__name__}")
    for column in (args.audio_column, args.text_column):
        if column not in dataset.column_names:
            raise SystemExit(f"数据集缺少列 {column!r}；现有列：{dataset.column_names}")

    # decode=False 避免评测环境依赖 torchcodec；音频字节交给 soundfile 解码。
    dataset = dataset.cast_column(args.audio_column, Audio(decode=False))
    take = min(max(args.limit, 0), len(dataset))
    dataset = dataset.shuffle(seed=args.seed).select(range(take))

    output = args.output.expanduser().resolve()
    audio_dir = output / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as manifest:
        for index, row in enumerate(dataset):
            sample_id = _safe_id(str(row.get(args.id_column) or f"sample-{index:05d}"))
            target = audio_dir / f"{index:05d}-{sample_id}.wav"
            _write_normalized_wav(row[args.audio_column], target)
            record = {
                "id": sample_id,
                "audio": str(target),
                "text": str(row.get(args.text_column) or ""),
                "sample_order": int(index),
            }
            manifest.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(f"[{index + 1}/{take}] {target.name}")

    metadata = {
        "dataset": args.dataset,
        "config": args.config,
        "split": args.split,
        "limit": take,
        "seed": args.seed,
        "audio_column": args.audio_column,
        "text_column": args.text_column,
        "manifest": str(manifest_path),
    }
    (output / "dataset.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已生成：{manifest_path}")
    return 0


def _write_normalized_wav(audio: Any, target: Path) -> None:
    try:
        import soundfile as sf
    except ImportError as error:
        raise RuntimeError("缺少 soundfile，请安装 requirements.txt") from error

    if not isinstance(audio, dict):
        raise ValueError(f"audio 列不是 decode=False 的字典：{type(audio).__name__}")
    source_path = audio.get("path")
    source_bytes = audio.get("bytes")
    if source_bytes is not None:
        samples, sample_rate = sf.read(io.BytesIO(source_bytes), dtype="float32", always_2d=True)
    elif source_path:
        samples, sample_rate = sf.read(str(source_path), dtype="float32", always_2d=True)
    else:
        raise ValueError("audio 行既没有 path 也没有 bytes")

    # 先写一个按原采样率解码的临时 WAV，再用 ffmpeg 做与生产一致的 16k/mono 规范化。
    with tempfile.NamedTemporaryFile(prefix="audio-eval-", suffix=".wav") as temporary:
        sf.write(temporary.name, samples, int(sample_rate), subtype="PCM_16")
        completed = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                temporary.name,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(target),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or "ffmpeg normalization failed").strip())


def _safe_id(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z._-]+", "-", value).strip("-.")
    return (cleaned or "sample")[:80]


if __name__ == "__main__":
    raise SystemExit(main())
