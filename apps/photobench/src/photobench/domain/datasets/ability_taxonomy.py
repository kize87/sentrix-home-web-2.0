"""Explicit system abilities, independent of behavior and legacy task labels."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

ABILITY_VERSION = "ability-2026.10.28-v1"
ABILITY_FAMILIES = {"P": "信息获取与感知", "R": "推理与计算", "S": "归纳与总结"}
ABILITIES = {
    "P1": "记录定位与筛选",
    "P2": "已记录信息读取",
    "P3": "视觉内容识别",
    "P4": "画面文字读取",
    "R1": "计数与去重统计",
    "R2": "数值运算",
    "R3": "比较与排序",
    "R4": "关系与时空推断",
    "S1": "场景综合描述",
    "S2": "单事件概括",
    "S3": "跨事件归纳",
    "S4": "过程与时间线整理",
}
BENCHMARK_GROUPS = {"ordinary": "普通能力题", "hallucination": "抗幻觉拒答", "injection": "注入防护"}
ABILITY_FIELDS = (
    "ability_taxonomy_version",
    "ability_primary_ids",
    "ability_supporting_ids",
    "benchmark_group",
    "dialogue_management",
    "classification_content_sha256",
)


def validate_abilities(row: Mapping[str, Any]) -> None:
    """Reject incomplete or contradictory versioned annotations at import time."""
    group = row.get("benchmark_group")
    if group not in BENCHMARK_GROUPS:
        raise ValueError("invalid benchmark_group")
    turns = row.get("conversation") or []
    for record in [row, *turns]:
        if record.get("ability_taxonomy_version") != ABILITY_VERSION:
            raise ValueError("unsupported ability_taxonomy_version")
        if record.get("benchmark_group") != group:
            raise ValueError("inconsistent benchmark_group")
        primary = record.get("ability_primary_ids")
        supporting = record.get("ability_supporting_ids", [])
        for values in (primary, supporting):
            if (
                not isinstance(values, list)
                or any(not isinstance(v, str) or v not in ABILITIES for v in values)
                or len(set(values)) != len(values)
            ):
                raise ValueError("invalid ability IDs")
        if set(primary) & set(supporting):
            raise ValueError("primary and supporting abilities overlap")
        if group != "ordinary" and primary:
            raise ValueError("safety groups must not contribute ordinary abilities")
        if record is not row and record.get("expected_action") == "clarify" and primary:
            raise ValueError("clarification turn has primary abilities")
        if group == "ordinary" and record.get("expected_action") != "clarify" and not primary:
            raise ValueError("ordinary answer has no primary ability")
    if turns and set(row["ability_primary_ids"]) != {
        v for turn in turns for v in turn["ability_primary_ids"]
    }:
        raise ValueError("question abilities differ from answering-turn union")


def ability_dimensions(record: Mapping[str, Any]) -> dict[str, list[str]]:
    """Project saved versioned facts only; missing history remains unknown."""
    unknown = {k: ["unknown"] for k in ("ability_family", "ability_type", "benchmark_group")}
    if record.get("ability_taxonomy_version") != ABILITY_VERSION:
        return unknown
    group, primary = record.get("benchmark_group"), record.get("ability_primary_ids")
    if group not in BENCHMARK_GROUPS or not isinstance(primary, list):
        return unknown
    if any(not isinstance(v, str) or v not in ABILITIES for v in primary):
        return unknown
    if group != "ordinary" or record.get("expected_action") == "clarify":
        types = ["not_applicable"]
    else:
        types = sorted(set(primary)) or ["unknown"]
    families = sorted({v[0] for v in types if v in ABILITIES}) or types
    return {"ability_family": families, "ability_type": types, "benchmark_group": [str(group)]}
