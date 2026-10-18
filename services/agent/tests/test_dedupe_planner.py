from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from app.pipeline.dedupe import dedupe, task_id
from app.pipeline.planner import bucket_for, build_tasks, template_briefing
from app.pipeline.prioritize import PriorityResult
from app.pipeline.temporal import Resolution
from app.schemas import Task
from tests.factories import SENT, work

TODAY = date(2026, 10, 16)


def resolved(due: date | None = date(2026, 10, 20), score: int = 40, **kw: object):  # type: ignore[no-untyped-def]
    w = work(**kw)  # type: ignore[arg-type]
    w.resolution = Resolution(due, None, False, "resolver" if due else "none")
    w.priority = PriorityResult("P2", score, ["Due soon"], base=8)
    return w


def test_task_id_is_stable_and_ignores_whitespace_and_case() -> None:
    a = task_id("m1", "Can you send the deck?")
    assert a == task_id("m1", "  can you   SEND the deck? ")
    assert a != task_id("m2", "Can you send the deck?")
    assert a.startswith("t_") and len(a) == 42


def test_merges_same_task_repeated_in_thread() -> None:
    first = resolved(confidence=0.7)
    reply = resolved(
        email_kw={
            "id": "m2",
            "received_at": SENT + timedelta(hours=2),
            "text": "Reminder: please send the deck before the call on Tuesday.",
        },
        email_id="m2",
        title="Send the deck to Priya before call",
        evidence="please send the deck before the call on Tuesday.",
        confidence=0.9,
    )
    kept, merged = dedupe([first, reply])
    assert merged == 1
    assert [k.email.id for k in kept] == ["m2"]  # higher confidence wins


def test_keeps_tasks_with_different_due_dates_or_threads() -> None:
    a = resolved()
    b = resolved(due=date(2026, 10, 27), evidence="Send the deck again next week please.")
    c = resolved(email_kw={"id": "m3", "thread_id": "t9"}, email_id="m3")
    kept, merged = dedupe([a, b, c])
    assert merged == 0 and len(kept) == 3


def test_undated_item_merges_into_dated_one_of_same_type_in_same_email() -> None:
    text = "Total amount due: Rs. 500. Payment due date: 25 Oct 2026. Please reply to confirm."
    undated = resolved(
        due=None,
        email_kw={"text": text},
        type="payment",
        title="Pay the bill",
        evidence="Total amount due: Rs. 500.",
        confidence=0.9,
    )
    dated = resolved(
        due=date(2026, 10, 25),
        email_kw={"text": text},
        type="payment",
        title="Pay card statement",
        evidence="Payment due date: 25 Oct 2026.",
        confidence=0.6,
    )
    other_type = resolved(
        due=None,
        email_kw={"text": text},
        type="reply",
        title="Reply",
        evidence="Please reply to confirm.",
    )
    kept, merged = dedupe([undated, dated, other_type])
    assert merged == 1
    assert sorted(k.raw.type for k in kept) == ["payment", "reply"]
    assert next(k for k in kept if k.raw.type == "payment").raw.evidence.startswith("Payment due")


def test_exact_duplicate_items_collapse() -> None:
    kept, merged = dedupe([resolved(), resolved()])
    assert merged == 1 and len(kept) == 1


@pytest.mark.parametrize(
    ("due", "conf", "bucket"),
    [
        (date(2026, 10, 15), 0.9, "overdue"),
        (date(2026, 10, 16), 0.9, "today"),
        (date(2026, 10, 17), 0.9, "week"),
        (date(2026, 10, 23), 0.9, "week"),
        (date(2026, 10, 24), 0.9, "later"),
        (None, 0.9, "undated"),
        (date(2026, 10, 16), 0.49, "needs_review"),
    ],
)
def test_buckets(due: date | None, conf: float, bucket: str) -> None:
    assert bucket_for(due, conf, TODAY, 7, 0.5) == bucket


def _tasks() -> list[Task]:
    items = [
        resolved(
            due=date(2026, 10, 20),
            score=30,
            evidence="Can you send the deck before the call on Tuesday?",
        ),
        resolved(
            due=date(2026, 10, 16),
            score=55,
            title="Pay invoice",
            email_kw={"text": "Please pay the invoice today."},
            evidence="Please pay the invoice today.",
        ),
        resolved(
            due=date(2026, 10, 12),
            score=60,
            title="Submit report",
            email_kw={"text": "Submit the report by Monday."},
            evidence="Submit the report by Monday.",
        ),
        resolved(
            due=None,
            score=10,
            title="Maybe reply",
            confidence=0.3,
            email_kw={"text": "Maybe reply at some point."},
            evidence="Maybe reply at some point.",
        ),
    ]
    return build_tasks(items, TODAY, 7, 0.5)


def test_build_tasks_sorts_by_bucket_then_score() -> None:
    tasks = _tasks()
    assert [t.bucket for t in tasks] == ["overdue", "today", "week", "needs_review"]
    assert tasks[0].title == "Submit report"
    assert tasks[0].source.thread_id == "t1"


def test_template_briefing() -> None:
    b = template_briefing(_tasks(), 7)
    assert b.headline == "1 thing today, 1 overdue"
    assert b.counts.model_dump() == {
        "overdue": 1,
        "today": 1,
        "week": 1,
        "later": 0,
        "undated": 0,
        "needs_review": 1,
    }
    assert b.summary.startswith("Start with “Submit report” (overdue since Mon 12 Oct, P2).")
    assert "2 more items" in b.summary and "1 item need" in b.summary
    assert b.generated_by == "template"


def test_briefing_with_timed_task_and_empty_list() -> None:
    w = resolved(due=TODAY, score=80)
    at = datetime(2026, 10, 16, 15, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    w.resolution = Resolution(TODAY, at, True, "resolver")
    b = template_briefing(build_tasks([w], TODAY, 7, 0.5), 7)
    assert "due today at 3:00 PM" in b.summary
    empty = template_briefing([], 7)
    assert (empty.headline, empty.summary) == (
        "Nothing due today",
        "No action items found in recent mail.",
    )
