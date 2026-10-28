"""Standalone mirror of the first-version structural quality gate.

This module intentionally does not import the product. Its version and thresholds
are emitted into every report so results cannot be mistaken for another gate.
"""

from __future__ import annotations

import unicodedata
from dataclasses import asdict, dataclass
from enum import StrEnum

from .text_metrics import clean_asr_text

GATE_VERSION = "audio-gate-v1-eval-mirror"


class QualityStatus(StrEnum):
    ACCEPTED = "accepted"
    UNCERTAIN = "uncertain"
    REJECTED = "rejected"


@dataclass(frozen=True, slots=True)
class Segment:
    start_ms: int
    end_ms: int
    text: str
    confidence_raw: float | None = None
    alignment_score: float | None = None
    speech_probability: float | None = None
    language_probability: float | None = None


@dataclass(frozen=True, slots=True)
class SegmentDecision:
    status: QualityStatus
    normalized_text: str
    reasons: tuple[str, ...] = ()

    @property
    def searchable(self) -> bool:
        return self.status is QualityStatus.ACCEPTED


@dataclass(frozen=True, slots=True)
class GateResult:
    accepted_text: str
    decisions: tuple[SegmentDecision, ...]

    @property
    def searchable(self) -> bool:
        return bool(self.accepted_text)

    @property
    def status(self) -> str:
        if not self.decisions:
            return "empty"
        if any(item.status is QualityStatus.UNCERTAIN for item in self.decisions):
            return "review"
        if not self.searchable:
            return "rejected"
        return "accepted"


@dataclass(frozen=True, slots=True)
class AudioQualityGate:
    version: str = GATE_VERSION
    min_segment_ms: int = 300
    max_chars_per_second: float = 24.0
    max_invalid_ratio: float = 0.20
    max_repeated_ratio: float = 0.60
    min_confidence: float = 0.45
    min_alignment: float = 0.45
    min_speech_probability: float = 0.50
    min_language_probability: float = 0.50

    def configuration(self) -> dict[str, object]:
        return asdict(self)

    def evaluate(self, segments: tuple[Segment, ...]) -> GateResult:
        decisions = tuple(self.assess(segment) for segment in segments)
        accepted = " ".join(
            item.normalized_text for item in decisions if item.searchable and item.normalized_text
        ).strip()
        return GateResult(accepted_text=accepted, decisions=decisions)

    def assess(self, segment: Segment) -> SegmentDecision:
        text = clean_asr_text(segment.text)
        if not text:
            return SegmentDecision(QualityStatus.REJECTED, text, ("empty_text",))
        if segment.start_ms < 0 or segment.end_ms <= segment.start_ms:
            return SegmentDecision(QualityStatus.REJECTED, text, ("invalid_timing",))

        duration_ms = segment.end_ms - segment.start_ms
        hard: list[str] = []
        soft: list[str] = []
        if duration_ms < self.min_segment_ms:
            soft.append("segment_too_short")

        content = [char for char in text if not char.isspace() and not _is_punctuation(char)]
        if not content:
            return SegmentDecision(QualityStatus.REJECTED, text, ("punctuation_only",))
        invalid_ratio = sum(not _is_language_character(char) for char in content) / len(content)
        if invalid_ratio > 0.50:
            hard.append("mostly_invalid_characters")
        elif invalid_ratio > self.max_invalid_ratio:
            soft.append("many_invalid_characters")

        chars_per_second = len(content) / max(duration_ms / 1000.0, 0.001)
        if chars_per_second > self.max_chars_per_second * 2:
            hard.append("impossible_text_rate")
        elif chars_per_second > self.max_chars_per_second:
            soft.append("high_text_rate")

        repeated_ratio = _repeated_bigram_ratio("".join(content))
        if repeated_ratio > 0.85:
            hard.append("severe_repetition")
        elif repeated_ratio > self.max_repeated_ratio:
            soft.append("repeated_text")

        _score_reason(segment.confidence_raw, self.min_confidence, "low_confidence", soft)
        _score_reason(segment.alignment_score, self.min_alignment, "low_alignment", soft)
        _score_reason(
            segment.speech_probability,
            self.min_speech_probability,
            "low_speech_probability",
            soft,
        )
        _score_reason(
            segment.language_probability,
            self.min_language_probability,
            "language_mismatch",
            soft,
        )

        if hard:
            return SegmentDecision(QualityStatus.REJECTED, text, tuple(hard + soft))
        if soft:
            return SegmentDecision(QualityStatus.UNCERTAIN, text, tuple(soft))
        if all(
            value is None
            for value in (
                segment.confidence_raw,
                segment.alignment_score,
                segment.speech_probability,
                segment.language_probability,
            )
        ):
            return SegmentDecision(QualityStatus.ACCEPTED, text, ("no_acoustic_score",))
        return SegmentDecision(QualityStatus.ACCEPTED, text)


def _is_punctuation(char: str) -> bool:
    return unicodedata.category(char).startswith(("P", "S"))


def _is_language_character(char: str) -> bool:
    return unicodedata.category(char).startswith(("L", "N"))


def _repeated_bigram_ratio(text: str) -> float:
    if len(text) < 6:
        return 0.0
    bigrams = [text[index : index + 2] for index in range(len(text) - 1)]
    return 1.0 - (len(set(bigrams)) / len(bigrams))


def _score_reason(value: float | None, threshold: float, reason: str, reasons: list[str]) -> None:
    if value is not None and value < threshold:
        reasons.append(reason)
