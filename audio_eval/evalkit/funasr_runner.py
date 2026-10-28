"""Local FunASR runner used only by the standalone benchmark."""

from __future__ import annotations

import importlib.metadata
import time
from pathlib import Path
from typing import Any

from .asr_runner import AsrOutput, audio_duration_seconds
from .gate import Segment
from .text_metrics import clean_asr_text

class FunAsrRunner:
    """Load one model once, then transcribe files sequentially."""

    def __init__(
        self,
        *,
        model_name: str,
        vad_model: str,
        punc_model: str,
        device: str,
        batch_size_s: int,
    ) -> None:
        try:
            from funasr import AutoModel
        except ImportError as error:
            raise RuntimeError("FunASR 未安装，请先安装 audio_eval/requirements.txt") from error

        self.model_name = model_name
        self.vad_model = vad_model
        self.punc_model = punc_model
        self.device = device
        self.batch_size_s = batch_size_s
        self.funasr_version = _package_version("funasr")
        started = time.perf_counter()
        self._model = AutoModel(
            model=model_name,
            vad_model=vad_model or None,
            punc_model=punc_model or None,
            device=device,
        )
        self.load_seconds = time.perf_counter() - started

    def configuration(self) -> dict[str, object]:
        return {
            "backend": "local_funasr",
            "model_name": self.model_name,
            "vad_model": self.vad_model,
            "punc_model": self.punc_model,
            "device": self.device,
            "batch_size_s": self.batch_size_s,
            "funasr_version": self.funasr_version,
        }

    def transcribe(self, audio_path: Path) -> AsrOutput:
        started = time.perf_counter()
        generated = self._model.generate(input=str(audio_path), batch_size_s=self.batch_size_s)
        latency = time.perf_counter() - started
        if not generated or not isinstance(generated[0], dict):
            raise RuntimeError("FunASR 未返回字典结果")
        first: dict[str, Any] = generated[0]
        raw_text = str(first.get("text") or "")
        segments = _segments(first, audio_duration_seconds(audio_path))
        return AsrOutput(
            raw_text=raw_text,
            cleaned_text=clean_asr_text(raw_text),
            segments=segments,
            latency_seconds=latency,
        )


def _segments(result: dict[str, Any], duration_seconds: float) -> tuple[Segment, ...]:
    rows: list[Segment] = []
    sentence_info = result.get("sentence_info") or []
    if isinstance(sentence_info, list):
        for item in sentence_info:
            if not isinstance(item, dict):
                continue
            rows.append(
                Segment(
                    start_ms=_safe_int(item.get("start")),
                    end_ms=_safe_int(item.get("end")),
                    text=str(item.get("text") or item.get("sentence") or ""),
                    confidence_raw=_first_float(item, "confidence", "score"),
                    alignment_score=_first_float(item, "alignment_score"),
                    speech_probability=_first_float(item, "speech_probability"),
                    language_probability=_first_float(item, "language_probability"),
                )
            )
    if not rows:
        text = str(result.get("text") or "")
        if clean_asr_text(text):
            rows.append(
                Segment(
                    start_ms=0,
                    end_ms=max(1, round(duration_seconds * 1000)),
                    text=text,
                )
            )
    return tuple(rows)


def _safe_int(value: object) -> int:
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return 0


def _first_float(item: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = item.get(key)
        if value is None or value == "":
            continue
        try:
            return float(str(value))
        except ValueError:
            return None
    return None


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"
