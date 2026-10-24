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
