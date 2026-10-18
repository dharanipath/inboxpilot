"""Agent 4 — Grounding: every task must quote its email verbatim, or it is dropped.

This is the main defence against hallucinated tasks and against prompt injection that tries
to plant instructions the email never contained.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping

from app.pipeline.models import CleanEmail, WorkItem
from app.schemas import LlmExtractionItem

MIN_EVIDENCE_CHARS = 8
UNGROUNDED_DATE_PENALTY = 0.8

_QUOTES = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "–": "-", "—": "-"})


def normalise(text: str) -> str:
    text = text.translate(_QUOTES).lower()
    return re.sub(r"\s+", " ", text).strip()


def _strip_edges(text: str) -> str:
    return text.strip(" .!?,;:\"'")


def ground(
    raws: list[tuple[LlmExtractionItem, str]],
    emails: Mapping[str, CleanEmail],
) -> tuple[list[WorkItem], dict[str, int]]:
    """Pair each raw item (with the provider that produced it) to its email, or drop it."""
    kept: list[WorkItem] = []
    dropped: Counter[str] = Counter()
    for raw, extracted_by in raws:
        email = emails.get(raw.email_id)
        if email is None:
            dropped["unknown_email"] += 1
            continue
        evidence = _strip_edges(normalise(raw.evidence))
        if len(evidence) < MIN_EVIDENCE_CHARS:
            dropped["evidence_too_short"] += 1
            continue
        haystack = normalise(f"{email.subject}\n{email.text}")
        if evidence not in haystack:
            dropped["evidence_not_found"] += 1
            continue

        item = WorkItem(email=email, raw=raw, extracted_by=extracted_by)
        confidence = min(max(raw.confidence, 0.0), 1.0)
        due_phrase = raw.due_phrase
        if due_phrase and _strip_edges(normalise(due_phrase)) not in haystack:
            due_phrase = None
            confidence = round(confidence * UNGROUNDED_DATE_PENALTY, 4)
            item.notes.append("due phrase not in email")
        item.raw = raw.model_copy(update={"due_phrase": due_phrase, "confidence": confidence})
        kept.append(item)
    return kept, dict(dropped)
