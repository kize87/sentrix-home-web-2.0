"""Explicit equivalent task labels; raw QA and GT keep their original values."""

from __future__ import annotations

TASK_ALIASES = {
    "T1_media_retrieval": "T1_retrieve_media",
    "media_retrieval": "T1_retrieve_media",
    "媒体检索": "T1_retrieve_media",
    "fact_qa": "T2_fact_qa",
    "事实问答": "T2_fact_qa",
    "enumeration": "T3_enumeration",
    "统计枚举": "T3_enumeration",
    "event_summary": "T5_event_summary",
    "事件总结": "T5_event_summary",
    "行为判断": "behavior",
}


def category_value(dimension: str, value: str) -> str:
    return TASK_ALIASES.get(value, value) if dimension == "task_type" else value


# Content tasks and behavioral test scenarios are independent source annotations.
CONTENT_TYPES = {"T1_retrieve_media", "T2_fact_qa", "T3_enumeration", "T5_event_summary"}
SCENARIOS = {
    "multi_turn_clarify",
    "evidence_insufficient",
    "prompt_injection",
    "clarification",
    "unanswerable_fact",
}
QUALITY_DIMENSIONS = (
    "content_type",
    "angle",
    "difficulty",
    "answerability",
    "media_type",
    "conversation_type",
)


def content_types(tasks: list[str]) -> list[str]:
    values = list(
        dict.fromkeys(TASK_ALIASES.get(v, v) for v in tasks if TASK_ALIASES.get(v, v) in CONTENT_TYPES)
    )
    return values or ["unknown"]


def test_scenarios(forms: list[str]) -> list[str]:
    return list(dict.fromkeys(v for v in forms if v in SCENARIOS)) or ["unknown"]
