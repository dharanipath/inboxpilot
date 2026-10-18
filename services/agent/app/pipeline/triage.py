"""Agent 2 — Triage: drop promotions, social, newsletters and automated mail before any LLM call.

Idempotency across syncs (skipping already-processed messages) is the gateway's job; here we
only drop duplicates inside one request.
"""

from __future__ import annotations

import re

from app.pipeline.models import CleanEmail
from app.schemas import SkippedEmail

ACTION_WORDS = re.compile(
    r"\b(please|kindly|can you|could you|would you|need you to|you need to|action required"
    r"|due|deadline|submit|review|approve|sign|pay|payment|invoice|rsvp|confirm|reply|respond"
    r"|interview|meeting|schedule|by (?:mon|tue|wed|thu|fri|sat|sun|tomorrow|today|eod|the \d))",
    re.I,
)
_AUTOMATED_SENDER = re.compile(
    r"^(?:no-?reply|do-?not-?reply|donotreply|notifications?|alerts?|mailer-daemon|postmaster)"
    r"(?:[+.-][^@]*)?@|@(?:no-?reply|notifications?)\.",
    re.I,
)
_ONE_TIME_CODE = re.compile(
    r"\b(otp|one[- ]time (?:password|code)|verification code|security code|login code)\b", re.I
)


def _reason(e: CleanEmail) -> str | None:
    labels = {label.upper() for label in e.labels}
    if "CATEGORY_PROMOTIONS" in labels:
        return "promotion"
    if "CATEGORY_SOCIAL" in labels:
        return "social"
    if not e.text.strip() and not e.subject.strip():
        return "empty"
    content = f"{e.subject}\n{e.text}"
    if _ONE_TIME_CODE.search(content):
        return "automated"
    has_action = bool(ACTION_WORDS.search(content))
    if _AUTOMATED_SENDER.search(e.from_email) and not has_action:
        return "automated"
    if e.list_unsubscribe and not has_action:
        return "newsletter"
    return None


def triage(emails: list[CleanEmail]) -> tuple[list[CleanEmail], list[SkippedEmail]]:
    kept: list[CleanEmail] = []
    skipped: list[SkippedEmail] = []
    seen: set[str] = set()
    for e in emails:
        if e.id in seen:
            skipped.append(SkippedEmail(email_id=e.id, reason="duplicate"))
            continue
        seen.add(e.id)
        reason = _reason(e)
        if reason is None:
            kept.append(e)
        else:
            skipped.append(SkippedEmail(email_id=e.id, reason=reason))
    return kept, skipped
