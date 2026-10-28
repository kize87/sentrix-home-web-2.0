#!/usr/bin/env python3
"""Build an evaluation manifest from the official FLEURS TSV/audio archive."""

from __future__ import annotations

import argparse
import csv
import json
import random
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从 FLEURS 原始 TSV 和音频目录生成评测清单")
    parser.add_argument("--tsv", type=Path, required=True)
    parser.add_argument("--audio-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=100, help="0 表示使用全部样本")
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    tsv_path = args.tsv.expanduser().resolve()
    audio_dir = args.audio_dir.expanduser().resolve()
    output = args.output.expanduser().resolve()

    rows = _read_rows(tsv_path, audio_dir)
    random.Random(args.seed).shuffle(rows)
    if args.limit > 0:
        rows = rows[: args.limit]
    output.mkdir(parents=True, exist_ok=True)

    manifest_path = output / "manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as target:
        for order, row in enumerate(rows):
            target.write(json.dumps({**row, "sample_order": order}, ensure_ascii=False) + "\n")

    metadata = {
        "dataset": "google/fleurs",
        "config": "cmn_hans_cn",
        "split": "test",
        "source_tsv": str(tsv_path),
        "source_audio_dir": str(audio_dir),
        "sample_count": len(rows),
        "seed": args.seed,
        "manifest": str(manifest_path),
    }
    (output / "dataset.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已生成 {len(rows)} 条：{manifest_path}")
    return 0


def _read_rows(tsv_path: Path, audio_dir: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    with tsv_path.open(encoding="utf-8", newline="") as source:
        for line_number, columns in enumerate(csv.reader(source, delimiter="\t"), start=1):
            if len(columns) != 7:
                raise ValueError(f"TSV 第 {line_number} 行应有 7 列，实际为 {len(columns)}")
            sentence_id, file_name, transcription = columns[:3]
            audio_path = (audio_dir / file_name).resolve()
            if not audio_path.is_file():
                raise FileNotFoundError(f"TSV 第 {line_number} 行音频不存在：{audio_path}")
            rows.append(
                {
                    "id": Path(file_name).stem,
                    "audio": str(audio_path),
                    "text": transcription,
                    "sentence_id": sentence_id,
                }
            )
    return rows


if __name__ == "__main__":
    raise SystemExit(main())
