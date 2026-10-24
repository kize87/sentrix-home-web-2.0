"""Pure case extraction and aggregation. Counts are observations, not causal claims."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

from photobench.domain.runs.analysis import judge_score_for_summary

RULE_VERSION = 2
TERMINAL = {"completed", "completed_with_errors", "failed", "cancelled", "interrupted"}
NORMAL = {"answered", "answered_with_gap", "policy_refusal"}
LABELS = {
    "context_soft_limit": "上下文软预算预检",
    "context_window_exceeded": "上下文窗口超限",
    "context_output_insufficient": "输出空间不足",
    "context_unknown": "上下文不足（子类未知）",
    "output_truncated": "模型输出截断",
    "request_timeout": "模型调用超时",
    "service_error": "模型服务错误",
    "response_json_invalid": "服务响应不可解析",
    "tool_argument_json_invalid": "工具参数JSON非法",
    "model_output_format": "模型输出格式错误",
    "parse_failure_unknown": "解析失败（子类未知）",
    "step_budget_exhausted": "步骤预算耗尽",
    "tool_budget_exhausted": "工具预算耗尽",
    "turn_timeout": "整轮执行超时",
    "tool_error": "工具执行异常/拒绝",
    "tool_timeout": "工具执行超时",
    "tool_internal_unavailable": "工具内部模型不可用（原因未记录）",
    "retrieval_degraded": "检索降级",
    "judge_error": "Judge执行失败",
    "judge_json_invalid": "Judge输出不可解析",
    "judge_inconsistent": "Judge判定不一致",
    "execution_error": "任务执行异常",
}
DIMENSIONS = (
    "question_type",
    "task_type",
    "difficulty",
    "angle",
    "answerability",
    "expected_action",
    "media_type",
    "conversation_type",
)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def classify(call: Mapping[str, Any]) -> tuple[str, str]:
    diagnosis = call.get("diagnostics") or {}
    code = diagnosis.get("error_category")
    if code in LABELS:
        return str(code), "structured"
    name, message = str(call.get("error_type") or ""), str(call.get("error") or "")
    text = (name + " " + message).lower()
    # OutputTruncatedError inherits PromptTooLongError: precedence is deliberate.
    if "outputtruncated" in text or call.get("finish_reason") == "length":
        return "output_truncated", "recorded_type_or_finish_reason"
    if "prompttoolong" in text or "context_length" in text or "context window" in text:
        if "软上限" in text:
            return "context_soft_limit", "legacy_text"
        if "只剩" in text or "不足以写完" in text:
            return "context_output_insufficient", "legacy_text"
        if "超出端点" in text or "exceeds" in text:
            return "context_window_exceeded", "legacy_text"
        return "context_unknown", "recorded_type"
    if "timeout" in text or "timed out" in text or "超时" in text:
        return "request_timeout", "legacy_text"
    if "响应结构不可识别" in text or "jsondecode" in text:
        return "response_json_invalid", "legacy_text"
    return "service_error", "recorded_error"


def case_from_item(item: Mapping[str, Any], index: int) -> dict[str, Any]:
    turns = [x for x in item.get("runtime_turns") or [] if isinstance(x, dict)]
    if not turns:
        turns = [dict(item)]
    events: list[dict[str, Any]] = []

    def add(code: str, source: str, turn: int, step: Any = None, **facts: Any) -> None:
        events.append(
            {
                "event_id": f"i{index}:e{len(events)}",
                "code": code,
                "label": LABELS.get(code, code),
                "source": source,
                "turn": turn,
                "step_id": str(step) if step is not None else None,
                "recovery": "unknown",
                "basis": "recorded_fact",
                **facts,
            }
        )

    calls = [c for c in item.get("model_call_metrics") or [] if isinstance(c, dict)]
    for pos, call in enumerate(calls):
        turn = int(call.get("conversation_turn") or 0)
        step = call.get("step_id")
        role = str(call.get("call_type") or "agent")
        if (
            call.get("status") in {"error", "failed"}
            or call.get("error")
            or call.get("finish_reason") == "length"
        ):
            code, basis = classify(call)
            following = next(
                (
                    c
                    for c in calls[pos + 1 :]
                    if c.get("conversation_turn", 0) == turn
                    and str(c.get("call_type") or "agent") == role
                    and c.get("step_id") == step
                    and step is not None
                    and c.get("status") in {"complete", "completed", "ok"}
                ),
                None,
            )
            recovery = "recovered" if following is not None else "unknown"
            if (
                following is None
                and turn < len(turns)
                and turns[turn].get("termination_reason") not in NORMAL
            ):
                recovery = "not_recovered"
            add(
                code,
                "model_call_metrics",
                turn,
                step,
                basis=basis,
                role=role,
                call_id=call.get("call_id"),
                attempt=call.get("attempt"),
                message=str(call.get("error") or "")[:2000],
                diagnostics=call.get("diagnostics") or {},
                duration_ms=call.get("duration_ms"),
                recovery=recovery,
                recovered_by=(following or {}).get("call_id")
                or ((following or {}).get("attempt") if following else None),
            )
        if call.get("output_format_error"):
            add(
                "model_output_format",
                "model_call_metrics.output_format_error",
                turn,
                step,
                role=role,
                call_id=call.get("call_id"),
                message=call["output_format_error"],
            )
        for fact in call.get("tool_argument_parse_facts") or []:
            if fact.get("json_object_valid") is False:
                add(
                    "tool_argument_json_invalid",
                    "model_call_metrics",
                    turn,
                    step,
                    role=role,
                    tool_call_id=fact.get("call_id"),
                    call_id=call.get("call_id"),
                )
    tools = [t for t in item.get("tool_trace") or [] if isinstance(t, dict)]
    for tool in tools:
        ti = int(tool.get("conversation_turn") or 0)
        result = tool.get("result") or {}
        if tool.get("status") in {"error", "failed", "denied", "partial"}:
            add(
                "tool_timeout"
                if any(
                    w in str(tool.get("error") or tool.get("text") or "").lower()
                    for w in ("timed out", "timeout", "超时")
                )
                else "tool_error",
                "tool_trace",
                ti,
                tool.get("step_id"),
                role="tool",
                tool=tool.get("tool"),
                message=str(tool.get("text") or tool.get("error") or "")[:2000],
            )
        if isinstance(result, dict):
            internal = result.get("model_call_observations") or []
            if result.get("failure_reason") == "model_unavailable" and not internal:
                add(
                    "tool_internal_unavailable",
                    "tool_trace.result",
                    ti,
                    tool.get("step_id"),
                    role="tool_internal",
                )
            for call in internal:
                if call.get("status") == "error":
                    code, basis = classify(call)
                    add(
                        code,
                        "tool_trace.result.model_call_observations",
                        ti,
                        tool.get("step_id"),
                        role="tool_internal",
                        call_id=call.get("call_id"),
                        basis=basis,
                        diagnostics=call.get("diagnostics") or {},
                        message=str(call.get("error") or "")[:2000],
                        recovery="recovered" if call.get("recovered_by_call_id") else "unknown",
                    )
        if isinstance(result, dict) and result.get("degraded"):
            add(
                "retrieval_degraded",
                "tool_trace",
                ti,
                tool.get("step_id"),
                role="tool",
                message=str(result.get("degraded_reason") or ""),
            )
    turn_rows: list[dict[str, Any]] = []
    for ti, turn_record in enumerate(turns):
        reason = str(turn_record.get("termination_reason") or "")
        trace = turn_record.get("trace") or []
        formatted = False
        for ei, event in enumerate(trace):
            payload = event.get("payload") or {}
            guard_code = payload.get("code")
            if guard_code == "textual_tool_call":
                formatted = True
                add(
                    "model_output_format",
                    "runtime_turns.trace",
                    ti,
                    payload.get("step_id"),
                    event_index=ei,
                    message=str(event.get("text") or ""),
                    recovery="recovered" if reason in NORMAL else "unknown",
                )
        terminal_codes = {
            "parse_failure": "parse_failure_unknown",
            "step_budget_exhausted": "step_budget_exhausted",
            "tool_budget_exhausted": "tool_budget_exhausted",
            "timeout": "turn_timeout",
            "model_error": "execution_error",
            "guard_blocked": "execution_error",
            "planner_blocked": "execution_error",
        }
        if reason in terminal_codes and not (reason == "parse_failure" and formatted):
            add(
                terminal_codes[reason],
                "runtime_turns.termination_reason",
                ti,
                recovery="not_recovered",
                role="agent",
            )
        task = turn_record.get("task_judge") or (
            (item.get("task_judges") or [])[ti] if ti < len(item.get("task_judges") or []) else {}
        )
        if not task and len(turns) == 1:
            task = item.get("task_judge") or {}
        expected = turn_record.get("expected_action") or (
            item.get("expected_action") if len(turns) == 1 else None
        )
        turn_rows.append(
            {
                "turn": ti,
                "turn_id": turn_record.get("turn_id"),
                "termination_reason": reason,
                "expected": expected,
                "actual": task.get("actual_action"),
                "behavior_correct": task.get("correct")
                if isinstance(task.get("correct"), bool) and task.get("judge_status") != "failed"
                else None,
                "judge_reason": str(task.get("reason") or "")[:2000],
                "score": judge_score_for_summary(turn_record.get("judge")),
            }
        )
        judges = {
            "answer": turn_record.get("judge"),
            "behavior": turn_record.get("task_judge"),
            "evidence": turn_record.get("evidence_judge"),
        }
        if len(turns) == 1:
            judges = {
                "answer": item.get("judge"),
                "behavior": item.get("task_judge"),
                "evidence": item.get("evidence_judge"),
            }
        for role, judge in judges.items():
            if not isinstance(judge, dict):
                continue
            observations = judge.get("call_observations") or []
            for call in observations:
                if call.get("status") != "error":
                    continue
                code, basis = classify(call)
                add(
                    code,
                    role + "_judge.call_observations",
                    ti,
                    role="judge",
                    basis=basis,
                    call_id=call.get("call_id"),
                    diagnostics=call.get("diagnostics") or {},
                    message=str(call.get("error") or "")[:2000],
                    recovery="recovered" if call.get("recovered_by_call_id") else "not_recovered",
                    recovered_by=call.get("recovered_by_call_id"),
                )
            if (
                judge.get("consistency_status") == "inconsistent"
                or judge.get("reason") == "judge_inconsistent_score_reason"
            ):
                add("judge_inconsistent", role + "_judge", ti, role="judge")
            elif judge.get("judge_status") == "failed" or str(judge.get("reason") or "").startswith(
                "judge_error"
            ):
                text = str(judge.get("reason") or "")
                code = (
                    "judge_json_invalid"
                    if any(x in text.lower() for x in ("json", "parse", "解析"))
                    else "judge_error"
                )
                if not any(c.get("status") == "error" for c in observations):
                    add(code, role + "_judge", ti, role="judge", message=text[:2000])
    score = judge_score_for_summary(item.get("judge"))
    reasons = [t["termination_reason"] for t in turn_rows]
    status = (
        "cancelled"
        if any(r == "cancelled" for r in reasons)
        else "failed"
        if any(r and r not in NORMAL for r in reasons)
        else "normal"
        if all(r in NORMAL for r in reasons)
        else "unknown"
    )
    gt_fields = (
        "retrieval_media_refs",
        "retrieval_image_ids",
        "retrieval_video_ids",
        "answer_evidence_media_refs",
        "reference_answer",
        "expected_action",
        "answer_claims",
        "answer_evidence_image_ids",
        "answer_evidence_video_ids",
        "answerability",
        "task_type",
        "required_evidence_sources",
    )
    gt = {k: item[k] for k in gt_fields if k in item}
    turn_gt = [{k: t[k] for k in gt_fields if t.get(k)} for t in turns]
    if any(turn_gt):
        gt["turns"] = turn_gt
    media = {str(x.get("media_type")) for x in item.get("retrieval_media_refs") or [] if isinstance(x, dict)}
    if item.get("retrieval_image_ids"):
        media.add("image")
    if item.get("retrieval_video_ids"):
        media.add("video")
    dimension_labels = {
        k: [str(v) for v in item[k]]
        if isinstance(item.get(k), list) and item[k]
        else [str(item.get(k) or "unknown")]
        for k in DIMENSIONS
    }
    dimensions = {k: " / ".join(values) for k, values in dimension_labels.items()}
    dimensions.update(
        media_type="mixed" if len(media) > 1 else next(iter(media), "unknown"),
        conversation_type="multi" if len(turns) > 1 else "single",
    )
    dimension_labels.update({k: [dimensions[k]] for k in ("media_type", "conversation_type")})
    retrieval = item.get("candidate_retrieval_counts") or {}
    delivery = item.get("media_retrieval_counts") or {}
    signals = []
    if retrieval.get("gt", 0) > 0:
        if retrieval.get("matched") == 0:
            signals.append("candidate_miss")
        elif delivery.get("gt", 0) > 0 and delivery.get("matched") == 0:
            signals.append("candidate_hit_not_delivered")
        if delivery.get("matched", 0) > 0 and score in (0, 1):
            signals.append("delivered_low_score")
    missing = []
    if score is None:
        missing.append("quality_score")
    if not calls and not item.get("execution_trace") and not any(t.get("trace") for t in turns):
        missing.append("trace")
    if not any(gt.get(k) for k in gt):
        missing.append("gt")
    if not any(item.get(k) for k in ("retrieval_media_refs", "retrieval_image_ids", "retrieval_video_ids")):
        missing.append("retrieval_gt")
    if not item.get("question_type"):
        missing.append("question_type")
    if any(t["expected"] is None or t["actual"] is None for t in turn_rows):
        missing.append("behavior")
    judge_records = turns if len(turns) > 1 else [item]
    if any(
        t.get(key) and t[key].get("reason") != "not_applicable" and "call_observations" not in t[key]
        for t in judge_records
        for key in ("judge", "task_judge", "evidence_judge")
    ):
        missing.append("judge_call_records")
    if any(
        (t.get("tool") or t.get("name")) == "inspect_photo"
        and "model_call_observations" not in (t.get("result") or {})
        for t in tools
    ):
        missing.append("tool_model_call_records")
    agent_limits = []
    for record in turns:
        budget = (record.get("trace_bundle") or {}).get("budget") or {}
        if budget.get("max_steps") is not None and budget.get("max_tool_calls") is not None:
            agent_limits.append({k: budget[k] for k in ("max_steps", "max_tool_calls")})
    context_windows = sorted(
        {
            int((c.get("diagnostics") or {})["context_window_tokens"])
            for c in calls
            if (c.get("diagnostics") or {}).get("context_window_tokens")
        }
    )
    judge_definitions = []
    for record in turns:
        for key in ("judge", "task_judge", "evidence_judge"):
            judge = (item.get(key) if len(turns) == 1 else record.get(key)) or {}
            payload = (judge.get("attempts") or [{}])[0].get("input") or judge.get("input") or {}
            if payload:
                judge_definitions.append(
                    fingerprint(
                        {
                            "role": key,
                            "model": payload.get("model"),
                            "temperature": payload.get("temperature"),
                            "max_tokens": payload.get("max_tokens"),
                            "system": [
                                m.get("content")
                                for m in payload.get("messages", [])
                                if m.get("role") == "system"
                            ],
                        }
                    )
                )
    return {
        "judge_definitions": sorted(set(judge_definitions)),
        "agent_limits": agent_limits,
        "context_windows": context_windows,
        "index": index,
        "qa_id": str(item.get("qa_id") or ""),
        "question": str(item.get("question") or "")[:8000],
        "reference_answer": str(item.get("reference_answer") or "")[:8000],
        "answer": str(item.get("answer") or "")[:8000],
        "text_truncated": any(
            len(str(item.get(k) or "")) > 8000 for k in ("question", "answer", "reference_answer")
        ),
        "identity": fingerprint(
            {
                "question": item.get("question"),
                "gt": gt,
                "conversation": [
                    {k: t.get(k) for k in ("message", "reference_answer", "expected_action")} for t in turns
                ],
                "context_mode": item.get("conversation_context_mode"),
            }
        ),
        "gt_fingerprint": fingerprint(gt),
        "score": score,
        "execution": status,
        "dimensions": dimensions,
        "dimension_labels": dimension_labels,
        "events": events,
        "turns": turn_rows,
        "signals": signals,
        "missing": missing,
        "model_calls": len(calls),
        "tool_model_calls": sum(
            len((t.get("result") or {}).get("model_call_observations") or []) for t in tools
        ),
        "judge_calls": sum(
            len((t.get(key) or {}).get("call_observations") or [])
            for t in (turns if len(turns) > 1 else [item])
            for key in ("judge", "task_judge", "evidence_judge")
        ),
        "tool_calls": len(tools),
        "tool_json_total": sum(len(c.get("tool_argument_parse_facts") or []) for c in calls),
        "tool_json_invalid": sum(e["code"] == "tool_argument_json_invalid" for e in events),
        "retrieval_counts": {"candidate": retrieval, "delivery": delivery},
    }


class Aggregator:
    """Only compact cases are retained by storage; aggregate uses bounded counters."""

    def __init__(self) -> None:
        self.total = 0
        self.counts: Counter[str] = Counter()
        self.groups: dict[str, dict[str, Counter[str]]] = {k: {} for k in DIMENSIONS}
        self.errors: dict[str, Counter[str]] = {}
        self.matrix: Counter[tuple[str, str]] = Counter()
        self.heatmap: Counter[tuple[str, str]] = Counter()
        self.gt_hash = hashlib.sha256()
        self.judge_definitions: set[str] = set()
        self.agent_limits: dict[str, dict[str, Any]] = {}
        self.context_windows: set[int] = set()

    def add(self, case: dict[str, Any]) -> None:
        self.total += 1
        self.judge_definitions.update(case["judge_definitions"])
        self.agent_limits.update({fingerprint(v): v for v in case["agent_limits"]})
        self.context_windows.update(case["context_windows"])
        self.gt_hash.update((case["qa_id"] + case["gt_fingerprint"]).encode())
        self.counts["score_" + str(case["score"])] += 1
        self.counts["execution_" + case["execution"]] += 1
        for key in (
            "model_calls",
            "tool_model_calls",
            "judge_calls",
            "tool_calls",
            "tool_json_total",
            "tool_json_invalid",
        ):
            self.counts[key] += case[key]
        if case["events"]:
            self.counts["affected_items"] += 1
        for m in case["missing"]:
            self.counts["missing_" + m] += 1
        for signal in case["signals"]:
            self.counts[signal] += 1
        for dim, values in case["dimension_labels"].items():
            for value in sorted(set(values)):
                row = self.groups[dim].setdefault(value, Counter())
                row["total"] += 1
                row["score_" + str(case["score"])] += 1
                row["failed"] += case["execution"] == "failed"
        for code in sorted({e["code"] for e in case["events"]}):
            es = [e for e in case["events"] if e["code"] == code]
            row = self.errors.setdefault(code, Counter())
            row["events"] += len(es)
            row["affected_items"] += 1
            row["final_failed_items"] += case["execution"] == "failed"
            row["recovered_items"] += all(e["recovery"] == "recovered" for e in es)
            self.heatmap[case["dimensions"]["question_type"], code] += 1
        if case["events"] and all(e["recovery"] == "recovered" for e in case["events"]):
            self.counts["fully_recovered_items"] += 1
        self.counts["events"] += len(case["events"])
        for channel, counts in case["retrieval_counts"].items():
            if counts.get("gt", 0) > 0:
                self.counts[channel + "_valid_items"] += 1
                for name in ("gt", "matched", "predicted"):
                    self.counts[channel + "_" + name] += counts.get(name, 0)
        for turn in case["turns"]:
            self.counts["turns"] += 1
            self.counts["turn_score_" + str(turn["score"])] += 1
            expected, actual = turn["expected"], turn["actual"]
            self.matrix[str(expected or "unknown"), str(actual or "unknown")] += 1
            if expected in {"answer", "refuse", "clarify"} and isinstance(turn["behavior_correct"], bool):
                self.counts["behavior_valid"] += 1
                self.counts["behavior_correct"] += turn["behavior_correct"]

    def report(self, metadata: dict[str, Any]) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "rule_version": RULE_VERSION,
            "source": {
                **metadata,
                "judge_definition_fingerprints": sorted(self.judge_definitions),
                "agent_limits": [self.agent_limits[k] for k in sorted(self.agent_limits)],
                "context_windows": sorted(self.context_windows),
            },
            "gt_fingerprint": self.gt_hash.hexdigest(),
            "item_count": self.total,
            "counts": dict(self.counts),
            "denominators": {
                "qa": self.total,
                "quality_valid": self.total - self.counts["score_None"],
                "quality_missing": self.counts["score_None"],
                "turns": self.counts["turns"],
                "turn_quality_valid": self.counts["turns"] - self.counts["turn_score_None"],
                "behavior_valid": self.counts["behavior_valid"],
                "behavior_missing": self.counts["turns"] - self.counts["behavior_valid"],
                "model_calls": self.counts["model_calls"],
                "tool_model_calls": self.counts["tool_model_calls"],
                "judge_calls": self.counts["judge_calls"],
                "tool_calls": self.counts["tool_calls"],
                "tool_json_recorded": self.counts["tool_json_total"],
            },
            "groups": {
                k: [{"value": v, **dict(c)} for v, c in rows.items()] for k, rows in self.groups.items()
            },
            "errors": [
                {"code": k, "label": LABELS.get(k, k), **dict(v)}
                for k, v in sorted(self.errors.items(), key=lambda kv: -kv[1]["affected_items"])
            ],
            "behavior_matrix": [
                {"expected": e, "actual": a, "count": n} for (e, a), n in self.matrix.items()
            ],
            "heatmap": [{"question_type": q, "code": c, "count": n} for (q, c), n in self.heatmap.items()],
            "definitions": [
                "异常事件数、受影响题数、最终执行失败题数分别统计；错误类别及多标签题型/角度可重叠，不能相加。",
                "恢复仅根据同轮同一步重试成功或明确恢复事件判定，未知不计成功。",
                "分数分母为有效Judge题数；行为分母为有效逐轮行为判定数；未知与未覆盖不补零。",
                "检索/交付信号用于定位，不作确定因果结论。",
                "调用分母统计已保存的调用记录；历史未采集的内部调用数量保持未知，见数据缺口。",
            ],
        }


def matches(case: Mapping[str, Any], filters: Mapping[str, Any]) -> bool:
    behavioral = {k: v for k, v in filters.items() if k in {"expected_action", "actual_action"} and v}
    if behavioral and not any(
        all(
            str(turn["expected" if k == "expected_action" else "actual"] or "unknown") == v
            for k, v in behavioral.items()
        )
        for turn in case["turns"]
    ):
        return False
    for k, v in filters.items():
        if v in (None, ""):
            continue
        if k == "expected_action" or k == "actual_action":
            continue
        if k in DIMENSIONS and v not in case["dimension_labels"].get(k, []):
            return False
        if k == "code" and v not in {e["code"] for e in case["events"]}:
            return False
        if k == "execution" and case.get(k) != v:
            return False
        if k == "score":
            if v == "low":
                if case.get("score") not in (0, 1):
                    return False
            elif str(case.get(k)) != str(v):
                return False
        if k == "anomaly" and bool(case["events"]) != (v == "yes"):
            return False
        if k == "recovery" and not any(e["recovery"] == v for e in case["events"]):
            return False
        if k == "actual_action" and not any(t["actual"] == v for t in case["turns"]):
            return False
    return True


def compare_reports(
    left: dict[str, Any], right: dict[str, Any], a: Sequence[dict[str, Any]], b: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    counts_a, counts_b = Counter(x["qa_id"] for x in a), Counter(x["qa_id"] for x in b)
    one = {x["qa_id"]: x for x in a if x["qa_id"] and counts_a[x["qa_id"]] == 1}
    two = {x["qa_id"]: x for x in b if x["qa_id"] and counts_b[x["qa_id"]] == 1}
    differences = []
    for k in (
        "judge",
        "judge_definition_fingerprints",
        "budgets",
        "agent_limits",
        "context_windows",
        "model",
        "device",
        "build_revision",
    ):
        if left["source"].get(k) != right["source"].get(k):
            differences.append(k)
    comparable = (
        not any(
            k in differences
            for k in ("judge", "judge_definition_fingerprints", "budgets", "agent_limits", "context_windows")
        )
        and bool(left["source"].get("judge"))
        and bool(right["source"].get("judge"))
        and bool((left["source"].get("budgets") or {}).get("execution"))
        and bool((right["source"].get("budgets") or {}).get("execution"))
        and all(
            source.get("agent_limits")
            and source.get("context_windows")
            and source.get("judge_definition_fingerprints")
            for source in (left["source"], right["source"])
        )
    )
    rows = []
    for qa in sorted(one.keys() | two.keys()):
        if counts_a[qa] > 1 or counts_b[qa] > 1:
            continue
        x, y = one.get(qa), two.get(qa)
        state = (
            "unmatched"
            if x is None or y is None
            else "changed"
            if x["identity"] != y["identity"]
            else "paired"
        )
        delta = (
            y["score"] - x["score"]
            if state == "paired"
            and x is not None
            and y is not None
            and x["score"] is not None
            and y["score"] is not None
            else None
        )
        rows.append(
            {
                "qa_id": qa,
                "pairing": state,
                "score_delta": delta,
                "execution_changed": bool(x and y and x["execution"] != y["execution"]),
                "errors_added": sorted(
                    {e["code"] for e in (y or {}).get("events", [])}
                    - {e["code"] for e in (x or {}).get("events", [])}
                ),
                "errors_removed": sorted(
                    {e["code"] for e in (x or {}).get("events", [])}
                    - {e["code"] for e in (y or {}).get("events", [])}
                ),
                "gt_changed": bool(x and y and x["gt_fingerprint"] != y["gt_fingerprint"]),
                "quality_change": ("improved" if delta > 0 else "regressed" if delta < 0 else "unchanged")
                if delta is not None
                else "unknown",
                "left": x,
                "right": y,
            }
        )
    duplicates = sorted(
        k for k in counts_a.keys() | counts_b.keys() if not k or counts_a[k] > 1 or counts_b[k] > 1
    )
    return {
        "sources": {"left": left["source"], "right": right["source"]},
        "differences": differences,
        "comparable": comparable,
        "duplicates": duplicates,
        "pairing_counts": dict(Counter(x["pairing"] for x in rows)),
        "rows": rows,
        "quality_changes": dict(Counter(x["quality_change"] for x in rows if x["pairing"] == "paired"))
        if comparable
        else None,
        "missing_configuration": [
            k
            for k in ("judge", "judge_definition_fingerprints", "agent_limits", "context_windows")
            if not left["source"].get(k) or not right["source"].get(k)
        ],
        "note": "仅配对题比较；设备/模型变化不作因果归因。Judge或预算不同/未知时不提供改善汇总。",
    }
