"""Agent 7a — Dedupe: one task per real-world action, even when a thread repeats it."""

from __future__ import annotations

import hashlib
from difflib import SequenceMatcher

from app.pipeline.grounding import normalise
from app.pipeline.models import WorkItem

TITLE_SIMILARITY = 0.6


def task_id(email_id: str, evidence: str) -> str:
    """Stable across providers and re-syncs: evidence is verbatim email text (SPEC Q1)."""
    digest = hashlib.sha1(f"{email_id}\n{normalise(evidence)}".encode()).hexdigest()
    return f"t_{digest}"


def _due(item: WorkItem) -> object:
    return item.resolution.due_date if item.resolution else None


def _similar(a: str, b: str) -> bool:
    return SequenceMatcher(None, normalise(a), normalise(b)).ratio() >= TITLE_SIMILARITY


def dedupe(items: list[WorkItem]) -> tuple[list[WorkItem], int]:
    """Keep the most confident item of each duplicate group (earlier email wins ties)."""
    ordered = sorted(items, key=lambda i: (-i.raw.confidence, i.email.received_at))
    kept: list[WorkItem] = []
    seen_ids: set[str] = set()
    for item in ordered:
        tid = task_id(item.email.id, item.raw.evidence)
        if tid in seen_ids:
            continue
        if any(
            k.email.thread_id == item.email.thread_id
            and _due(k) == _due(item)
            and _similar(k.raw.title, item.raw.title)
            for k in kept
        ):
            continue
        seen_ids.add(tid)
        kept.append(item)

    # Same email, same type: an undated item is the same action as a dated one, split across
    # sentences ("Total due: Rs 500." / "Payment due date: 25 Oct.") — keep the dated one.
    dated = {(k.email.id, k.raw.type) for k in kept if _due(k) is not None}
    kept = [k for k in kept if _due(k) is not None or (k.email.id, k.raw.type) not in dated]
    return kept, len(items) - len(kept)
