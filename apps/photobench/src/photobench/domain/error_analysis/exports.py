"""Offline reports: escaped HTML, native charts and spreadsheet-safe CSV."""

from __future__ import annotations

import csv
import html
import io
import json
from collections.abc import Mapping, Sequence
from typing import Any

DISPLAY_LABELS = {
    "task_type": "任务类型",
    "question_type": "题目形式",
    "angle": "考察角度",
    "difficulty": "难度",
    "answerability": "可回答性",
    "media_type": "媒体类型",
    "conversation_type": "对话形式",
    "expected_action": "预期行为",
    "T1_retrieve_media": "媒体检索",
    "T1_media_retrieval": "媒体检索",
    "T2_fact_qa": "事实问答",
    "T3_enumeration": "统计枚举",
    "T5_event_summary": "事件总结",
    "unknown": "未标注／未知",
}
SCORE_LABELS = {"2": "答对（2分）", "1": "部分答对（1分）", "0": "答错（0分）", "None": "未评分"}


def _escape(value: Any) -> str:
    return html.escape(str(value if value is not None else "未记录"), quote=True)


def _table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    return (
        "<table><thead><tr>"
        + "".join(f"<th>{_escape(h)}</th>" for h in headers)
        + "</tr></thead><tbody>"
        + "".join("<tr>" + "".join(f"<td>{_escape(v)}</td>" for v in row) + "</tr>" for row in rows)
        + "</tbody></table>"
    )


def _csv(rows: Sequence[Sequence[Any]]) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    for row in rows:
        writer.writerow(
            ["'" + str(x) if str(x or "").lstrip().startswith(("=", "+", "-", "@")) else x for x in row]
        )
    return out.getvalue()


def _document(body: str) -> str:
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>PhotoBench 错误分析</title><style>"
        "body{font:15px system-ui;max-width:1120px;margin:30px auto;padding:20px;color:#203040}"
        "pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:12px}"
        "details{border:1px solid #ccd5df;padding:12px;margin:12px 0}"
        "meter{width:40%;margin:8px}summary{cursor:pointer}li{margin:8px}"
        "table{border-collapse:collapse;width:100%;margin:16px 0}"
        "td,th{border:1px solid #ddd;text-align:left;padding:8px;overflow-wrap:anywhere}"
        ".stack{display:flex;width:90%;height:28px;background:#ddd;margin:8px 0}"
        ".stack span{min-width:0;overflow:hidden;color:#fff;text-align:center}"
        ".s0{background:#c44}.s1{background:#b80}.s2{background:#287c65}.sNone{background:#777}"
        "</style></head><body><h1>PhotoBench 错误分析</h1>" + body + "</body></html>"
    )


def export_report(
    report: dict[str, Any], cases: Sequence[dict[str, Any]], format: str, filters: Mapping[str, Any]
) -> str:
    if format == "json":
        return json.dumps(
            {"report": report, "filters": dict(filters), "cases": cases}, ensure_ascii=False, indent=2
        )
    if format == "csv":
        return _csv(
            [
                [
                    "qa_id",
                    "question",
                    "score",
                    "execution",
                    "question_type",
                    "task_type",
                    "angle",
                    "difficulty",
                    "outcome",
                    "errors",
                    "answer",
                    "reference_answer",
                ],
                *[
                    [
                        c["qa_id"],
                        c["question"],
                        c["score"],
                        c["execution"],
                        c["dimensions"]["question_type"],
                        c["dimensions"].get("task_type", "unknown"),
                        c["dimensions"].get("angle", "unknown"),
                        c["dimensions"].get("difficulty", "unknown"),
                        SCORE_LABELS[str(c["score"])],
                        ";".join(e["code"] for e in c["events"]),
                        c["answer"],
                        c["reference_answer"],
                    ]
                    for c in cases
                ],
            ]
        )
    if format != "html":
        raise ValueError("format must be html, json or csv")
    source = {
        "source": report["source"],
        "rule_version": report["rule_version"],
        "generated_at": report.get("generated_at"),
        "gt_fingerprint": report["gt_fingerprint"],
        "result_fingerprint": report.get("result_fingerprint"),
        "stale": report.get("stale", False),
        "filters": dict(filters),
    }
    body = (
        f"<p>全部样本 {report['item_count']}；本次筛选 {len(cases)} 题。"
        "统计图使用全部样本；下方案例使用所选筛选条件。离线可读，无网络依赖。</p>"
        "<h2>来源与筛选</h2><pre>" + _escape(json.dumps(source, ensure_ascii=False, indent=2)) + "</pre>"
        "<h2>统计口径</h2><ul>" + "".join(f"<li>{_escape(x)}</li>" for x in report["definitions"]) + "</ul>"
        "<h2>总览与有效分母</h2>"
        + _table(["指标", "数量"], [[k, v] for k, v in report["counts"].items()])
        + _table(["分母", "数量"], [[k, v] for k, v in report["denominators"].items()])
    )
    body += (
        "<h2>回答结果（全部题目）</h2><p>答对=2分，部分答对=1分，答错=0分；未评分不计为答错。运行异常与回答对错独立统计，异常也可能恢复后答对。</p>"
        + _table(
            ["回答结果", "题数"],
            [[label, report["counts"].get("score_" + value, 0)] for value, label in SCORE_LABELS.items()],
        )
    )
    maximum = max((r["affected_items"] for r in report["errors"]), default=1)
    body += "<h2>运行异常分布（包含答对题，类别可重叠）</h2>"
    for r in report["errors"]:
        body += (
            f'<div>{_escape(r["label"])} <meter min="0" max="{maximum}" '
            f'value="{r["affected_items"]}"></meter> {r["affected_items"]}题 / {r["events"]}次；'
            f"最终执行失败 {r['final_failed_items']}题，已恢复 {r['recovered_items']}题</div>"
        )
    for dim, rows in sorted(report["groups"].items(), key=lambda pair: pair[0] != "task_type"):
        body += f"<h2>样本分布与表现：{_escape(DISPLAY_LABELS.get(dim, dim))}</h2>"
        for row in rows:
            label = _escape(DISPLAY_LABELS.get(row["value"], row["value"]))
            body += (
                f"<p>{label} · 全部题目{row['total']} · 未评分{row.get('score_None', 0)}</p>"
                '<div class="stack">'
            )
            for score in ["2", "1", "0", "None"]:
                n = row.get("score_" + score, 0)
                width = n / max(1, row["total"]) * 100
                label = SCORE_LABELS[score]
                body += f'<span class="s{score}" style="width:{width:.3f}%">{label} {n}</span>'
            body += "</div>"
    body += "<h2>题型 × 错误类别</h2>" + _table(
        ["题型", "类别（可重叠）", "受影响题数"],
        [[r["question_type"], r["code"], r["count"]] for r in report["heatmap"]],
    )
    body += "<h2>预期 × 实际行为（对话轮）</h2>" + _table(
        ["预期", "实际", "轮数"],
        [[r["expected"], r["actual"], r["count"]] for r in report["behavior_matrix"]],
    )
    body += "<p>没有样本的行为显示为未覆盖；未知标签不计入有效行为正确率。</p><h2>筛选案例</h2>"
    for c in cases:
        body += (
            f"<details><summary>{_escape(c['qa_id'])} · {_escape(c['execution'])} · "
            f"分数{_escape(c['score'])}</summary>"
            f"<h3>问题</h3><pre>{_escape(c['question'])}</pre>"
            f"<h3>参考答案</h3><pre>{_escape(c['reference_answer'])}</pre>"
            f"<h3>模型回答</h3><pre>{_escape(c['answer'])}</pre>"
            f"<p>摘要文本截短：{c['text_truncated']}；完整轨迹另行导出。</p><ul>"
        )
        for e in c["events"]:
            body += (
                f"<li>{_escape(e['event_id'])} · 轮{e['turn']} / {_escape(e.get('step_id'))} · "
                f"{_escape(e['label'])} · {_escape(e['recovery'])}"
                f"<pre>{_escape(json.dumps(e, ensure_ascii=False, indent=2))}</pre></li>"
            )
        body += (
            "</ul><pre>" + _escape(json.dumps(c["turns"], ensure_ascii=False, indent=2)) + "</pre></details>"
        )
    return _document(body)


def export_auxiliary(report: dict[str, Any], kind: str, format: str) -> str:
    """Comparison / AI artifacts keep factual provenance in each export."""
    if format == "json":
        return json.dumps(report, ensure_ascii=False, indent=2)
    rows = report.get("rows", []) if kind == "compare" else report.get("cases", [])
    cells = [["qa_id", "pairing", "quality_change", "execution_changed", "valid", "details"]]
    cells.extend(
        [
            [
                r.get("qa_id"),
                r.get("pairing"),
                r.get("quality_change"),
                r.get("execution_changed"),
                r.get("valid"),
                json.dumps(r, ensure_ascii=False),
            ]
            for r in rows
        ]
    )
    if format == "csv":
        return _csv(cells)
    if format == "html":
        return _document(
            "<h2>"
            + ("逐题对比" if kind == "compare" else "AI 诊断（建议）")
            + "</h2><pre>"
            + _escape(json.dumps(report, ensure_ascii=False, indent=2))
            + "</pre>"
        )
    raise ValueError("unknown format")
