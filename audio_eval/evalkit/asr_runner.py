"""Shared ASR runner contract for the standalone benchmark."""

from __future__ import annotations

import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .gate import Segment


@dataclass(frozen=True, slots=True)
class AsrOutput:
    raw_text: str
    cleaned_text: str
    segments: tuple[Segment, ...]
    latency_seconds: float


class AsrRunner(Protocol):
    load_seconds: float

    def configuration(self) -> dict[str, object]: ...

    def transcribe(self, audio_path: Path) -> AsrOutput: ...


def audio_duration_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as audio:
            return audio.getnframes() / max(audio.getframerate(), 1)
    except (wave.Error, EOFError):
        completed = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        if completed.returncode != 0:
            raise ValueError((completed.stderr or "无法读取音频时长").strip()) from None
        return float(completed.stdout.strip())
