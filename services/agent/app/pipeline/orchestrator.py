"""Hand-written pipeline orchestrator (ADR 0005). Records one TraceStep per agent."""

from __future__ import annotations

import time
import uuid
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

from app.config import Settings
from app.llm.prompts import today_line
from app.llm.router import LLMRouter
from app.pipeline.briefing import build_briefing
from app.pipeline.dedupe import dedupe
from app.pipeline.extract import extract, usage_from_attempts
from app.pipeline.grounding import ground
from app.pipeline.models import CleanEmail, WorkItem
from app.pipeline.planner import build_tasks
from app.pipeline.preprocess import clean_body
from app.pipeline.prioritize import score_task
from app.pipeline.temporal import resolve_due, zone_for
from app.pipeline.triage import triage
from app.schemas import (
    ExtractRequest,
    ExtractResponse,
    SkippedEmail,
    StepName,
    StepStatus,
    TraceStep,
    plain_keys,
)


@dataclass
class _Step:
    status: StepStatus = "ok"
    detail: str | None = None
    counts: dict[str, int] = field(default_factory=dict)


class Pipeline:
    def __init__(self, router: LLMRouter, settings: Settings) -> None:
        self.router = router
        self.settings = settings

    async def run(self, req: ExtractRequest) -> ExtractResponse:
        trace: list[TraceStep] = []
        router = self.router.with_keys(plain_keys(req.options))  # the user's own keys, if any

        @contextmanager
        def step(name: StepName, agent: str) -> Iterator[_Step]:
            s = _Step()
            started = time.perf_counter()
            try:
                yield s
            finally:
                trace.append(
                    TraceStep(
                        step=name,
                        agent=agent,
                        status=s.status,
                        duration_ms=int((time.perf_counter() - started) * 1000),
                        detail=s.detail,
                        counts=s.counts,  # {} when a step had nothing to count; never null
                    )
                )

        user, opts = req.user, req.options
        zone = zone_for(user.timezone)
        today = user.now.astimezone(zone).date()
        attempts = []

        with step("preprocess", "PreprocessAgent") as s:
            cleaned: list[CleanEmail] = []
            redactions = 0
            for e in req.emails:
                text, n = clean_body(e.body_text, self.settings.max_body_chars)
                redactions += n
                cleaned.append(
                    CleanEmail(
                        id=e.id,
                        thread_id=e.thread_id,
                        from_name=e.from_name,
                        from_email=e.from_email,
                        subject=e.subject,
                        text=text,
                        received_at=e.received_at,
                        labels=tuple(e.labels),
                        list_unsubscribe=e.list_unsubscribe,
                        redactions=n,
                    )
                )
            s.counts = {"in": len(req.emails), "out": len(cleaned), "pii_redacted": redactions}

        with step("triage", "TriageAgent") as s:
            kept, skipped = triage(cleaned)
            s.counts = {"kept": len(kept), "skipped": len(skipped)}
            reasons = Counter(sk.reason for sk in skipped)
            s.detail = ", ".join(f"{n} {r}" for r, n in sorted(reasons.items())) or None

        with step("extract", "ExtractionAgent") as s:
            raws = []
            if not kept:
                s.status, s.detail = "skipped", "no emails to extract from"
            else:
                ex = await extract(
                    kept,
                    router=router,
                    user_name=user.name,
                    user_email=user.email,
                    now=user.now,
                    timezone_name=user.timezone,
                    batch_size=self.settings.extract_batch_size,
                    concurrency=self.settings.extract_concurrency,
                    order=opts.providers,
                )
                raws = ex.items
                attempts.extend(ex.attempts)
                s.counts = {
                    "batches": ex.batches,
                    "failed_batches": ex.failed_batches,
                    "items": len(raws),
                }
                s.detail = "; ".join([*ex.chains, *ex.errors[:1]]) or None
                if ex.failed_batches == ex.batches:
                    s.status = "failed"
                elif ex.degraded:
                    s.status = "degraded"

        with step("ground", "GroundingAgent") as s:
            items, dropped = ground(raws, {e.id: e for e in kept})
            s.counts = {"kept": len(items), "dropped": sum(dropped.values())}
            s.detail = ", ".join(f"{n} {r}" for r, n in sorted(dropped.items())) or None

        with step("dates", "TemporalAgent") as s:
            for item in items:
                item.resolution = resolve_due(
                    item.raw.due_phrase,
                    item.email.received_at,
                    user.timezone,
                    item.raw.due_iso_guess,
                )
            sources = Counter(i.resolution.source for i in items if i.resolution)
            s.counts = {str(k): v for k, v in sources.items()}

        with step("priority", "PriorityAgent") as s:
            for item in items:
                item.priority = score_task(
                    task_type=item.raw.type,
                    title=item.raw.title,
                    evidence=item.raw.evidence,
                    due_date=item.resolution.due_date if item.resolution else None,
                    confidence=item.raw.confidence,
                    from_email=item.email.from_email,
                    vip_senders=user.vip_senders,
                    today=today,
                    subject=item.email.subject,
                )
            s.counts = dict(Counter(i.priority.priority for i in items if i.priority))

        with step("plan", "PlannerAgent") as s:
            unique, merged = dedupe(items)
            tasks = build_tasks(unique, today, opts.horizon_days, self.settings.low_confidence)
            briefing, briefing_attempts, s.detail = await build_briefing(
                tasks,
                router=router,
                user_name=user.name,
                today_line=today_line(user.now, user.timezone),
                horizon_days=opts.horizon_days,
                use_llm=opts.use_llm_briefing,
                timezone_name=user.timezone,
                order=opts.providers,
            )
            attempts.extend(briefing_attempts)
            if "failed" in s.detail or any(a.outcome != "ok" for a in briefing_attempts):
                s.status = "degraded"
            s.counts = {"tasks": len(tasks), "merged": merged}
            skipped.extend(_no_action(kept, items))

        return ExtractResponse(
            run_id=f"run_{uuid.uuid4().hex[:16]}",
            tasks=tasks,
            skipped=skipped,
            trace=trace,
            provider_usage=usage_from_attempts(attempts),
            briefing=briefing,
        )


def _no_action(kept: list[CleanEmail], items: list[WorkItem]) -> list[SkippedEmail]:
    with_items = {i.email.id for i in items}
    return [
        SkippedEmail(email_id=e.id, reason="no_action_items")
        for e in kept
        if e.id not in with_items
    ]
