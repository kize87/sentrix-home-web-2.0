#!/usr/bin/env python3
"""Run local ASR, quality gate, CER and resource evaluation."""

from __future__ import annotations

import argparse
import csv
import json
import platform
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from evalkit.asr_runner import AsrRunner, audio_duration_seconds
from evalkit.gate import AudioQualityGate
from evalkit.resources import ResourceTracker
from evalkit.runner_factory import create_runner
from evalkit.storage import TranscriptStore
from evalkit.summary import render_markdown, summarize
from evalkit.text_metrics import cer_counts, normalize_for_cer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="独立 ASR + 质量门禁评测")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--backend",
        choices=("funasr", "mlx-whisper", "faster-whisper", "transformers-asr"),
        default="funasr",
    )
    parser.add_argument("--model", default="paraformer-zh")
    parser.add_argument("--vad-model", default="fsmn-vad")
    parser.add_argument("--punc-model", default="ct-punc")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--language", default="zh", help="Whisper 识别语言")
    parser.add_argument(
        "--compute-type",
        default="int8",
        help="计算精度；CTranslate2 可用 int8，Transformers 可用 float32/float16/auto",
    )
    parser.add_argument("--batch-size-s", type=int, default=60)
    parser.add_argument("--limit", type=int, default=0, help="0 表示使用整个 manifest")
    parser.add_argument("--warmup", type=int, default=0, help="正式计时前重复跑前 N 条，不写结果")
    parser.add_argument(
        "--storage-db",
        type=Path,
        default=None,
        help="SQLite 输出路径；默认是 <output>/audio_memory.sqlite3",
    )
    parser.add_argument(
        "--bad-cer-threshold",
        type=float,
        default=0.20,
        help="CER 高于该值视作明显错误，用于计算门禁误放行率",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = args.manifest.expanduser().resolve()
    samples = _load_manifest(manifest_path)
    if args.limit > 0:
        samples = samples[: args.limit]
    if not samples:
        raise SystemExit("manifest 没有样本")

    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    gate = AudioQualityGate()
    resource_device = "mlx" if args.backend == "mlx-whisper" else args.device
    resources = ResourceTracker(resource_device)
    resources.sample("baseline")
    print(f"加载模型：{args.model} ({args.device})")
    runner = create_runner(
        backend=args.backend,
        model_name=args.model,
        vad_model=args.vad_model,
        punc_model=args.punc_model,
        device=args.device,
        batch_size_s=args.batch_size_s,
        language=args.language,
        compute_type=args.compute_type,
    )
    resources.sample("model_loaded")
    print(f"模型加载完成：{runner.load_seconds:.2f}s")

    for sample in samples[: max(args.warmup, 0)]:
        runner.transcribe(_audio_path(sample, manifest_path))

    records: list[dict[str, Any]] = []
    storage_path = (args.storage_db or (output / "audio_memory.sqlite3")).expanduser().resolve()
    store = TranscriptStore(storage_path)
    result_path = output / "results.jsonl"
    started = time.time()
    with result_path.open("w", encoding="utf-8") as sink:
        for index, sample in enumerate(samples):
            record = _evaluate_one(sample, manifest_path=manifest_path, runner=runner, gate=gate)
            resources.sample("asr_and_gate")
            if record.get("error"):
                record["storage_latency_seconds"] = None
                record["storage_error"] = "asr_failed"
            else:
                try:
                    record["storage_latency_seconds"] = round(store.write(record), 6)
                    record["storage_error"] = ""
                except Exception as error:  # noqa: BLE001 - 单条存储失败不能中断整批
                    record["storage_latency_seconds"] = None
                    record["storage_error"] = f"{type(error).__name__}: {error}"
            resources.sample("sqlite_storage")
            records.append(record)
            sink.write(json.dumps(record, ensure_ascii=False) + "\n")
            sink.flush()
            cer = "—" if record.get("cer") is None else f"{float(record['cer']) * 100:.1f}%"
            print(
                f"[{index + 1}/{len(samples)}] {record['id']} "
                f"CER={cer} gate={record.get('gate_status', 'error')} "
                f"RTF={record.get('rtf', '—')}"
            )

    storage_report = store.verify(records)
    storage_report["database_bytes"] = store.close()
    storage_latencies = [
        float(row["storage_latency_seconds"])
        for row in records
        if row.get("storage_latency_seconds") is not None
    ]
    storage_report["total_seconds"] = sum(storage_latencies)
    storage_report["mean_seconds"] = (
        sum(storage_latencies) / len(storage_latencies) if storage_latencies else None
    )
    storage_report["max_seconds"] = max(storage_latencies, default=None)
    resources.sample("finished")

    report = summarize(
        records,
        bad_cer_threshold=args.bad_cer_threshold,
        model_load_seconds=runner.load_seconds,
    )
    report["storage"] = storage_report
    report["resources"] = resources.summary()
    run_metadata = {
        "manifest": str(manifest_path),
        "started_at_unix": started,
        "finished_at_unix": time.time(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "sample_count": len(samples),
        "warmup": args.warmup,
    }
    payload = {
        "run": run_metadata,
        "model": runner.configuration(),
        "gate": gate.configuration(),
        "summary": report,
    }
    (output / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "report.md").write_text(
        render_markdown(
            report,
            dataset=run_metadata,
            model=runner.configuration(),
            gate=gate.configuration(),
        ),
        encoding="utf-8",
    )
    _write_csv(output / "results.csv", records)
    print(f"评测完成：{output / 'report.md'}")
    return 0


def _evaluate_one(
    sample: dict[str, Any],
    *,
    manifest_path: Path,
    runner: AsrRunner,
    gate: AudioQualityGate,
) -> dict[str, Any]:
    sample_id = str(sample.get("id") or "unknown")
    reference = str(sample.get("text") or "")
    audio_path = _audio_path(sample, manifest_path)
    base: dict[str, Any] = {
        "id": sample_id,
        "audio": str(audio_path),
        "reference": reference,
        "normalized_reference": normalize_for_cer(reference),
    }
    try:
        duration = audio_duration_seconds(audio_path)
        output = runner.transcribe(audio_path)
        gate_result = gate.evaluate(output.segments)
        counts = cer_counts(reference, output.cleaned_text)
        accepted_counts = cer_counts(reference, gate_result.accepted_text)
        segments = [
            {
                **asdict(source),
                "quality_status": decision.status.value,
                "quality_reasons": list(decision.reasons),
                "searchable": decision.searchable,
                "normalized_text": decision.normalized_text,
            }
            for source, decision in zip(output.segments, gate_result.decisions, strict=True)
        ]
        return {
            **base,
            "raw_hypothesis": output.raw_text,
            "hypothesis": output.cleaned_text,
            "normalized_hypothesis": normalize_for_cer(output.cleaned_text),
            "accepted_text": gate_result.accepted_text,
            "gate_status": gate_result.status,
            "searchable": gate_result.searchable,
            "edits": counts.edits,
            "reference_characters": counts.reference_characters,
            "cer": counts.rate,
            "exact_match": normalize_for_cer(reference) == normalize_for_cer(output.cleaned_text),
            "accepted_edits": accepted_counts.edits,
            "accepted_reference_characters": accepted_counts.reference_characters,
            "accepted_projection_cer": accepted_counts.rate,
            "duration_seconds": round(duration, 6),
            "latency_seconds": round(output.latency_seconds, 6),
            "rtf": round(output.latency_seconds / duration, 6) if duration > 0 else None,
            "segments": segments,
            "error": "",
        }
    except Exception as error:  # noqa: BLE001 - 单条失败不能中断整批评测
        return {
            **base,
            "raw_hypothesis": "",
            "hypothesis": "",
            "accepted_text": "",
            "gate_status": "error",
            "searchable": False,
            "cer": None,
            "exact_match": False,
            "segments": [],
            "error": f"{type(error).__name__}: {error}",
        }


def _load_manifest(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict) or not value.get("audio"):
                raise ValueError(f"manifest 第 {line_number} 行缺少 audio")
            rows.append(value)
    return rows


def _audio_path(sample: dict[str, Any], manifest_path: Path) -> Path:
    value = Path(str(sample["audio"])).expanduser()
    return value.resolve() if value.is_absolute() else (manifest_path.parent / value).resolve()


def _write_csv(path: Path, records: list[dict[str, Any]]) -> None:
    columns = [
        "id",
        "audio",
        "reference",
        "hypothesis",
        "accepted_text",
        "gate_status",
        "searchable",
        "cer",
        "accepted_projection_cer",
        "exact_match",
        "duration_seconds",
        "latency_seconds",
        "rtf",
        "storage_latency_seconds",
        "storage_error",
        "error",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


if __name__ == "__main__":
    raise SystemExit(main())
