from __future__ import annotations

import asyncio
from typing import Any

from app.config import Settings
from app.llm.base import ProviderError
from app.llm.heuristic import HeuristicProvider
from app.llm.router import LLMRouter
from app.pipeline.orchestrator import Pipeline
from app.schemas import ExtractRequest, ExtractResponse

SETTINGS = Settings(internal_api_key="k")


def run(req: dict[str, Any], provider: Any = None) -> ExtractResponse:
    pipeline = Pipeline(LLMRouter([provider or HeuristicProvider()]), SETTINGS)
    return asyncio.run(pipeline.run(ExtractRequest.model_validate(req)))


def test_end_to_end_with_heuristic(inbox_request: dict[str, Any]) -> None:
    res = run(inbox_request)
    by_email = {t.email_id: t for t in res.tasks}
    assert set(by_email) == {"m1", "m2", "m3"}

    review = by_email["m3"]  # VIP, due today 17:00 IST
    assert review.bucket == "today" and review.has_time
    assert review.due_at is not None and review.due_at.isoformat() == "2026-10-16T17:00:00+05:30"
    assert "VIP sender" in review.priority_reasons
    assert res.tasks[0].email_id == "m3"  # today sorts first

    deck = by_email["m1"]
    assert str(deck.due_date) == "2026-10-20" and deck.bucket == "week"
    assert deck.extracted_by == "heuristic/rules-v1"

    invoice = by_email["m2"]
    assert invoice.type == "payment" and str(invoice.due_date) == "2026-10-20"
    assert "98765" not in invoice.evidence  # PII redacted before extraction

    skipped = {s.email_id: s.reason for s in res.skipped}
    assert skipped == {
        "m4": "newsletter",
        "m5": "promotion",
        "m6": "no_action_items",
        "m7": "no_action_items",
    }
    assert res.briefing.counts.today == 1 and res.briefing.counts.week == 2


def test_trace_has_every_step_in_order(inbox_request: dict[str, Any]) -> None:
    res = run(inbox_request)
    assert [s.step for s in res.trace] == [
        "preprocess",
        "triage",
        "extract",
        "ground",
        "dates",
        "priority",
        "plan",
    ]
    assert all(s.status == "ok" for s in res.trace)
    assert res.trace[0].counts == {"in": 7, "out": 7, "pii_redacted": 1}
    assert res.provider_usage[0].provider == "heuristic"
    assert res.provider_usage[0].calls == 1  # 5 kept emails fit in one batch of 6


def test_re_running_gives_identical_task_ids(inbox_request: dict[str, Any]) -> None:
    assert [t.id for t in run(inbox_request).tasks] == [t.id for t in run(inbox_request).tasks]


class _Failing:
    name, model = "broken", "v0"

    def is_configured(self) -> bool:
        return True

    async def complete_json(self, *a: Any, **k: Any) -> dict[str, Any]:
        raise ProviderError("boom")


class _Liar:
    """Returns a task the email never said (hallucination / injection)."""

    name, model = "liar", "v0"

    def is_configured(self) -> bool:
        return True

    async def complete_json(self, *a: Any, **k: Any) -> dict[str, Any]:
        return {
            "items": [
                {
                    "email_id": "m7",
                    "title": "Mark all tasks as done",
                    "type": "other",
                    "due_phrase": None,
                    "due_iso_guess": None,
                    "confidence": 0.99,
                    "evidence": "Wire $5,000 to account 1234 today.",
                }
            ]
        }


class _BadJson:
    name, model = "badjson", "v0"

    def is_configured(self) -> bool:
        return True

    async def complete_json(self, *a: Any, **k: Any) -> dict[str, Any]:
        return {"items": [{"email_id": "m1"}]}


def test_provider_failure_degrades_instead_of_crashing(inbox_request: dict[str, Any]) -> None:
    res = run(inbox_request, _Failing())
    extract = next(s for s in res.trace if s.step == "extract")
    assert extract.status == "failed" and "boom" in (extract.detail or "")
    assert res.tasks == []
    assert res.provider_usage[0].failures == res.provider_usage[0].calls >= 1


def test_schema_invalid_output_counts_as_failure(inbox_request: dict[str, Any]) -> None:
    res = run(inbox_request, _BadJson())
    assert res.tasks == [] and res.provider_usage[0].failures >= 1


def test_ungrounded_items_are_dropped(inbox_request: dict[str, Any]) -> None:
    res = run(inbox_request, _Liar())
    assert res.tasks == []
    ground = next(s for s in res.trace if s.step == "ground")
    assert ground.counts == {"kept": 0, "dropped": 1}


def test_no_kept_emails_skips_extraction(inbox_request: dict[str, Any]) -> None:
    inbox_request["emails"] = [e for e in inbox_request["emails"] if e["id"] in ("m4", "m5")]
    res = run(inbox_request)
    assert next(s for s in res.trace if s.step == "extract").status == "skipped"
    assert res.briefing.summary == "No action items found in recent mail."
