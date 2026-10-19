from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.prioritize import priority_for_score, score_task

TODAY = date(2026, 10, 16)


@pytest.mark.parametrize(
    ("score", "priority"),
    [
        (100, "P0"),
        (75, "P0"),
        (74, "P1"),
        (45, "P1"),
        (44, "P2"),
        (28, "P2"),
        (27, "P3"),
        (0, "P3"),
    ],
)
def test_thresholds(score: int, priority: str) -> None:
    assert priority_for_score(score) == priority


def _score(**kw: object) -> tuple[str, int, list[str]]:
    args: dict[str, object] = {
        "task_type": "other",
        "title": "Do the thing",
        "evidence": "Please do the thing.",
        "due_date": None,
        "confidence": 1.0,
        "from_email": "someone@example.com",
        "vip_senders": [],
        "today": TODAY,
    }
    args.update(kw)
    r = score_task(**args)  # type: ignore[arg-type]
    return r.priority, r.score, r.reasons


def test_vip_payment_due_today_is_p0() -> None:
    p, s, reasons = _score(
        task_type="payment", due_date=TODAY, from_email="CEO@co.com", vip_senders=["ceo@co.com"]
    )
    assert (p, s) == ("P0", 100)  # 75 + 15 + 15, clamped
    assert reasons == ["Due today", "Payment", "VIP sender"]


def test_matches_contract_fixture_send_in_four_days() -> None:
    p, s, reasons = _score(task_type="send", due_date=date(2026, 10, 20), confidence=0.86)
    assert (p, s) == ("P3", 21)  # (14 + 8) * (0.6 + 0.4*0.86) = 20.8
    assert reasons == ["Due in 4 days", "Send request"]


def test_interview_tomorrow_is_p1() -> None:
    p, s, reasons = _score(
        task_type="meeting", title="Attend interview with Acme", due_date=date(2026, 10, 17)
    )
    assert (p, s) == ("P1", 60)  # 42 + 18
    assert "Interview" in reasons


def test_overdue_urgent_deadline_is_p0() -> None:
    p, s, reasons = _score(
        task_type="deadline", evidence="URGENT: submit the report.", due_date=date(2026, 10, 14)
    )
    assert (p, s) == ("P0", 100)  # 80 + 14 + 12, clamped
    assert reasons[0] == "Overdue by 2 days"
    assert "Marked urgent" in reasons


@pytest.mark.parametrize(
    ("due", "points", "reason"),
    [
        (date(2026, 10, 15), 80, "Overdue by 1 day"),
        (date(2026, 10, 16), 75, "Due today"),
        (date(2026, 10, 17), 42, "Due tomorrow"),
        (date(2026, 10, 19), 24, "Due in 3 days"),
        (date(2026, 10, 23), 14, "Due in 7 days"),
        (date(2026, 10, 24), 6, "Due in 8 days"),
        (None, 4, "No due date"),
    ],
)
def test_urgency_bands(due: date | None, points: int, reason: str) -> None:
    _, s, reasons = _score(due_date=due)
    assert s == points + 4  # + "other" type weight
    assert reasons[0] == reason


def test_low_confidence_scales_score_down() -> None:
    high = _score(task_type="payment", due_date=TODAY, confidence=1.0)
    low = _score(task_type="payment", due_date=TODAY, confidence=0.0)
    assert high[1] == 90 and low[1] == 54  # 90 * 0.6
    assert any("confidence" in r.lower() for r in low[2])


def test_vip_domain_match() -> None:
    _, _, reasons = _score(from_email="boss@bigclient.com", vip_senders=["@bigclient.com"])
    assert "VIP sender" in reasons


def test_score_is_clamped() -> None:
    _, s, _ = _score(
        task_type="meeting",
        title="Interview — ASAP",
        due_date=date(2026, 10, 1),
        from_email="a@b.c",
        vip_senders=["a@b.c"],
    )
    assert s == 100  # 80 + 18 + 15 + 12 = 125, clamped to 100


def test_urgent_subject_line_counts() -> None:
    _, _, reasons = _score(subject="URGENT: Board prep")
    assert "Marked urgent" in reasons
    _, _, plain = _score(subject="Board prep")
    assert "Marked urgent" not in plain


# ---------------------------------------------------------------- shared re-scoring table


def _cases() -> tuple[date, list[dict[str, object]]]:
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures/priority_cases.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    return date.fromisoformat(data["today"]), data["cases"]


@pytest.mark.parametrize("case", _cases()[1], ids=lambda c: str(c["name"]))
def test_combine_matches_shared_table(case: dict[str, object]) -> None:
    """The gateway re-scores with the same table (services/api/tests/unit.test.ts)."""
    from app.pipeline.prioritize import combine

    today = _cases()[0]
    due = date.fromisoformat(str(case["due_date"])) if case["due_date"] else None
    score, label = combine(int(str(case["base"])), due, float(str(case["confidence"])), today)
    assert (score, label, priority_for_score(score)) == (
        case["score"],
        case["urgency_label"],
        case["priority"],
    )


def test_score_task_exposes_base_and_puts_urgency_first() -> None:
    r = score_task(
        task_type="payment",
        title="Pay",
        evidence="Pay now, urgent.",
        due_date=TODAY,
        confidence=0.5,
        from_email="ceo@co.com",
        vip_senders=["ceo@co.com"],
        today=TODAY,
    )
    assert r.base == 15 + 15 + 12
    assert r.reasons[0] == "Due today"
    assert r.reasons[-1] == "Lowered for 50% confidence"
