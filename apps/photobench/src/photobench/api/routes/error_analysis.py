"""Independent analysis job APIs and offline exports."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from photobench.api.deps import get_container

router = APIRouter(tags=["error-analysis"])


class AnalysisRequest(BaseModel):
    kind: Literal["rules", "compare", "ai"] = "rules"
    parent_job: str | None = None
    left_job: str | None = None
    right_job: str | None = None
    indices: list[int] = Field(default_factory=list, max_length=20)
    provider_id: str | None = None

    @model_validator(mode="after")
    def validate_options(self) -> AnalysisRequest:
        if self.kind == "compare" and not (self.left_job and self.right_job):
            raise ValueError("left_job and right_job are required")
        if self.kind == "ai" and not (self.parent_job and self.provider_id and self.indices):
            raise ValueError("parent_job, provider_id and selected indices are required")
        return self


class AnomalyEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    event_id: str
    code: str
    label: str
    source: str
    turn: int
    step_id: str | None = None
    recovery: Literal["recovered", "not_recovered", "unknown"]
    basis: str
    role: str | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)


class CaseReference(BaseModel):
    model_config = ConfigDict(extra="allow")
    index: int
    qa_id: str
    question: str
    answer: str
    reference_answer: str
    score: int | None
    execution: str
    dimensions: dict[str, str]
    events: list[AnomalyEvent]
    turns: list[dict[str, Any]]
    missing: list[str]
    signals: list[str]


class BehaviorGroup(BaseModel):
    value: str
    total: int
    valid: int
    correct: int
    incorrect: int
    missing: int


class AnalysisReport(BaseModel):
    model_config = ConfigDict(extra="allow")
    schema_version: int
    rule_version: int
    generated_at: float
    source: dict[str, Any]
    result_fingerprint: str
    gt_fingerprint: str
    annotation_fingerprint: str | None = None
    turn_groups: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    item_count: int
    counts: dict[str, int]
    denominators: dict[str, int]
    groups: dict[str, list[dict[str, Any]]]
    errors: list[dict[str, Any]]
    behavior_groups: list[BehaviorGroup] = Field(default_factory=list)
    behavior_scenarios: list[BehaviorGroup] = Field(default_factory=list)
    behavior_matrix: list[dict[str, Any]]
    heatmap: list[dict[str, Any]]
    ability_heatmap: list[dict[str, Any]] = Field(default_factory=list)
    definitions: list[str]


class ComparisonReport(BaseModel):
    model_config = ConfigDict(extra="allow")
    comparable: bool
    sources: dict[str, Any]
    differences: list[str]
    missing_configuration: list[str]
    duplicates: list[str]
    pairing_counts: dict[str, int]
    quality_changes: dict[str, int] | None
    rows: list[dict[str, Any]]
    note: str


class DiagnosisReport(BaseModel):
    model_config = ConfigDict(extra="allow")
    parent_job: str
    model: str
    provider_id: str
    requested: int
    covered: int
    cases: list[dict[str, Any]]
    note: str


class CasePage(BaseModel):
    items: list[CaseReference]
    total: int
    page: int
    page_size: int


class AnalysisJob(BaseModel):
    model_config = ConfigDict(extra="allow")
    status: str
    job_id: str | None = None
    run_id: str | None = None
    kind: str | None = None
    processed: int = 0
    stale: bool = False
    report: AnalysisReport | ComparisonReport | DiagnosisReport | None = None


def filters(
    code: str = "",
    question_type: str = "",
    expected_action: str = "",
    actual_action: str = "",
    score: str = "",
    recovery: str = "",
    execution: str = "",
    task_type: str = "",
    angle: str = "",
    difficulty: str = "",
    answerability: str = "",
    media_type: str = "",
    conversation_type: str = "",
    anomaly: Literal["", "yes", "no"] = "",
    ability_family: str = "",
    ability_type: str = "",
    benchmark_group: str = "",
    content_type: str = "",
    content_subtype: str = "",
    content_unit: Literal["", "qa", "turn"] = "",
    test_scenario: str = "",
    behavior_result: Literal["", "correct", "incorrect", "missing"] = "",
) -> dict[str, Any]:
    return {
        "code": code,
        "question_type": question_type,
        "expected_action": expected_action,
        "actual_action": actual_action,
        "score": score,
        "recovery": recovery,
        "execution": execution,
        "task_type": task_type,
        "angle": angle,
        "difficulty": difficulty,
        "answerability": answerability,
        "media_type": media_type,
        "conversation_type": conversation_type,
        "anomaly": anomaly,
        "ability_family": ability_family,
        "ability_type": ability_type,
        "benchmark_group": benchmark_group,
        "content_type": content_type,
        "content_subtype": content_subtype,
        "content_unit": content_unit,
        "test_scenario": test_scenario,
        "behavior_result": behavior_result,
    }


@router.post(
    "/runs/{run_id}/analysis", status_code=202, response_model=AnalysisJob, response_model_exclude_none=True
)
def create(request: Request, run_id: str, payload: AnalysisRequest) -> dict[str, Any]:
    return get_container(request).error_analysis.create(run_id, payload.model_dump(exclude_none=True))


@router.get("/runs/{run_id}/analysis", response_model=AnalysisJob, response_model_exclude_none=True)
def latest(request: Request, run_id: str) -> dict[str, Any]:
    return get_container(request).analysis_backend.latest(run_id)


@router.get("/runs/{run_id}/analyses", response_model=list[AnalysisJob], response_model_exclude_none=True)
def history(request: Request, run_id: str) -> list[dict[str, Any]]:
    return get_container(request).analysis_backend.history(run_id)


@router.get("/analyses/{job_id}", response_model=AnalysisJob, response_model_exclude_none=True)
def job(request: Request, job_id: str) -> dict[str, Any]:
    return get_container(request).analysis_backend.result(job_id)


@router.post("/analyses/{job_id}/cancel", response_model=AnalysisJob, response_model_exclude_none=True)
def cancel(request: Request, job_id: str) -> dict[str, Any]:
    return get_container(request).analysis_backend.cancel(job_id)


@router.get("/analyses/{job_id}/cases", response_model=CasePage)
def cases(
    request: Request,
    job_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    code: str = "",
    question_type: str = "",
    expected_action: str = "",
    actual_action: str = "",
    score: str = "",
    recovery: str = "",
    execution: str = "",
    task_type: str = "",
    angle: str = "",
    difficulty: str = "",
    answerability: str = "",
    media_type: str = "",
    conversation_type: str = "",
    anomaly: Literal["", "yes", "no"] = "",
    ability_family: str = "",
    ability_type: str = "",
    benchmark_group: str = "",
    content_type: str = "",
    content_subtype: str = "",
    content_unit: Literal["", "qa", "turn"] = "",
    test_scenario: str = "",
    behavior_result: Literal["", "correct", "incorrect", "missing"] = "",
) -> dict[str, Any]:
    return get_container(request).analysis_backend.cases(
        job_id,
        filters(
            code,
            question_type,
            expected_action,
            actual_action,
            score,
            recovery,
            execution,
            task_type,
            angle,
            difficulty,
            answerability,
            media_type,
            conversation_type,
            anomaly,
            ability_family,
            ability_type,
            benchmark_group,
            content_type,
            content_subtype,
            content_unit,
            test_scenario,
            behavior_result,
        ),
        page,
        page_size,
    )


@router.get("/analyses/{job_id}/export")
def export(
    request: Request,
    job_id: str,
    format: Literal["html", "json", "csv"] = "html",
    code: str = "",
    question_type: str = "",
    expected_action: str = "",
    actual_action: str = "",
    score: str = "",
    recovery: str = "",
    execution: str = "",
    task_type: str = "",
    angle: str = "",
    difficulty: str = "",
    answerability: str = "",
    media_type: str = "",
    conversation_type: str = "",
    anomaly: Literal["", "yes", "no"] = "",
    ability_family: str = "",
    ability_type: str = "",
    benchmark_group: str = "",
    content_type: str = "",
    content_subtype: str = "",
    content_unit: Literal["", "qa", "turn"] = "",
    test_scenario: str = "",
    behavior_result: Literal["", "correct", "incorrect", "missing"] = "",
) -> Response:
    body = get_container(request).analysis_backend.export(
        job_id,
        format,
        filters(
            code,
            question_type,
            expected_action,
            actual_action,
            score,
            recovery,
            execution,
            task_type,
            angle,
            difficulty,
            answerability,
            media_type,
            conversation_type,
            anomaly,
            ability_family,
            ability_type,
            benchmark_group,
            content_type,
            content_subtype,
            content_unit,
            test_scenario,
            behavior_result,
        ),
    )
    media = {"html": "text/html", "json": "application/json", "csv": "text/csv"}[format]
    return Response(
        body,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{job_id}-analysis.{format}"'},
    )
