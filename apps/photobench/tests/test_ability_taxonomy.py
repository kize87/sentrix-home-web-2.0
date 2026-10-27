"""Versioned ability labels survive ingestion, execution, aggregation and exports."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest
from test_error_analysis import item, report

from photobench.application.run_execution.service import PASSTHROUGH_FIELDS
from photobench.domain.datasets.ability_taxonomy import ABILITY_FIELDS, ABILITY_VERSION, ability_dimensions
from photobench.domain.datasets.qa_taxonomy import validate_qa_annotations
from photobench.domain.error_analysis.exports import export_report
from photobench.domain.error_analysis.rules import case_from_item, matches
from photobench.domain.runs.analysis import item_summary
from photobench.infrastructure.datasets.albums import JsonAlbumSource
from photobench.infrastructure.datasets.qa_metadata import JsonQaMetadataSource


def labels(ids=None, group="ordinary", action="answer"):
    return dict(
        ability_taxonomy_version=ABILITY_VERSION,
        ability_primary_ids=ids or [],
        benchmark_group=group,
        expected_action=action,
        answerability="answerable",
        injection=group == "injection",
        difficulty="easy",
    )


def test_valid_union_is_independent_of_final_turn_and_legacy_parent():
    row = {
        **labels(["P1", "R2"]),
        "conversation": [labels([], action="clarify"), labels(["P1"]), labels(["R2"])],
    }
    validate_qa_annotations(row)
    row["ability_primary_ids"] = ["R2"]
    with pytest.raises(ValueError, match="union"):
        validate_qa_annotations(row)


@pytest.mark.parametrize(
    "patch",
    [
        {"ability_primary_ids": ["P9"]},
        {"ability_primary_ids": ["P1", "P1"]},
        {"ability_primary_ids": "P1"},
        {"ability_primary_ids": [None]},
        {"ability_primary_ids": []},
        {"ability_taxonomy_version": "future"},
        {"benchmark_group": "maybe"},
        {"ability_supporting_ids": ["P1"]},
        {"benchmark_group": "hallucination"},
    ],
)
def test_invalid_versioned_annotations_fail_import(patch):
    with pytest.raises(ValueError):
        validate_qa_annotations({**labels(["P1"]), **patch})


def test_clarification_and_safety_are_separate_from_ordinary_capabilities():
    for group in ("hallucination", "injection"):
        row = labels([], group, "refuse")
        validate_qa_annotations(row)
        assert ability_dimensions(row) == dict(
            ability_family=["not_applicable"], ability_type=["not_applicable"], benchmark_group=[group]
        )
    row = labels([], action="clarify")
    validate_qa_annotations(row)
    assert ability_dimensions(row)["ability_type"] == ["not_applicable"]
    row = {**labels(["P1"]), "conversation": [labels(["P1"], action="clarify")]}
    with pytest.raises(ValueError, match="clarification"):
        validate_qa_annotations(row)


@pytest.mark.parametrize(
    "record",
    [
        {},
        {"task_type": "T1_retrieve_media"},
        {**labels(["P1"]), "ability_taxonomy_version": "future"},
        {**labels(["P1"]), "ability_primary_ids": ["P9"]},
        {**labels(["P1"]), "benchmark_group": "maybe"},
        {**labels(["P1"]), "ability_primary_ids": "P1"},
    ],
)
def test_unrecorded_or_unsupported_history_is_never_guessed(record):
    assert set(v[0] for v in ability_dimensions(record).values()) == {"unknown"}


def test_multi_labels_use_unique_qa_and_turn_denominators_and_same_turn_filter():
    row = item(
        **labels(["P1", "P3", "R2"]),
        ability_supporting_ids=["P4"],
        model_call_metrics=[
            {"status": "error", "error_type": "TimeoutError", "step_id": "s1", "conversation_turn": 1}
        ]
        * 2,
        runtime_turns=[
            {**labels([], action="clarify"), "judge": {"score": 2}},
            {
                **labels(["P1", "P3"]),
                "judge": {"score": 0},
            },
            {**labels(["R2"]), "judge": {"score": 2}},
        ],
    )
    raw = copy.deepcopy(row)
    case = case_from_item(row, 0)
    r = report([case, case_from_item(item(**labels([], "hallucination", "refuse")), 1)])
    assert row == raw
    assert r["denominators"]["ability_valid"] == 1
    assert r["denominators"]["turn_ability_valid"] == 2
    assert r["counts"]["qa_ability_score_0"] == 1
    assert r["counts"]["qa_ability_family_P_score_0"] == 1
    assert any(x["ability_family"] == "P" and x["count"] == 1 for x in r["ability_heatmap"])
    assert not any(x["count"] > 1 for x in r["ability_heatmap"])
    assert {x["value"]: x["total"] for x in r["groups"]["ability_family"]} == {
        "P": 1,
        "R": 1,
        "not_applicable": 1,
    }
    assert not matches(case, dict(content_unit="turn", ability_type="R2", score="0"))
    assert matches(case, dict(content_unit="turn", ability_type="R2", score="2"))
    assert not matches(case, dict(content_unit="turn", ability_family="P", ability_type="R2"))
    assert not matches(case, dict(ability_type="P4"))  # Supporting only.
    assert matches(case, dict(benchmark_group="ordinary", ability_type="P1"))
    csv = export_report(r, [case], "csv", {})
    assert "ability_family,ability_type,benchmark_group" in csv
    assert "P1 / P3 / R2" in csv
    html = export_report(r, [case], "html", {})
    assert "记录定位与筛选" in html and "测试分组" in html


def test_no_final_turn_inheritance_for_unannotated_multi_turn_history():
    row = item(**labels(["P1"]), runtime_turns=[{"message": "a"}, {"message": "b"}])
    case = case_from_item(row, 0)
    assert all(t["ability_type"] == ["unknown"] for t in case["turns"])


def test_ability_changes_invalidate_annotation_comparison_but_preserve_gt_identity():
    a = case_from_item(item(**labels(["P1"])), 0)
    b = case_from_item(item(**labels(["R2"])), 0)
    assert a["identity"] == b["identity"] and a["gt_fingerprint"] == b["gt_fingerprint"]
    assert a["annotation_fingerprint"] != b["annotation_fingerprint"]


def test_schema3_loader_and_metadata_preserve_abilities_and_manifest_version(tmp_path: Path):
    album = tmp_path / "a"
    album.mkdir()
    row = {"qa_id": "q", "question": "find", "answer": "found", **labels(["P1"])}
    payload = json.dumps(row) + "\n"
    (album / "qa.jsonl").write_text(payload)
    definition = dict(
        schema_version="3.0",
        taxonomy_version="1.0",
        ability_taxonomy_version=ABILITY_VERSION,
        qa_sha256=hashlib.sha256(payload.encode()).hexdigest(),
    )
    manifest = dict(album_id="a", qa_sets={"new": "qa.jsonl"}, qa_set_versions={"new": definition})
    (album / "manifest.json").write_text(json.dumps(manifest))
    source = JsonAlbumSource(tmp_path, tmp_path / "policy.json")
    loaded = source.qa_rows("a", "new")[0]
    assert loaded["ability_primary_ids"] == ["P1"] and loaded["qa_schema_version"] == "3.0"
    assert item_summary(loaded, 0)["ability_primary_ids"] == ["P1"]
    assert set(ABILITY_FIELDS) <= set(PASSTHROUGH_FIELDS)
    meta = JsonQaMetadataSource(tmp_path, tmp_path / "policy.json").metadata_by_qa_id()
    assert next(iter(meta.values()))["ability_taxonomy_version"] == ABILITY_VERSION
    manifest["qa_set_versions"]["new"]["ability_taxonomy_version"] = "other"
    (album / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="version"):
        source.qa_rows("a", "new")


def test_execution_freezes_and_records_each_turns_own_abilities():
    from fakes_execution import FakeAlbums, FakeSentrixClient
    from test_run_execution import _assets, _completed_turn, _execution, _manifest, _polls, _request, _rows

    row = {
        **_rows()[0],
        **labels(["P1", "P3"]),
        "conversation": [
            {**labels(["P1"]), "message": "find", "reference_answer": "found"},
            {**labels(["P3"]), "message": "color?", "reference_answer": "blue"},
        ],
    }
    albums = FakeAlbums(
        manifest=_manifest(), qa_rows=[row], files={"faces/1.jpg": b"J"}, directory_entries={"photos": 2}
    )
    client = FakeSentrixClient(
        asset_polls=_polls(_assets()),
        turns={"turn_1": [_completed_turn("turn_1")], "turn_2": [_completed_turn("turn_2")]},
        import_result={"imported": 2, "events": 1, "summarized": 1, "failures": []},
    )
    execution, *_ = _execution(client=client, albums=albums)
    state = execution.execute(_request())
    result = state["items"][0]
    assert result["ability_primary_ids"] == ["P1", "P3"]
    assert [t["ability_primary_ids"] for t in result["runtime_turns"]] == [["P1"], ["P3"]]
    assert state["qa_snapshot"]["rows"][0]["ability_primary_ids"] == ["P1", "P3"]
    assert [t["ability_type"] for t in case_from_item(result, 0)["turns"]] == [["P1"], ["P3"]]


def test_api_filter_and_exports_use_the_same_versioned_ability_case_set(tmp_path: Path):
    from fastapi.testclient import TestClient
    from test_error_analysis import atomic, await_job, write_run

    from photobench.config import Settings
    from photobench.main import create_app

    root = tmp_path / "results"
    write_run(root, items=[item(**labels(["P1"])), item(qa_id="other", **labels([], "injection", "refuse"))])
    config = tmp_path / "config"
    config.mkdir()
    atomic(
        config / "judge_providers.json",
        {
            "default_provider_id": "test",
            "providers": {"test": {"url": "http://127.0.0.1:1/v1", "model": "judge"}},
        },
    )
    atomic(config / "vllm_targets.json", {"default_target_id": "local", "targets": {"local": {}}})
    app = create_app(
        Settings(config_root=config, results_root=root, data_root=tmp_path / "data"), scan_in_background=False
    )
    with TestClient(app) as client:
        key = client.post("/api/v1/runs/r/analysis", json={"kind": "rules"}).json()["job_id"]
        assert await_job(app.state.container.analysis_backend, key)["status"] == "completed"
        url = f"/api/v1/analyses/{key}"
        for query, expected in [
            ("ability_family=P&ability_type=P1&benchmark_group=ordinary", 1),
            ("ability_family=R", 0),
            ("benchmark_group=injection", 1),
            ("content_unit=turn&ability_type=P1", 1),
        ]:
            assert client.get(url + "/cases?" + query).json()["total"] == expected
            exported = client.get(url + "/export?format=json&" + query)
            assert len(exported.json()["cases"]) == expected
        assert "ability_family" in client.get(url + "/export?format=csv&ability_type=P1").text
        assert "记录定位与筛选" in client.get(url + "/export?format=html&ability_type=P1").text
