from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.pipeline.models import CleanEmail, WorkItem
from app.schemas import LlmExtractionItem

SENT = datetime(2026, 10, 14, 4, 30, tzinfo=timezone.utc)


def email(**kw: Any) -> CleanEmail:
    base: dict[str, Any] = {
        "id": "m1",
        "thread_id": "t1",
        "from_name": "Priya",
        "from_email": "priya@example.com",
        "subject": "Deck for Tuesday",
        "text": "Hi,\n\nCan you send the deck before the call on Tuesday? Thanks!",
        "received_at": SENT,
    }
    base.update(kw)
    return CleanEmail(**base)


def raw(**kw: Any) -> LlmExtractionItem:
    base: dict[str, Any] = {
        "email_id": "m1",
        "title": "Send the deck to Priya",
        "type": "send",
        "due_phrase": "before the call on Tuesday",
        "due_iso_guess": None,
        "confidence": 0.9,
        "evidence": "Can you send the deck before the call on Tuesday?",
    }
    base.update(kw)
    return LlmExtractionItem(**base)


def work(email_kw: dict[str, Any] | None = None, **raw_kw: Any) -> WorkItem:
    return WorkItem(email=email(**(email_kw or {})), raw=raw(**raw_kw), extracted_by="test/stub")
