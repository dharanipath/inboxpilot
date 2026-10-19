"""Deterministic, explainable priority score (SPEC §4, ADR 0002)."""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from app.schemas import Priority, TaskType

TYPE_WEIGHTS: dict[str, tuple[int, str]] = {
    "interview": (18, "Interview"),
    "payment": (15, "Payment"),
    "deadline": (14, "Deadline"),
    "meeting": (12, "Meeting"),
    "review": (10, "Review request"),
    "reply": (8, "Reply needed"),
    "send": (8, "Send request"),
    "call": (8, "Call"),
    "follow_up": (6, "Follow-up"),
    "other": (4, "Other"),
}
VIP_POINTS = 15
URGENT_POINTS = 12
_URGENT = re.compile(r"\b(urgent|asap|immediately|final notice|overdue|right away)\b", re.I)
_INTERVIEW = re.compile(r"\binterview", re.I)


@dataclass(frozen=True)
class PriorityResult:
    priority: Priority
    score: int
    reasons: list[str]
    base: int  # date-independent points (type + VIP + urgent words): lets readers re-score later


def priority_for_score(score: int) -> Priority:
    if score >= 75:
        return "P0"
    if score >= 45:
        return "P1"
    if score >= 28:
        return "P2"
    return "P3"


def _plural(n: int, unit: str) -> str:
    return f"{n} {unit}{'' if n == 1 else 's'}"


def _urgency(due_date: date | None, today: date) -> tuple[int, str]:
    if due_date is None:
        return 4, "No due date"
    days = (due_date - today).days
    if days < 0:
        return 80, f"Overdue by {_plural(-days, 'day')}"
    if days == 0:
        return 75, "Due today"  # due today (or overdue) is P0: it alone reaches the P0 line
    if days == 1:
        return 42, "Due tomorrow"
    label = f"Due in {days} days"
    if days <= 3:
        return 24, label
    if days <= 7:
        return 14, label
    return 6, label


def combine(base: int, due_date: date | None, confidence: float, today: date) -> tuple[int, str]:
    """Urgency (relative to `today`) + base, scaled by confidence. Mirrored by the gateway's
    read-time re-scoring; packages/contracts/fixtures/priority_cases.json keeps them identical."""
    points, label = _urgency(due_date, today)
    conf = min(max(confidence, 0.0), 1.0)
    return min(100, max(0, math.floor((points + base) * (0.6 + 0.4 * conf) + 0.5))), label


def _is_vip(from_email: str, vip_senders: Iterable[str]) -> bool:
    sender = from_email.strip().lower()
    for vip in vip_senders:
        v = vip.strip().lower()
        if v and (sender == v or (v.startswith("@") and sender.endswith(v))):
            return True
    return False


def score_task(
    *,
    task_type: TaskType,
    title: str,
    evidence: str,
    due_date: date | None,
    confidence: float,
    from_email: str,
    vip_senders: Iterable[str],
    today: date,
    subject: str = "",
) -> PriorityResult:
    reasons: list[str] = []
    base = 0

    weight_key: str = task_type
    if task_type == "meeting" and (_INTERVIEW.search(title) or _INTERVIEW.search(evidence)):
        weight_key = "interview"
    weight, type_label = TYPE_WEIGHTS[weight_key]
    base += weight
    reasons.append(type_label)

    if _is_vip(from_email, vip_senders):
        base += VIP_POINTS
        reasons.append("VIP sender")
    if _URGENT.search(title) or _URGENT.search(evidence) or _URGENT.search(subject):
        base += URGENT_POINTS
        reasons.append("Marked urgent")

    score, urgency_label = combine(base, due_date, confidence, today)
    conf = min(max(confidence, 0.0), 1.0)
    if conf < 0.7:
        reasons.append(f"Lowered for {round(conf * 100)}% confidence")
    # the urgency reason always comes first, so a reader can swap it when it re-scores
    return PriorityResult(priority_for_score(score), score, [urgency_label, *reasons], base)
