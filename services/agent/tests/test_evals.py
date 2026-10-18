from __future__ import annotations

import asyncio
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from app.llm.prompts import EXTRACTION_SCHEMA, TASK_TYPES
from app.pipeline.grounding import normalise
from app.pipeline.preprocess import clean_body
from app.schemas import EmailInput, LlmExtraction, TaskType
from evals import run_evals
from evals.metrics import Metrics, score
from evals.run_evals import Row, load_dataset, render_table
from tests.test_ask_briefing import task

DATASET = load_dataset()


def test_dataset_shape() -> None:
    cases = DATASET["cases"]
    assert len(cases) == 30
    ids = [c["email"]["id"] for c in cases]
    assert len(set(ids)) == 30
    categories = Counter(c["category"] for c in cases)
    for required in ("prompt_injection", "hinglish", "newsletter", "fyi", "multi_task"):
        assert categories[required] >= 1


@pytest.mark.parametrize("case", DATASET["cases"], ids=lambda c: c["email"]["id"])
def test_every_case_is_valid_and_labels_are_grounded(case: dict[str, Any]) -> None:
    email = EmailInput.model_validate(case["email"])
    text, _ = clean_body(email.body_text)
    haystack = normalise(f"{email.subject}\n{text}")
    for exp in case["expected"]:
        assert any(normalise(e) in haystack for e in exp["evidence"]), exp["evidence"]
        types = exp["type"] if isinstance(exp["type"], list) else [exp["type"]]
        assert set(types) <= set(TaskType.__args__)
        dues = exp["due_date"] if isinstance(exp["due_date"], list) else [exp["due_date"]]
        for d in dues:
            assert d is None or date.fromisoformat(d)


def test_prompt_schema_agrees_with_pydantic_model() -> None:
    sample = {
        "items": [
            {
                "email_id": "e1",
                "title": "Send it",
                "type": "send",
                "due_phrase": None,
                "due_iso_guess": None,
                "confidence": 0.9,
                "evidence": "Send it please.",
            }
        ]
    }
    jsonschema.validate(sample, EXTRACTION_SCHEMA)
    LlmExtraction.model_validate(sample)
    assert list(TaskType.__args__) == TASK_TYPES
    item_props = EXTRACTION_SCHEMA["properties"]["items"]["items"]["properties"]
    assert set(item_props) == set(
        LlmExtraction.model_fields["items"].annotation.__args__[0].model_fields
    )  # type: ignore[union-attr]


MINI = {
    "user": DATASET["user"],
    "cases": [
        {
            "email": {"id": "a", "thread_id": "ta"},
            "expected": [{"type": "send", "due_date": "2026-10-16", "evidence": ["send the deck"]}],
        },
        {
            "email": {"id": "b", "thread_id": "tb"},
            "expected": [
                {
                    "type": ["review"],
                    "due_date": [None, "2026-10-19"],
                    "evidence": ["review it"],
                    "optional": True,
                }
            ],
        },
        {
            "email": {"id": "c", "thread_id": "tc"},
            "expected": [{"type": "pay", "due_date": None, "evidence": ["pay now"]}],
        },
    ],
}


def _task(
    tid: str, thread: str, evidence: str, due: str | None, type_: str = "send", conf: float = 0.9
) -> Any:
    t = task(tid, "T", due, type_=type_)
    return t.model_copy(
        update={
            "evidence": evidence,
            "confidence": conf,
            "source": t.source.model_copy(update={"thread_id": thread}),
        }
    )


def test_score_counts_tp_fp_fn_dates_types_and_duplicates() -> None:
    tasks = [
        _task("1", "ta", "Can you send the deck?", "2026-10-16"),
        _task("2", "ta", "Please send the deck again.", "2026-10-16", conf=0.5),  # duplicate
        _task(
            "3", "tb", "Could you review it?", "2026-10-20", type_="review"
        ),  # optional, bad date
        _task("4", "tz", "Random chatter here.", None),
    ]
    m = score(MINI, tasks)
    assert (m.tp, m.fp, m.fn, m.matched_optional) == (2, 2, 1, 1)
    assert m.date_correct == 1 and m.type_correct == 2
    assert m.precision == 0.5 and m.recall == pytest.approx(2 / 3)
    assert m.misses == ["c: 'pay now'"]
    assert any("Random chatter" in fp for fp in m.false_positives)
    assert m.date_errors and "b:" in m.date_errors[0]


def test_empty_metrics_are_safe() -> None:
    m = Metrics()
    assert (m.precision, m.recall, m.f1, m.date_accuracy, m.type_accuracy) == (
        1.0,
        1.0,
        1.0,
        0.0,
        0.0,
    )


def test_render_table_handles_failed_rows() -> None:
    table = render_table(
        [
            Row("gemini", "g", "failed", Metrics(), 1.0, 0, "429"),
            Row("groq", "q", "partial", Metrics(tp=1), 2.0, 1, "1/5 batches failed"),
        ]
    )
    assert "| gemini | g | - |" in table and "failed: 429" in table
    assert "partial: 1/5 batches failed" in table


def test_eval_runs_end_to_end_with_heuristic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(run_evals, "REPO_ROOT", tmp_path)  # ignore any real .env
    assert (
        asyncio.run(run_evals.main(["--providers", "heuristic,nope", "--out", str(tmp_path)])) == 0
    )
    report = (tmp_path / "latest.md").read_text(encoding="utf-8")
    assert "| heuristic | rules-v1 |" in report
    assert (tmp_path / "latest.json").exists()
