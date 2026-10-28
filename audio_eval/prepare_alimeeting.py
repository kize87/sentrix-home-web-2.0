#!/usr/bin/env python3
"""Parse AliMeeting TextGrid labels and create sentence-level mono WAV clips."""

from __future__ import annotations

import argparse
import json
import random
import re
from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

from evalkit.text_metrics import normalize_for_cer


_ITEM_RE = re.compile(r"^\s*item \[\d+\]:\s*$")
_INTERVAL_RE = re.compile(r"^\s*intervals \[\d+\]:\s*$")
_FIELD_RE = re.compile(r'^\s*(name|xmin|xmax|text)\s*=\s*(.*?)\s*$')


@dataclass(frozen=True, slots=True)
class Annotation:
    source_audio: Path
    textgrid: Path
    speaker: str
    interval_index: int
    start_seconds: float
    end_seconds: float
    text: str
    overlap_seconds: float = 0.0

    @property
    def duration_seconds(self) -> float:
        return self.end_seconds - self.start_seconds

    @property
    def overlap_ratio(self) -> float:
        return self.overlap_seconds / self.duration_seconds if self.duration_seconds > 0 else 0.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从 AliMeeting TextGrid 生成句子级评测音频")
    parser.add_argument("--dataset-root", type=Path, required=True, help="包含 Eval_Ali_far/near 的目录")
    parser.add_argument("--track", choices=("far", "near"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=100, help="0 表示使用所有合格片段")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--channel", type=int, default=0, help="远场阵列选择的零基声道序号")
    parser.add_argument("--min-duration", type=float, default=1.0)
    parser.add_argument("--max-duration", type=float, default=20.0)
    parser.add_argument("--min-chars", type=int, default=4)
    parser.add_argument(
        "--max-overlap-ratio",
        type=float,
        default=1.0,
        help="远场片段允许与其他说话人重叠的最大比例；0 表示严格无重叠",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dataset_root = args.dataset_root.expanduser().resolve()
    output = args.output.expanduser().resolve()
    annotations = collect_annotations(dataset_root, args.track)
    eligible = [
        row
        for row in annotations
        if args.min_duration <= row.duration_seconds <= args.max_duration
        and len(normalize_for_cer(row.text)) >= args.min_chars
        and row.overlap_ratio <= args.max_overlap_ratio
    ]
    selected = stratified_sample(eligible, limit=args.limit, seed=args.seed)
    if not selected:
        raise SystemExit("没有符合过滤条件的 AliMeeting 标注")

    clips_dir = output / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as target:
        for order, annotation in enumerate(selected):
            clip_id = _clip_id(args.track, annotation)
            clip_path = (clips_dir / f"{clip_id}.wav").resolve()
            clip_metadata = extract_mono_clip(
                annotation.source_audio,
                clip_path,
                start_seconds=annotation.start_seconds,
                end_seconds=annotation.end_seconds,
                channel=args.channel if args.track == "far" else 0,
            )
            row = {
                "id": clip_id,
                "audio": str(clip_path),
                "text": annotation.text,
                "track": args.track,
                "speaker": annotation.speaker,
                "source_audio": str(annotation.source_audio),
                "textgrid": str(annotation.textgrid),
                "interval_index": annotation.interval_index,
                "start_seconds": annotation.start_seconds,
                "end_seconds": annotation.end_seconds,
                "overlap_seconds": annotation.overlap_seconds,
                "overlap_ratio": annotation.overlap_ratio,
                "sample_order": order,
                **clip_metadata,
            }
            target.write(json.dumps(row, ensure_ascii=False) + "\n")

    metadata = {
        "dataset": "AliMeeting",
        "split": "Eval_Ali",
        "track": args.track,
        "dataset_root": str(dataset_root),
        "source_annotation_count": len(annotations),
        "eligible_annotation_count": len(eligible),
        "sample_count": len(selected),
        "source_audio_count": len({str(row.source_audio) for row in selected}),
        "speaker_count": len({row.speaker for row in selected}),
        "seed": args.seed,
        "channel": args.channel if args.track == "far" else 0,
        "filters": {
            "min_duration_seconds": args.min_duration,
            "max_duration_seconds": args.max_duration,
            "min_normalized_characters": args.min_chars,
            "max_overlap_ratio": args.max_overlap_ratio,
        },
        "manifest": str(manifest_path),
    }
    (output / "dataset.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        f"已生成 {len(selected)} 条 {args.track} 样本，"
        f"覆盖 {metadata['source_audio_count']} 个源音频：{manifest_path}"
    )
    return 0


def collect_annotations(dataset_root: Path, track: str) -> list[Annotation]:
    track_root = dataset_root / f"Eval_Ali_{track}"
    audio_dir = track_root / "audio_dir"
    textgrid_dir = track_root / "textgrid_dir"
    if not audio_dir.is_dir() or not textgrid_dir.is_dir():
        raise FileNotFoundError(f"AliMeeting {track} 目录不完整：{track_root}")

    rows: list[Annotation] = []
    for textgrid in sorted(textgrid_dir.glob("*.TextGrid")):
        if track == "far":
            matches = sorted(audio_dir.glob(f"{textgrid.stem}_MS*.wav"))
        else:
            matches = [audio_dir / f"{textgrid.stem}.wav"]
        if len(matches) != 1 or not matches[0].is_file():
            raise FileNotFoundError(f"无法唯一匹配 {textgrid.name} 的音频：{matches}")
        source_audio = matches[0].resolve()
        parsed = parse_textgrid(textgrid)
        for tier_name, interval_index, start, end, text in parsed:
            speaker = tier_name if track == "far" else _near_speaker(textgrid.stem)
            overlap_seconds = (
                _speaker_overlap_seconds(tier_name, start, end, parsed) if track == "far" else 0.0
            )
            rows.append(
                Annotation(
                    source_audio=source_audio,
                    textgrid=textgrid.resolve(),
                    speaker=speaker,
                    interval_index=interval_index,
                    start_seconds=start,
                    end_seconds=end,
                    text=text,
                    overlap_seconds=overlap_seconds,
                )
            )
    return rows


def parse_textgrid(path: Path) -> list[tuple[str, int, float, float, str]]:
    """Parse the long TextGrid format used by AliMeeting without third-party packages."""
    tier_name = "unknown"
    interval_index = 0
    current: dict[str, str] | None = None
    rows: list[tuple[str, int, float, float, str]] = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if _ITEM_RE.match(line):
            current = None
            continue
        if _INTERVAL_RE.match(line):
            interval_index += 1
            current = {}
            continue
        field = _FIELD_RE.match(line)
        if not field:
            continue
        key, raw_value = field.groups()
        if key == "name" and current is None:
            tier_name = _praat_string(raw_value)
        elif current is not None:
            current[key] = raw_value
            if key == "text":
                text = _praat_string(current.get("text", ""))
                if text:
                    rows.append(
                        (
                            tier_name,
                            interval_index,
                            float(current["xmin"]),
                            float(current["xmax"]),
                            text,
                        )
                    )
                current = None
    return rows


def stratified_sample(rows: list[Annotation], *, limit: int, seed: int) -> list[Annotation]:
    """Round-robin source files so every meeting/speaker is represented."""
    rng = random.Random(seed)
    groups: dict[str, list[Annotation]] = {}
    for row in rows:
        groups.setdefault(str(row.source_audio), []).append(row)
    keys = sorted(groups)
    rng.shuffle(keys)
    for key in keys:
        rng.shuffle(groups[key])

    selected: list[Annotation] = []
    while keys and (limit <= 0 or len(selected) < limit):
        next_keys: list[str] = []
        for key in keys:
            if limit > 0 and len(selected) >= limit:
                break
            group = groups[key]
            if group:
                selected.append(group.pop())
            if group:
                next_keys.append(key)
        keys = next_keys
    return selected


def _speaker_overlap_seconds(
    speaker: str,
    start: float,
    end: float,
    intervals: list[tuple[str, int, float, float, str]],
) -> float:
    """Return the union of time overlapped by other annotated speakers."""
    overlaps = sorted(
        (max(start, other_start), min(end, other_end))
        for other_speaker, _, other_start, other_end, _ in intervals
        if other_speaker != speaker and other_start < end and other_end > start
    )
    if not overlaps:
        return 0.0
    merged_total = 0.0
    current_start, current_end = overlaps[0]
    for overlap_start, overlap_end in overlaps[1:]:
        if overlap_start <= current_end:
            current_end = max(current_end, overlap_end)
        else:
            merged_total += current_end - current_start
            current_start, current_end = overlap_start, overlap_end
    return merged_total + current_end - current_start


def extract_mono_clip(
    source: Path,
    target: Path,
    *,
    start_seconds: float,
    end_seconds: float,
    channel: int,
) -> dict[str, int | float]:
    with sf.SoundFile(str(source), "r") as audio:
        channels = audio.channels
        sample_rate = audio.samplerate
        frame_count = len(audio)
        if not 0 <= channel < channels:
            raise ValueError(f"声道 {channel} 超出范围，{source.name} 只有 {channels} 个声道")
        if frame_count <= 0:
            raise ValueError(f"音频没有采样帧：{source}")
        start_frame = max(0, min(round(start_seconds * sample_rate), frame_count - 1))
        end_frame = min(max(round(end_seconds * sample_rate), start_frame + 1), frame_count)
        audio.seek(start_frame)
        interleaved = audio.read(end_frame - start_frame, dtype="int16", always_2d=True)

    mono = interleaved[:, channel]
    target.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(target), mono, sample_rate, format="WAV", subtype="PCM_16")
    return {
        "source_channels": channels,
        "selected_channel": channel,
        "sample_rate": sample_rate,
        "duration_seconds": len(mono) / sample_rate,
    }


def _praat_string(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        value = value[1:-1]
    return value.replace('""', '"').strip()


def _near_speaker(stem: str) -> str:
    marker = "_N_"
    return stem.split(marker, 1)[1] if marker in stem else stem


def _clip_id(track: str, annotation: Annotation) -> str:
    start_ms = round(annotation.start_seconds * 1000)
    end_ms = round(annotation.end_seconds * 1000)
    speaker = re.sub(r"[^A-Za-z0-9_-]", "_", annotation.speaker)
    return (
        f"{track}_{annotation.source_audio.stem}_{speaker}_"
        f"i{annotation.interval_index:04d}_{start_ms}-{end_ms}"
    )


if __name__ == "__main__":
    raise SystemExit(main())
