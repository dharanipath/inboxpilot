"""Optional LLM-written briefing. Counts stay deterministic; on any failure the template wins."""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.llm.base import AllProvidersFailed
from app.llm.prompts import briefing_system, neutralise_body
from app.llm.router import Attempt, LLMRouter
from app.pipeline.planner import template_briefing, when_label
from app.schemas import Briefing, Task

BRIEFING_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["headline", "summary"],
    "properties": {"headline": {"type": "string"}, "summary": {"type": "string"}},
}
MAX_TASKS_IN_PROMPT = 15


class _BriefingText(BaseModel):
    model_config = ConfigDict(extra="ignore")
    headline: str = Field(min_length=1, max_length=80)
    summary: str = Field(min_length=1, max_length=600)


# The app greets the user for their local time; a model's own "Good morning" (or "Morning
# briefing") goes stale within hours of being cached, so it is removed deterministically.
_GREETING = re.compile(
    # greeting, an optional name ("Sam", "Pala Dharanipathi"), then its punctuation
    r"^\s*(?:good\s+(?:morning|afternoon|evening|day)|hello|hi|hey)\b"
    r"(?:[ ,]+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)?\s*[,.!:\-–—]+\s*",
    re.I,
)
_TIME_OF_DAY = re.compile(
    r"\b(?:this\s+)?(?:morning|afternoon|evening|tonight's|tonight)\s+(briefing|update|summary)\b",
    re.I,
)


def _daily(m: re.Match[str]) -> str:
    word = f"daily {m.group(1).lower()}"
    return word.capitalize() if m.start() == 0 else word


def strip_greeting(text: str) -> str:
    """Drop a leading greeting and time-of-day wording ("Morning briefing" -> "Daily briefing")."""
    out = _GREETING.sub("", text.strip(), count=1)
    out = _TIME_OF_DAY.sub(_daily, out)
    return out[:1].upper() + out[1:] if out else out


def _task_lines(tasks: list[Task], timezone_name: str | None) -> str:
    lines = []
    for t in tasks[:MAX_TASKS_IN_PROMPT]:
        sender = t.source.from_name or t.source.from_email
        lines.append(
            f"- [{t.priority}] {neutralise_body(t.title)} "
            f"({when_label(t, timezone_name)}; from {sender})"
        )
    return "\n".join(lines)


async def build_briefing(
    tasks: list[Task],
    *,
    router: LLMRouter,
    user_name: str | None,
    today_line: str,
    horizon_days: int,
    use_llm: bool,
    timezone_name: str | None = None,
    order: Sequence[str] | None = None,
) -> tuple[Briefing, list[Attempt], str]:
    """Return (briefing, LLM attempts, trace detail)."""
    template = template_briefing(tasks, horizon_days, timezone_name)
    if not use_llm:
        return template, [], "template briefing"
    actionable = [t for t in tasks if t.bucket != "needs_review"]
    if not actionable:
        return template, [], "template briefing (nothing to summarise)"
    if not router.has_llm(order):
        return template, [], "template briefing (no LLM configured)"

    user = (
        f"{today_line}\nCounts: {template.counts.model_dump()}\n"
        f"<tasks>\n{_task_lines(actionable, timezone_name)}\n</tasks>"
    )
    try:
        result = await router.complete(
            system=briefing_system(user_name),
            user=user,
            schema=BRIEFING_SCHEMA,
            validate=_BriefingText.model_validate,
            order=order,  # the user's selected model, not the server's default order
            exclude=("heuristic",),
        )
    except AllProvidersFailed as exc:
        return template, exc.attempts, "template briefing (LLM failed)"
    text = result.value
    briefing = Briefing(
        headline=strip_greeting(text.headline)[:80] or template.headline,
        summary=strip_greeting(text.summary) or template.summary,
        generated_by=result.provider,
        counts=template.counts,
    )
    return briefing, result.attempts, f"briefing by {result.chain()}"
