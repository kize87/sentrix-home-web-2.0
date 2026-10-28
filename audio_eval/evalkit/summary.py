"""Aggregate sample results and render machine/human-readable reports."""

from __future__ import annotations

import math
import resource
import statistics
import sys
from collections.abc import Sequence
from typing import Any


def summarize(
    records: Sequence[dict[str, Any]],
    *,
    bad_cer_threshold: float,
    model_load_seconds: float,
) -> dict[str, Any]:
    succeeded = [row for row in records if not row.get("error")]
    failed = [row for row in records if row.get("error")]
    scored = [row for row in succeeded if row.get("cer") is not None]
    searchable = [row for row in scored if row.get("searchable")]
    bad = [row for row in scored if float(row["cer"]) > bad_cer_threshold]
    bad_searchable = [row for row in bad if row.get("searchable")]
    good = [row for row in scored if float(row["cer"]) <= bad_cer_threshold]
    good_searchable = [row for row in good if row.get("searchable")]

    total_reference = sum(int(row["reference_characters"]) for row in scored)
    total_edits = sum(int(row["edits"]) for row in scored)
    exact_matches = sum(bool(row.get("exact_match")) for row in scored)
    searchable_reference = sum(int(row["accepted_reference_characters"]) for row in searchable)
    searchable_edits = sum(int(row["accepted_edits"]) for row in searchable)
    total_duration = sum(float(row["duration_seconds"]) for row in succeeded)
    total_latency = sum(float(row["latency_seconds"]) for row in succeeded)
    latencies = [float(row["latency_seconds"]) for row in succeeded]
    rtfs = [float(row["rtf"]) for row in succeeded if row.get("rtf") is not None]

    segment_counts = {"accepted": 0, "uncertain": 0, "rejected": 0}
    reason_counts: dict[str, int] = {}
    for row in succeeded:
        for segment in row.get("segments", []):
            status = str(segment.get("quality_status") or "")
            if status in segment_counts:
                segment_counts[status] += 1
            for reason in segment.get("quality_reasons", []):
                reason_counts[str(reason)] = reason_counts.get(str(reason), 0) + 1

    return {
        "samples": {
            "total": len(records),
            "succeeded": len(succeeded),
            "failed": len(failed),
            "scored": len(scored),
            "searchable": len(searchable),
            "bad": len(bad),
            "bad_searchable": len(bad_searchable),
            "good": len(good),
            "good_searchable": len(good_searchable),
        },
        "quality": {
            "corpus_cer": _divide(total_edits, total_reference),
            "character_accuracy": (
                max(0.0, 1.0 - (total_edits / total_reference)) if total_reference else None
            ),
            "exact_match_rate": _divide(exact_matches, len(scored)),
            "mean_sample_cer": statistics.fmean(float(row["cer"]) for row in scored) if scored else None,
            "searchable_projection_cer": _divide(searchable_edits, searchable_reference),
            "bad_cer_threshold": bad_cer_threshold,
            "searchable_rate": _divide(len(searchable), len(scored)),
            "false_accept_rate_among_bad": _divide(len(bad_searchable), len(bad)),
            "pollution_rate_among_searchable": _divide(len(bad_searchable), len(searchable)),
            "good_sample_coverage": _divide(len(good_searchable), len(good)),
            "total_edits": total_edits,
            "total_reference_characters": total_reference,
        },
        "performance": {
            "model_load_seconds": model_load_seconds,
            "audio_seconds": total_duration,
            "inference_seconds": total_latency,
            "overall_rtf": _divide(total_latency, total_duration),
            "latency_p50_seconds": _percentile(latencies, 0.50),
            "latency_p95_seconds": _percentile(latencies, 0.95),
            "sample_rtf_p50": _percentile(rtfs, 0.50),
            "sample_rtf_p95": _percentile(rtfs, 0.95),
            "peak_rss_mb": peak_rss_mb(),
        },
        "gate": {
            "segment_counts": segment_counts,
            "reason_counts": dict(sorted(reason_counts.items())),
        },
    }


def render_markdown(
    summary: dict[str, Any],
    *,
    dataset: dict[str, object],
    model: dict[str, object],
    gate: dict[str, object],
) -> str:
    samples = summary["samples"]
    quality = summary["quality"]
    performance = summary["performance"]
    storage = summary.get("storage", {})
    resources = summary.get("resources", {})
    stage_snapshots = resources.get("stage_snapshots", {})
    asr_resources = stage_snapshots.get("asr_and_gate", {})
    storage_resources = stage_snapshots.get("sqlite_storage", {})
    storage_rss_delta = _positive_delta(storage_resources.get("rss_mb"), asr_resources.get("rss_mb"))
    storage_mps_delta = _positive_delta(
        storage_resources.get("mps_allocated_mb"), asr_resources.get("mps_allocated_mb")
    )
    storage_mlx_delta = _positive_delta(
        storage_resources.get("mlx_active_mb"), asr_resources.get("mlx_active_mb")
    )
    segment_counts = summary["gate"]["segment_counts"]
    reasons = summary["gate"]["reason_counts"]
    reason_rows = "\n".join(f"| `{key}` | {value} |" for key, value in reasons.items())
    if not reason_rows:
        reason_rows = "| — | 0 |"
    stored_rows = (
        f"{storage.get('transcription_rows', 0)} / "
        f"{storage.get('segment_rows', 0)} / "
        f"{storage.get('fts_rows', 0)}"
    )

    return f"""# 音频 ASR 与质量门禁评测

## 配置

- 数据集：`{dataset.get("manifest", "")}`
- 模型：`{model.get("model_name", "")}`
- 后端：`{model.get("backend", "")}`
- VAD：`{model.get("vad_model", "disabled") or "disabled"}`
- 标点：`{model.get("punc_model", "disabled") or "disabled"}`
- 运行库：`{_runtime_version(model)}`
- 设备：`{model.get("device", "")}`
- 门禁版本：`{gate.get("version", "")}`
- 明显错误阈值：CER > {_percent(quality["bad_cer_threshold"])}

## 结果

| 指标 | 结果 |
|---|---:|
| 样本数 | {samples["total"]} |
| 成功 / 失败 | {samples["succeeded"]} / {samples["failed"]} |
| Corpus CER | {_percent(quality["corpus_cer"])} |
| 字符准确率（1-CER） | {_percent(quality["character_accuracy"])} |
| 整句完全一致率 | {_percent(quality["exact_match_rate"])} |
| 平均样本 CER | {_percent(quality["mean_sample_cer"])} |
| 实际检索文本 CER | {_percent(quality["searchable_projection_cer"])} |
| 可进入检索比例 | {_percent(quality["searchable_rate"])} |
| 错误样本误放行率 | {_percent(quality["false_accept_rate_among_bad"])} |
| 检索文本污染率 | {_percent(quality["pollution_rate_among_searchable"])} |
| 正常样本覆盖率 | {_percent(quality["good_sample_coverage"])} |
| 总音频时长 | {_number(performance["audio_seconds"])} s |
| 总推理时间 | {_number(performance["inference_seconds"])} s |
| Overall RTF | {_number(performance["overall_rtf"], 4)} |
| P50 / P95 RTF | {_number(performance["sample_rtf_p50"], 4)} / {_number(performance["sample_rtf_p95"], 4)} |
| 模型加载时间 | {_number(performance["model_load_seconds"])} s |
| 进程历史峰值 RSS（ru_maxrss） | {_number(performance["peak_rss_mb"])} MB |

## 存储阶段

| 指标 | 结果 |
|---|---:|
| 写入成功 / 失败 | {storage.get("succeeded", 0)} / {storage.get("failed", 0)} |
| 写入完整性匹配率 | {_percent(storage.get("integrity_match_rate"))} |
| 存储总耗时 | {_number(storage.get("total_seconds"), 4)} s |
| 平均单条写入 | {_number(storage.get("mean_seconds"), 6)} s |
| 最慢单条写入 | {_number(storage.get("max_seconds"), 6)} s |
| SQLite 大小 | {_bytes(storage.get("database_bytes"))} |
| 转写 / 分段 / FTS 行数 | {stored_rows} |

## 资源占用

| 指标 | 结果 |
|---|---:|
| 实际加速设备 | `{resources.get("accelerator", "unknown")}` |
| 阶段快照峰值进程内存 | {_number(resources.get("peak_observed_rss_mb"))} MB |
| 观测峰值 MPS allocated | {_number(resources.get("peak_observed_mps_allocated_mb"))} MB |
| 观测峰值 MPS driver allocated | {_number(resources.get("peak_observed_mps_driver_mb"))} MB |
| ASR 阶段 MPS allocated | {_number(asr_resources.get("mps_allocated_mb"))} MB |
| ASR 阶段 MPS driver allocated | {_number(asr_resources.get("mps_driver_mb"))} MB |
| 观测峰值 MLX active | {_number(resources.get("peak_observed_mlx_active_mb"))} MB |
| 观测峰值 MLX cache | {_number(resources.get("peak_observed_mlx_cache_mb"))} MB |
| MLX 内部历史峰值 | {_number(resources.get("peak_observed_mlx_peak_mb"))} MB |
| ASR 阶段 MLX active | {_number(asr_resources.get("mlx_active_mb"))} MB |
| 存储阶段新增进程内存 | {_number(storage_rss_delta, 3)} MB |
| 存储阶段新增 MPS allocated | {_number(storage_mps_delta, 3)} MB |
| 存储阶段新增 MLX active | {_number(storage_mlx_delta, 3)} MB |

## 门禁分段

- accepted：{segment_counts["accepted"]}
- uncertain：{segment_counts["uncertain"]}
- rejected：{segment_counts["rejected"]}

| 原因 | 次数 |
|---|---:|
{reason_rows}

## 解释边界

- CER 去除了空格、标点和模型控制标签。
- “错误样本”只是由本次设置的 CER 阈值定义，不等同于人工质量结论。
- “可进入检索”表示至少一个片段被门禁放行；本评测不加载主项目向量模型。
- 没有声学分数的片段会记录 `no_acoustic_score`，当前门禁仍允许结构正常的文本通过。
"""


def _runtime_version(model: dict[str, object]) -> str:
    if model.get("backend") == "mlx_whisper":
        return f"mlx-whisper {model.get('mlx_whisper_version', '')} / MLX {model.get('mlx_version', '')}"
    return f"FunASR {model.get('funasr_version', '')}"


def peak_rss_mb() -> float:
    raw = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    bytes_value = raw if sys.platform == "darwin" else raw * 1024.0
    return round(bytes_value / (1024.0 * 1024.0), 2)


def _divide(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def _percentile(values: Sequence[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _percent(value: object) -> str:
    return "—" if value is None else f"{float(value) * 100:.2f}%"


def _number(value: object, digits: int = 2) -> str:
    return "—" if value is None else f"{float(value):.{digits}f}"


def _bytes(value: object) -> str:
    return "—" if value is None else f"{float(value) / (1024 * 1024):.2f} MB"


def _positive_delta(after: object, before: object) -> float | None:
    if after is None or before is None:
        return None
    return max(0.0, float(after) - float(before))
