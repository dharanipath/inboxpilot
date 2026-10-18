"""Agent 7b — Planner: bucket, sort, build contract Tasks and the daily briefing."""

from __future__ import annotations

from collections import Counter
from datetime import date

from app.pipeline.dedupe import task_id
from app.pipeline.models import WorkItem
from app.pipeline.temporal import zone_for
from app.schemas import Briefing, Bucket, BucketCounts, Task, TaskSource

BUCKET_ORDER: list[Bucket] = ["overdue", "today", "week", "later", "undated", "needs_review"]


def bucket_for(
    due_date: date | None, confidence: float, today: date, horizon_days: int, low_confidence: float
) -> Bucket:
    if confidence < low_confidence:
        return "needs_review"
    if due_date is None:
        return "undated"
    days = (due_date - today).days
    if days < 0:
        return "overdue"
    if days == 0:
        return "today"
    if days <= horizon_days:
        return "week"
    return "later"


def build_tasks(
    items: list[WorkItem], today: date, horizon_days: int, low_confidence: float
) -> list[Task]:
    tasks: list[Task] = []
    for item in items:
        res, pr, raw, email = item.resolution, item.priority, item.raw, item.email
        assert res is not None and pr is not None, "dates and priority must run before planning"
        tasks.append(
            Task(
                id=task_id(email.id, raw.evidence),
                email_id=email.id,
                title=raw.title.strip()[:80],
                details="; ".join(item.notes) or None,
                type=raw.type,
                due_phrase=raw.due_phrase,
                due_date=res.due_date,
                due_at=res.due_at,
                has_time=res.has_time,
                date_source=res.source,
                priority=pr.priority,
                priority_score=pr.score,
                priority_base=pr.base,
                priority_reasons=pr.reasons,
                confidence=raw.confidence,
                evidence=raw.evidence.strip(),
                bucket=bucket_for(
                    res.due_date, raw.confidence, today, horizon_days, low_confidence
                ),
                source=TaskSource(
                    from_name=email.from_name,
                    from_email=email.from_email,
                    subject=email.subject,
                    received_at=email.received_at,
                    thread_id=email.thread_id,
                ),
                extracted_by=item.extracted_by,
            )
        )
    tasks.sort(
        key=lambda t: (
            BUCKET_ORDER.index(t.bucket),
            -t.priority_score,
            t.due_at.isoformat() if t.due_at else "",
            t.due_date or date.max,
            t.id,
        )
    )
    return tasks


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def when_label(task: Task, timezone_name: str | None = None) -> str:
    """Human label for a task's due time, as the user would read it in their own timezone.

    Tasks coming back from the gateway carry UTC timestamps, so always convert before formatting.
    """
    if task.bucket == "overdue" and task.due_date:
        return f"overdue since {task.due_date.strftime('%a %d %b')}"
    if task.due_at:
        local = task.due_at.astimezone(zone_for(timezone_name)) if timezone_name else task.due_at
        h = local.hour % 12 or 12
        clock = f"{h}:{local.minute:02d} {'PM' if local.hour >= 12 else 'AM'}"
        day = "today" if task.bucket == "today" else local.strftime("%a %d %b")
        return f"due {day} at {clock}"
    if task.bucket == "today":
        return "due today"
    if task.due_date:
        return f"due {task.due_date.strftime('%a %d %b')}"
    return "no due date"


def template_briefing(
    tasks: list[Task], horizon_days: int, timezone_name: str | None = None
) -> Briefing:
    c = Counter(t.bucket for t in tasks)
    counts = BucketCounts(**{b: c.get(b, 0) for b in BUCKET_ORDER})

    headline_parts = [
        _plural(counts.today, "thing") + " today" if counts.today else "Nothing due today"
    ]
    if counts.overdue:
        headline_parts.append(f"{counts.overdue} overdue")
    headline = ", ".join(headline_parts)

    sentences: list[str] = []
    actionable = [t for t in tasks if t.bucket in ("overdue", "today", "week")]
    if actionable:
        top = max(actionable, key=lambda t: t.priority_score)
        sentences.append(
            f"Start with “{top.title}” ({when_label(top, timezone_name)}, {top.priority})."
        )
        rest = len(actionable) - 1
        if rest:
            sentences.append(
                f"{_plural(rest, 'more item')} due within the next {horizon_days} days."
            )
    elif tasks:
        sentences.append(f"Nothing is due in the next {horizon_days} days.")
    else:
        sentences.append("No action items found in recent mail.")
    if counts.needs_review:
        sentences.append(
            f"{_plural(counts.needs_review, 'item')} need a quick review (low confidence)."
        )

    return Briefing(
        headline=headline, summary=" ".join(sentences[:3]), generated_by="template", counts=counts
    )
