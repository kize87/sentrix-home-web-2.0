"""faster-whisper backend for CTranslate2 Whisper benchmarks."""

from __future__ import annotations

import importlib.metadata
import math
import time
from pathlib import Path
from typing import Any, Callable, Iterable

from .asr_runner import AsrOutput
from .gate import Segment
from .text_metrics import clean_asr_text


class FasterWhisperRunner:
    """Load one CTranslate2 model once, then transcribe files sequentially."""

    def __init__(
        self,
        *,
        model_name: str,
        language: str,
        device: str,
        compute_type: str,
    ) -> None:
        try:
            from faster_whisper import WhisperModel
            from opencc import OpenCC
        except ImportError as error:
            raise RuntimeError(
                "faster-whisper 未安装，请安装 audio_eval/requirements.txt"
            ) from error

        self.model_name = model_name
        self.language = language
        self.device = device
        self.compute_type = compute_type
        self.faster_whisper_version = _package_version("faster-whisper")
        self.ctranslate2_version = _package_version("ctranslate2")
        self._simplify = OpenCC("t2s").convert

        started = time.perf_counter()
        self._model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
        )
        self.load_seconds = time.perf_counter() - started

    def configuration(self) -> dict[str, object]:
        return {
            "backend": "faster_whisper",
            "model_name": self.model_name,
            "vad_model": "silero_vad",
            "punc_model": "native",
            "device": self.device,
            "compute_type": self.compute_type,
            "language": self.language,
            "beam_size": 5,
            "temperature": 0.0,
            "condition_on_previous_text": False,
            "text_normalization": "opencc_t2s",
            "faster_whisper_version": self.faster_whisper_version,
            "ctranslate2_version": self.ctranslate2_version,
        }

    def transcribe(self, audio_path: Path) -> AsrOutput:
        started = time.perf_counter()
        values, _ = self._model.transcribe(
            str(audio_path),
            language=self.language or None,
            task="transcribe",
            beam_size=5,
            temperature=0.0,
            vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        segment_values = list(values)
        raw_text = " ".join(
            str(getattr(item, "text", "") or "").strip()
            for item in segment_values
            if str(getattr(item, "text", "") or "").strip()
        ).strip()
        rows = _segments(segment_values, simplify=self._simplify)
        latency = time.perf_counter() - started
        cleaned_text = clean_asr_text(self._simplify(raw_text))
        return AsrOutput(
            raw_text=raw_text,
            cleaned_text=cleaned_text,
            segments=rows,
            latency_seconds=latency,
        )


def _segments(
    values: Iterable[Any],
    *,
    simplify: Callable[[str], str] | None = None,
) -> tuple[Segment, ...]:
    normalize_script = simplify or (lambda value: value)
    rows: list[Segment] = []
    for item in values:
        text = normalize_script(str(getattr(item, "text", "") or ""))
        if not clean_asr_text(text):
            continue
        rows.append(
            Segment(
                start_ms=max(0, round(_float(getattr(item, "start", None), 0.0) * 1000)),
                end_ms=max(1, round(_float(getattr(item, "end", None), 0.001) * 1000)),
                text=text,
                confidence_raw=_token_confidence(getattr(item, "avg_logprob", None)),
                speech_probability=_speech_probability(
                    getattr(item, "no_speech_prob", None)
                ),
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
