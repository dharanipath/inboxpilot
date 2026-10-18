"""POST /v1/ask — answer questions using ONLY the user's tasks, citing task ids.

A deterministic filter always runs. If an LLM is available it phrases the answer, but it may
only cite ids it was given; with no LLM (or on failure) the rules answer stands alone.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.llm.base import AllProvidersFailed
from app.llm.prompts import ask_system, neutralise_body, today_line
from app.llm.router import LLMRouter
from app.pipeline.planner import when_label
from app.pipeline.temporal import find_due_phrase, resolve_due
from app.schemas import AskRequest, AskResponse, Task

ASK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["answer", "task_ids"],
    "properties": {
        "answer": {"type": "string"},
        "task_ids": {"type": "array", "items": {"type": "string"}},
    },
}
MAX_LISTED = 5
MAX_TASKS_IN_PROMPT = 100

_TYPE_WORDS: list[tuple[re.Pattern[str], set[str]]] = [
    (re.compile(r"\b(pay|payment|bill|invoice|owe money)\b", re.I), {"payment"}),
    (re.compile(r"\b(meeting|meetings|interview|call|calls)\b", re.I), {"meeting", "call"}),
    (re.compile(r"\b(review|approve)\b", re.I), {"review"}),
    (re.compile(r"\b(reply|respond|answer)\b", re.I), {"reply"}),
]
_STOP_NAMES = {"the", "and", "team", "noreply", "no-reply", "info", "billing", "support"}


class _AskText(BaseModel):
    model_config = ConfigDict(extra="ignore")
    answer: str = Field(min_length=1, max_length=1000)
    task_ids: list[str] = Field(default_factory=list)


def _sender_tokens(t: Task) -> set[str]:
    raw = f"{t.source.from_name or ''} {t.source.from_email.split('@')[0]}"
    return {w for w in re.split(r"[^a-z0-9]+", raw.lower()) if len(w) >= 3} - _STOP_NAMES


def filter_tasks(question: str, tasks: list[Task], tz: str, now: datetime) -> list[Task]:
    """Deterministic filter: date bound, overdue, task type and sender name."""
    q = question.lower()
    selected = [t for t in tasks if t.bucket != "needs_review"]

    if re.search(r"\b(overdue|late)\b", q):
        selected = [t for t in selected if t.bucket == "overdue"]
    else:
        phrase = find_due_phrase(question)
        if phrase:
            bound = resolve_due(phrase, now, tz).due_date
            if bound is not None:
                exact = re.search(r"\bon\b", q) and not re.search(r"\b(before|by|until)\b", q)
                selected = [
                    t
                    for t in selected
                    if t.due_date is not None
                    and (t.due_date == bound if exact else t.due_date <= bound)
                ]

    for pattern, types in _TYPE_WORDS:
        if pattern.search(q):
            selected = [t for t in selected if t.type in types]
            break

    words = set(re.split(r"[^a-z0-9]+", q))
    by_person = [t for t in selected if _sender_tokens(t) & words]
    if by_person:
        selected = by_person
    return selected


def rules_answer(matches: list[Task], timezone_name: str | None = None) -> str:
    if not matches:
        return "Nothing in your task list matches that."
    listed = "; ".join(f"{t.title} ({when_label(t, timezone_name)})" for t in matches[:MAX_LISTED])
    more = f" and {len(matches) - MAX_LISTED} more" if len(matches) > MAX_LISTED else ""
    noun = "task" if len(matches) == 1 else "tasks"
    return f"{len(matches)} {noun}: {listed}{more}."


async def answer(req: AskRequest, router: LLMRouter) -> AskResponse:
    matches = filter_tasks(req.question, req.tasks, req.user.timezone, req.user.now)
    fallback = AskResponse(
        answer=rules_answer(matches, req.user.timezone),
        cited_task_ids=[t.id for t in matches],
        generated_by="rules",
    )
    order = req.options.providers  # the user's selected model
    if not req.tasks or not router.has_llm(order):
        return fallback

    listed = req.tasks[:MAX_TASKS_IN_PROMPT]
    lines = "\n".join(
        f"- id={t.id} [{t.priority}] {neutralise_body(t.title)} "
        f"({when_label(t, req.user.timezone)}; from {t.source.from_name or t.source.from_email})"
        for t in listed
    )
    user = (
        f"{today_line(req.user.now, req.user.timezone)}\n<tasks>\n{lines}\n</tasks>\n"
        f"Question: {req.question}"
    )
    try:
        result = await router.complete(
            system=ask_system(req.user.name),
            user=user,
            schema=ASK_SCHEMA,
            validate=_AskText.model_validate,
            order=order,
            exclude=("heuristic",),
        )
    except AllProvidersFailed:
        return fallback
    known = {t.id for t in listed}
    cited = [i for i in dict.fromkeys(result.value.task_ids) if i in known]  # no invented ids
    return AskResponse(
        answer=result.value.answer.strip(), cited_task_ids=cited, generated_by=result.provider
    )
