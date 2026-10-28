"""ASR text cleanup and dependency-free character error rate."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

_CONTROL_TAG_RE = re.compile(r"<\s*\|[^<>]*?\|\s*>")
_SPACE_RE = re.compile(r"\s+")


def clean_asr_text(text: str) -> str:
    """Remove model control tags without semantically rewriting the transcript."""
    value = unicodedata.normalize("NFKC", str(text or ""))
    value = _CONTROL_TAG_RE.sub(" ", value)
    return _SPACE_RE.sub(" ", value).strip()


def normalize_for_cer(text: str) -> str:
    """NFKC + lowercase + keep letters/numbers only.

    Spaces and punctuation are excluded so the score measures recognition rather
    than punctuation restoration. Chinese characters remain one CER unit each.
    """
    cleaned = clean_asr_text(text).lower()
    return "".join(char for char in cleaned if unicodedata.category(char).startswith(("L", "N")))


def edit_distance(reference: str, hypothesis: str) -> int:
    """Levenshtein distance using O(min(m, n)) memory."""
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference
    previous = list(range(len(hypothesis) + 1))
    for row, ref_char in enumerate(reference, start=1):
        current = [row]
        for column, hyp_char in enumerate(hypothesis, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (ref_char != hyp_char),
                )
            )
        previous = current
    return previous[-1]


@dataclass(frozen=True, slots=True)
class CerCounts:
    edits: int
    reference_characters: int

    @property
    def rate(self) -> float | None:
        if self.reference_characters == 0:
            return None
        return self.edits / self.reference_characters


def cer_counts(reference: str, hypothesis: str) -> CerCounts:
    normalized_reference = normalize_for_cer(reference)
    normalized_hypothesis = normalize_for_cer(hypothesis)
    return CerCounts(
        edits=edit_distance(normalized_reference, normalized_hypothesis),
        reference_characters=len(normalized_reference),
    )
