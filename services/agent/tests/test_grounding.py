from __future__ import annotations

from typing import Any

from app.pipeline.grounding import ground
from app.pipeline.models import WorkItem
from tests.factories import email, raw


def _ground(
    email_kw: dict[str, Any] | None = None, **raw_kw: Any
) -> tuple[list[WorkItem], dict[str, int]]:
    e = email(**(email_kw or {}))
    return ground([(raw(**raw_kw), "test/stub")], {e.id: e})


def test_keeps_item_with_exact_evidence() -> None:
    kept, dropped = _ground()
    assert len(kept) == 1 and dropped == {}
    assert kept[0].extracted_by == "test/stub"
    assert kept[0].email.id == "m1"


def test_tolerates_case_whitespace_and_smart_quotes() -> None:
    kept, _ = _ground(
        {"text": "Please  review   the “Q3 plan”\nbefore Friday’s sync."},
        evidence='please review the "Q3 plan" before Friday\'s sync.',
        due_phrase=None,
    )
    assert len(kept) == 1


def test_drops_hallucinated_evidence() -> None:
    kept, dropped = _ground(evidence="Please wire $10,000 to the new account today.")
    assert kept == [] and dropped == {"evidence_not_found": 1}


def test_drops_unknown_email() -> None:
    kept, dropped = _ground(email_id="someone-else")
    assert kept == [] and dropped == {"unknown_email": 1}


def test_drops_too_short_evidence() -> None:
    kept, dropped = _ground(evidence="the")
    assert kept == [] and dropped == {"evidence_too_short": 1}


def test_evidence_may_come_from_subject() -> None:
    kept, _ = _ground(
        {"subject": "Action required: sign the NDA by Friday", "text": "See attached."},
        evidence="Action required: sign the NDA by Friday",
        due_phrase="by Friday",
    )
    assert len(kept) == 1


def test_invented_due_phrase_is_removed_and_confidence_lowered() -> None:
    kept, _ = _ground(due_phrase="by next Monday", confidence=0.9)
    assert kept[0].raw.due_phrase is None
    assert kept[0].raw.confidence == 0.72
    assert kept[0].notes == ["due phrase not in email"]
