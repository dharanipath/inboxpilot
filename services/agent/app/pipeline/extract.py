"""Agent 3 — Extraction: batches of emails → raw items, via the LLMRouter (ADR 0003)."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.llm.base import AllProvidersFailed
from app.llm.prompts import EXTRACTION_SCHEMA, system_prompt, user_prompt
from app.llm.router import FAILED_OUTCOMES, Attempt, LLMRouter, RouterResult
from app.pipeline.models import CleanEmail
from app.schemas import LlmExtraction, LlmExtractionItem, ProviderUsage


@dataclass
class ExtractionResult:
    items: list[tuple[LlmExtractionItem, str]] = field(default_factory=list)
    attempts: list[Attempt] = field(default_factory=list)
    chains: list[str] = field(default_factory=list)
    batches: int = 0
    failed_batches: int = 0
    degraded: bool = False
    errors: list[str] = field(default_factory=list)


def _validate(raw: dict[str, Any]) -> list[LlmExtractionItem]:
    return LlmExtraction.model_validate(raw).items


def _batches(emails: list[CleanEmail], size: int) -> list[list[CleanEmail]]:
    return [emails[i : i + size] for i in range(0, len(emails), size)]


def usage_from_attempts(attempts: Sequence[Attempt]) -> list[ProviderUsage]:
    """Aggregate per-provider usage for one run (order = first use)."""
    usage: dict[str, ProviderUsage] = {}
    for a in attempts:
        u = usage.setdefault(a.provider, ProviderUsage(provider=a.provider, model=a.model))
        u.calls += a.calls
        u.latency_ms += a.latency_ms
        if a.outcome == "cached":
            u.cache_hits += 1
        if a.outcome in FAILED_OUTCOMES:
            u.failures += 1
            u.last_error = a.error
    return list(usage.values())


async def extract(
    emails: list[CleanEmail],
    *,
    router: LLMRouter,
    user_name: str | None,
    user_email: str,
    now: datetime,
    timezone_name: str,
    batch_size: int,
    concurrency: int = 3,
    order: Sequence[str] | None = None,
) -> ExtractionResult:
    system = system_prompt(user_name, user_email)
    result = ExtractionResult()
    gate = asyncio.Semaphore(max(1, concurrency))

    async def run_batch(
        batch: list[CleanEmail],
    ) -> RouterResult[list[LlmExtractionItem]] | AllProvidersFailed:
        try:
            async with gate:
                return await router.complete(
                    system=system,
                    user=user_prompt(now, timezone_name, batch),
                    schema=EXTRACTION_SCHEMA,
                    validate=_validate,
                    order=order,
                )
        except AllProvidersFailed as exc:
            return exc

    batches = _batches(emails, batch_size)
    result.batches = len(batches)
    for outcome in await asyncio.gather(*(run_batch(b) for b in batches)):
        if isinstance(outcome, AllProvidersFailed):
            result.failed_batches += 1
            result.degraded = True
            result.errors.append(str(outcome))
            result.attempts.extend(outcome.attempts)
            continue
        result.attempts.extend(outcome.attempts)
        result.items.extend((item, outcome.tag) for item in outcome.value)
        if outcome.degraded:
            result.degraded = True
            result.chains.append(outcome.chain())
        elif outcome.chain() not in result.chains:
            result.chains.append(outcome.chain())
    return result
