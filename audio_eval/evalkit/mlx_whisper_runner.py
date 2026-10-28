"""MLX Whisper backend for Apple Silicon benchmark runs."""

from __future__ import annotations

import importlib.metadata
import math
import time
from pathlib import Path
from typing import Any, Callable

from .asr_runner import AsrOutput, audio_duration_seconds
from .gate import Segment
from .text_metrics import clean_asr_text


class MlxWhisperRunner:
    """Load one MLX Whisper model once, then transcribe files sequentially."""

    def __init__(self, *, model_name: str, language: str) -> None:
        try:
            import mlx.core as mx
            import mlx_whisper
            from mlx_whisper.transcribe import ModelHolder
            from opencc import OpenCC
        except ImportError as error:
            raise RuntimeError(
                "MLX Whisper 未安装，请在 Apple Silicon 上安装 audio_eval/requirements.txt"
            ) from error

        self.model_name = model_name
        self.language = language
        self.device = "mlx"
        self.mlx_version = _package_version("mlx")
        self.mlx_whisper_version = _package_version("mlx-whisper")
        self._mx = mx
        self._transcribe = mlx_whisper.transcribe
        self._simplify = OpenCC("t2s").convert

        started = time.perf_counter()
        ModelHolder.get_model(model_name, mx.float16)
        mx.synchronize()
        self.load_seconds = time.perf_counter() - started

    def configuration(self) -> dict[str, object]:
        return {
            "backend": "mlx_whisper",
            "model_name": self.model_name,
            "vad_model": "native_no_speech",
            "punc_model": "native",
            "device": self.device,
            "language": self.language,
            "temperature": 0.0,
            "condition_on_previous_text": False,
            "text_normalization": "opencc_t2s",
            "mlx_version": self.mlx_version,
            "mlx_whisper_version": self.mlx_whisper_version,
        }

    def transcribe(self, audio_path: Path) -> AsrOutput:
        started = time.perf_counter()
        result = self._transcribe(
            str(audio_path),
            path_or_hf_repo=self.model_name,
            language=self.language,
            task="transcribe",
            temperature=0.0,
            condition_on_previous_text=False,
            verbose=None,
        )
        self._mx.synchronize()
        latency = time.perf_counter() - started
        if not isinstance(result, dict):
            raise RuntimeError("MLX Whisper 未返回字典结果")

        raw_text = str(result.get("text") or "")
        segments = _segments(
            result,
            audio_duration_seconds(audio_path),
            simplify=self._simplify,
        )
        return AsrOutput(
            raw_text=raw_text,
            cleaned_text=clean_asr_text(self._simplify(raw_text)),
            segments=segments,
            latency_seconds=latency,
        )


def _segments(
    result: dict[str, Any],
    duration_seconds: float,
    *,
    simplify: Callable[[str], str] | None = None,
) -> tuple[Segment, ...]:
    normalize_script = simplify or (lambda value: value)
    rows: list[Segment] = []
    values = result.get("segments") or []
    if isinstance(values, list):
        for item in values:
            if not isinstance(item, dict):
                continue
            text = normalize_script(str(item.get("text") or ""))
            if not clean_asr_text(text):
                continue
            rows.append(
                Segment(
                    start_ms=max(0, round(_float(item.get("start"), 0.0) * 1000)),
                    end_ms=max(1, round(_float(item.get("end"), duration_seconds) * 1000)),
                    text=text,
                    confidence_raw=_token_confidence(item.get("avg_logprob")),
                    speech_probability=_speech_probability(item.get("no_speech_prob")),
                )
            )
    if not rows:
        text = normalize_script(str(result.get("text") or ""))
        if clean_asr_text(text):
            rows.append(
                Segment(
                    start_ms=0,
                    end_ms=max(1, round(duration_seconds * 1000)),
                    text=text,
                )
            )
    return tuple(rows)


def _token_confidence(value: object) -> float | None:
    parsed = _optional_float(value)
    if parsed is None:
        return None
    return min(1.0, max(0.0, math.exp(parsed)))


def _speech_probability(value: object) -> float | None:
    parsed = _optional_float(value)
    if parsed is None:
        return None
    return min(1.0, max(0.0, 1.0 - parsed))


def _optional_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(str(value))
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def _float(value: object, default: float) -> float:
    parsed = _optional_float(value)
    return default if parsed is None else parsed


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"
