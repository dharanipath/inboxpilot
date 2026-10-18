from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest

from app.ask import answer, filter_tasks
from app.llm.base import ProviderError
from app.llm.heuristic import HeuristicProvider
from app.llm.router import LLMRouter
from app.pipeline.briefing import build_briefing
from app.schemas import AskRequest, Task, UserContext
from tests.test_router import Scripted

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 10, 14, 9, 0, tzinfo=IST)  # Wednesday
USER = UserContext(email="sam@example.com", name="Sam", timezone="Asia/Kolkata", now=NOW)


def task(
    tid: str,
    title: str,
    due: str | None,
    *,
    type_: str = "other",
    bucket: str = "week",
    sender: str = "Priya",
    email: str = "priya@example.com",
) -> Task:
    return Task.model_validate(
        {
            "id": tid,
            "email_id": "m",
            "title": title,
            "type": type_,
            "due_phrase": None,
            "due_date": due,
            "due_at": None,
            "has_time": False,
            "date_source": "resolver",
            "priority": "P2",
            "priority_score": 40,
            "priority_reasons": [],
            "confidence": 0.9,
            "evidence": "x" * 10,
            "bucket": bucket,
            "extracted_by": "t",
            "source": {
                "from_name": sender,
                "from_email": email,
                "subject": "s",
                "received_at": "2026-10-13T00:00:00Z",
                "thread_id": "t",
            },
        }
    )


TASKS = [
    task("t1", "Send the deck", "2026-10-15", type_="send"),
    task(
        "t2",
        "Pay invoice INV-2043",
        "2026-10-20",
        type_="payment",
        sender="Acme Billing",
        email="billing@acme.com",
    ),
    task(
        "t3",
        "Submit expense report",
        "2026-10-12",
        type_="deadline",
        bucket="overdue",
        sender="Finance",
        email="finance@corp.com",
    ),
    task(
        "t4",
        "Attend interview",
        "2026-10-16",
        type_="meeting",
        sender="Neha",
        email="hr@talent.com",
    ),
    task("t5", "Maybe reply", None, bucket="needs_review"),
]


def ids(question: str) -> list[str]:
    return [t.id for t in filter_tasks(question, TASKS, "Asia/Kolkata", NOW)]


def test_filters_by_date_bound() -> None:
    assert ids("What's due before Friday?") == ["t1", "t3", "t4"]
    assert ids("What is due on Friday?") == ["t4"]
    assert ids("anything due by tomorrow") == ["t1", "t3"]


def test_filters_by_person_type_and_overdue() -> None:
    assert ids("What do I owe Priya?") == ["t1"]
    assert ids("Which bills do I need to pay?") == ["t2"]
    assert ids("What's overdue?") == ["t3"]
    assert ids("any meetings this week?") == ["t4"]


def test_low_confidence_tasks_are_not_used() -> None:
    assert "t5" not in ids("what should I do?")


def ask(router: LLMRouter, question: str) -> Any:
    return asyncio.run(answer(AskRequest(user=USER, question=question, tasks=TASKS), router))


def test_rules_answer_without_llm() -> None:
    res = ask(LLMRouter([HeuristicProvider()]), "What do I owe Priya?")
    assert res.generated_by == "rules" and res.cited_task_ids == ["t1"]
    assert res.answer == "1 task: Send the deck (due Thu 15 Oct)."
    nothing = ask(LLMRouter([HeuristicProvider()]), "What's due on Sunday?")
    assert (
        nothing.answer == "Nothing in your task list matches that." and nothing.cited_task_ids == []
    )


def test_llm_answer_cannot_cite_unknown_ids() -> None:
    llm = Scripted(
        "groq", {"answer": "Send Priya the deck by Thursday.", "task_ids": ["t1", "t1", "made-up"]}
    )
    res = ask(LLMRouter([llm, HeuristicProvider()]), "What do I owe Priya?")
    assert res.generated_by == "groq" and res.cited_task_ids == ["t1"]
    assert "<tasks>" in llm.calls[0] and "id=t1" in llm.calls[0]


def test_llm_failure_falls_back_to_rules() -> None:
    res = ask(LLMRouter([Scripted("groq", ProviderError("500")), HeuristicProvider()]), "overdue?")
    assert res.generated_by == "rules" and res.cited_task_ids == ["t3"]


# ---------------------------------------------------------------- briefing


def brief(router: LLMRouter, tasks: list[Task], use_llm: bool = True) -> Any:
    return asyncio.run(
        build_briefing(
            tasks,
            router=router,
            user_name="Sam",
            today_line="Today is Wednesday.",
            horizon_days=7,
            use_llm=use_llm,
        )
    )


def test_llm_briefing_keeps_deterministic_counts() -> None:
    llm = Scripted("groq", {"headline": "Busy week", "summary": "Start with the expense report."})
    b, attempts, detail = brief(LLMRouter([llm, HeuristicProvider()]), TASKS)
    assert (b.headline, b.generated_by, detail) == ("Busy week", "groq", "briefing by groq")
    assert b.counts.overdue == 1 and b.counts.needs_review == 1
    assert len(attempts) == 1 and "Maybe reply" not in llm.calls[0]


def test_briefing_falls_back_to_template() -> None:
    bad = Scripted("groq", {"headline": ""})
    b, attempts, detail = brief(LLMRouter([bad, HeuristicProvider()]), TASKS)
    assert b.generated_by == "template" and detail == "template briefing (LLM failed)"
    assert attempts[0].outcome == "invalid"

    _, _, detail = brief(LLMRouter([HeuristicProvider()]), TASKS)
    assert detail == "template briefing (no LLM configured)"
    _, _, detail = brief(LLMRouter([Scripted("groq")]), [])
    assert detail == "template briefing (nothing to summarise)"
    _, _, detail = brief(LLMRouter([Scripted("groq")]), TASKS, use_llm=False)
    assert detail == "template briefing"


def test_briefing_date_label() -> None:
    assert date(2026, 10, 15).strftime("%a %d %b") == "Thu 15 Oct"


def test_times_are_shown_in_the_users_timezone_not_utc() -> None:
    """Regression: the gateway sends due_at in UTC; 07:30Z is 1:00 PM in IST."""
    utc_task = task("t9", "Send forecast", "2026-10-14", type_="send", bucket="today").model_copy(
        update={"due_at": datetime(2026, 10, 14, 7, 30, tzinfo=timezone.utc), "has_time": True}
    )
    res = asyncio.run(
        answer(
            AskRequest(user=USER, question="what is due today?", tasks=[utc_task]),
            LLMRouter([HeuristicProvider()]),
        )
    )
    assert "due today at 1:00 PM" in res.answer
    b, _, _ = asyncio.run(
        build_briefing(
            [utc_task],
            router=LLMRouter([HeuristicProvider()]),
            user_name="Sam",
            today_line="",
            horizon_days=7,
            use_llm=False,
            timezone_name="Asia/Kolkata",
        )
    )
    assert "due today at 1:00 PM" in b.summary


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Morning Briefing for Pala Dharanipathi", "Daily briefing for Pala Dharanipathi"),
        ("Good morning, Sam! Start with the deck.", "Start with the deck."),
        ("Good evening Sam. Two things are due.", "Two things are due."),
        ("Hi Sam, the invoice is overdue.", "The invoice is overdue."),
        ("Your evening update: pay the invoice.", "Your daily update: pay the invoice."),
        ("Send the deck to Priya before the call.", "Send the deck to Priya before the call."),
        ("Review the morning standup notes.", "Review the morning standup notes."),
    ],
)
def test_briefing_never_carries_its_own_greeting(text: str, expected: str) -> None:
    from app.pipeline.briefing import strip_greeting

    assert strip_greeting(text) == expected


# ------------------------------------------------- the selected model writes the briefing


def _two_models() -> tuple[Scripted, Scripted, LLMRouter]:
    """The server has Gemini and Groq configured; Gemini is first in the default order."""
    text = {"headline": "Two things need you", "summary": "Send the deck first."}
    gemini, groq = Scripted("gemini", text), Scripted("groq", text)
    return gemini, groq, LLMRouter([gemini, groq, HeuristicProvider()])


def _brief_with(router: LLMRouter, order: list[str] | None) -> Any:
    return asyncio.run(
        build_briefing(
            TASKS,
            router=router,
            user_name="Sam",
            today_line="Today is Wednesday.",
            horizon_days=7,
            use_llm=True,
            order=order,
        )
    )


def test_briefing_is_written_by_the_selected_model_not_the_first_in_the_list() -> None:
    """Regression: with Groq selected, the briefing still said "Written by gemini"."""
    gemini, groq, router = _two_models()
    briefing, _, _ = _brief_with(router, ["groq", "heuristic"])
    assert briefing.generated_by == "groq"
    assert groq.calls and not gemini.calls  # Gemini was never even asked

    gemini.calls.clear()
    groq.calls.clear()
    briefing, _, _ = _brief_with(router, ["gemini", "heuristic"])
    assert briefing.generated_by == "gemini" and not groq.calls


def test_a_selected_model_that_fails_falls_back_to_rules_and_says_so() -> None:
    groq = Scripted("groq", ProviderError("groq: HTTP 500"))
    gemini = Scripted("gemini", {"headline": "h", "summary": "s"})
    router = LLMRouter([gemini, groq, HeuristicProvider()])
    briefing, _, detail = _brief_with(router, ["groq", "heuristic"])
    assert briefing.generated_by == "template"  # never silently switched to another AI model
    assert not gemini.calls
    assert "LLM failed" in detail


def test_rules_only_never_sends_tasks_to_any_model() -> None:
    gemini, groq, router = _two_models()
    briefing, attempts, detail = _brief_with(router, ["heuristic"])
    assert briefing.generated_by == "template" and attempts == []
    assert not gemini.calls and not groq.calls
    assert "no LLM" in detail

    res = asyncio.run(
        answer(
            AskRequest.model_validate(
                {
                    "user": USER.model_dump(mode="json"),
                    "question": "what is due this week?",
                    "tasks": [t.model_dump(mode="json") for t in TASKS],
                    "options": {"providers": ["heuristic"]},
                }
            ),
            router,
        )
    )
    assert res.generated_by == "rules"
    assert not gemini.calls and not groq.calls


def test_ask_uses_the_selected_model() -> None:
    gemini = Scripted("gemini", {"answer": "From Gemini.", "task_ids": ["t1"]})
    groq = Scripted("groq", {"answer": "From Groq.", "task_ids": ["t1"]})
    router = LLMRouter([gemini, groq, HeuristicProvider()])
    res = asyncio.run(
        answer(
            AskRequest.model_validate(
                {
                    "user": USER.model_dump(mode="json"),
                    "question": "what do I owe Priya?",
                    "tasks": [t.model_dump(mode="json") for t in TASKS],
                    "options": {"providers": ["groq", "heuristic"]},
                }
            ),
            router,
        )
    )
    assert res.generated_by == "groq" and res.answer == "From Groq."
    assert not gemini.calls
