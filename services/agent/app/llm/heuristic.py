"""Rule-based extractor: always configured, always last in the router, used by all tests.

It implements the same LLMProvider interface as the real models by reading the <email>
blocks out of the user prompt, so the rest of the pipeline cannot tell the difference.
"""

from __future__ import annotations

import html
import re
from typing import Any

from app.pipeline.temporal import find_due_phrase

_BLOCK = re.compile(
    r'<email id="([^"]*)" sent="[^"]*" from="[^"]*" subject="([^"]*)">(.*?)</email>', re.S
)
_FYI = re.compile(
    r"\b(no action (?:is )?(?:needed|required)|for your information|fyi|just a heads[- ]up)\b", re.I
)
_REQUEST = re.compile(
    r"\b(please|pls|kindly|can you|could you|would you|will you|need you to|you need to"
    r"|you must|make sure|remember to|don'?t forget to|do not forget to|action required"
    r"|let me know|rsvp|requested to)\b",
    re.I,
)
_IMPERATIVE = re.compile(
    r"^(?:(?:hi|hey|hello|dear)\b[^,]{0,30},\s*)?(review|send|submit|pay|sign|approve|confirm"
    r"|reply|respond|join|attend|complete|fill|share|update|call|schedule|book|register|upload"
    r"|prepare|finish|renew)\b",
    re.I,
)
_BOILERPLATE = re.compile(
    r"\b(for (?:any )?(?:queries|questions|help|support|assistance|more info\w*)"
    r"|if you have (?:any )?(?:questions|queries)|feel free to|contact us|reach out to us"
    r"|unsubscribe|view (?:it )?in (?:your )?browser)\b",
    re.I,
)
_OBLIGATION = re.compile(
    r"\b(is due|are due|due (?:on|by|date|today|tomorrow)|deadline|payment due|amount due"
    r"|interview (?:is )?(?:scheduled|on|at)|scheduled (?:for|on|at)|invited to|invitation to"
    r"|meeting (?:is )?(?:on|at|scheduled)|last date)\b",
    re.I,
)
_TYPES: list[tuple[str, re.Pattern[str]]] = [
    ("payment", re.compile(r"\b(pay|payment|invoice|bill|amount due|dues|emi|fee|renew)\b", re.I)),
    (
        "meeting",
        re.compile(r"\b(interview|meeting|join|attend|sync|standup|invite|invited)\b", re.I),
    ),
    ("review", re.compile(r"\b(review|feedback|approve|look over|go through)\b", re.I)),
    ("send", re.compile(r"\b(send|share|forward|upload)\b", re.I)),
    ("reply", re.compile(r"\b(reply|respond|let me know|get back|confirm|rsvp)\b", re.I)),
    ("call", re.compile(r"\b(call me|give \w+ a call|phone)\b", re.I)),
    ("follow_up", re.compile(r"\b(follow[- ]up|remind)\b", re.I)),
    ("deadline", re.compile(r"\b(deadline|due|submit|complete|finish|by)\b", re.I)),
]
_VERBS = {
    "payment": "Pay",
    "meeting": "Attend",
    "review": "Review",
    "send": "Send",
    "reply": "Reply to",
    "call": "Call about",
    "follow_up": "Follow up on",
    "deadline": "Complete",
    "other": "Handle",
}
_ABBREVIATIONS = {
    "rs",
    "mr",
    "mrs",
    "ms",
    "dr",
    "no",
    "e.g",
    "i.e",
    "approx",
    "etc",
    "vs",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
    "inc",
    "ltd",
    "a.m",
    "p.m",
}
MAX_ITEMS_PER_EMAIL = 3


def split_sentences(text: str) -> list[str]:
    """Split on . ! ? and newlines, without breaking after abbreviations like 'Rs.'."""
    sentences: list[str] = []
    start = 0
    for m in re.finditer(r"[.!?]+(?=\s)|\n+", text):
        end = m.end()
        if m.group().startswith("."):
            words = text[start : m.start()].split()
            if words and words[-1].lower().rstrip(".") in _ABBREVIATIONS:
                continue
        piece = text[start:end].strip()
        if piece:
            sentences.append(piece)
        start = end
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


def _classify(sentence: str) -> str:
    for task_type, pattern in _TYPES:
        if pattern.search(sentence):
            return task_type
    return "other"


def _title(task_type: str, subject: str) -> str:
    subject = re.sub(r"^(?:(?:re|fwd?|fw)\s*:\s*)+", "", subject.strip(), flags=re.I)
    return f"{_VERBS[task_type]}: {subject or 'email'}"[:80]


def extract_items(email_id: str, subject: str, body: str) -> list[dict[str, Any]]:
    if _FYI.search(body):
        return []
    items: list[dict[str, Any]] = []
    for sentence in split_sentences(body):
        if _BOILERPLATE.search(sentence):
            continue
        asks = bool(_REQUEST.search(sentence) or _IMPERATIVE.search(sentence))
        owes = bool(_OBLIGATION.search(sentence))
        if not (asks or owes):
            continue
        due_phrase = find_due_phrase(sentence)
        confidence = 0.5 + (0.15 if asks else 0) + (0.1 if owes else 0) + (0.1 if due_phrase else 0)
        task_type = _classify(sentence)
        items.append(
            {
                "email_id": email_id,
                "title": _title(task_type, subject),
                "type": task_type,
                "due_phrase": due_phrase,
                "due_iso_guess": None,
                "confidence": round(min(confidence, 0.85), 2),
                "evidence": sentence,
            }
        )
        if len(items) == MAX_ITEMS_PER_EMAIL:
            break
    return items


class HeuristicProvider:
    name = "heuristic"
    model = "rules-v1"
    always_available = True  # never cached, never circuit-broken

    def is_configured(self) -> bool:
        return True

    async def complete_json(
        self, system: str, user: str, schema: dict[str, Any], timeout_s: float = 25
    ) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        for email_id, subject, body in _BLOCK.findall(user):
            items.extend(extract_items(html.unescape(email_id), html.unescape(subject), body))
        return {"items": items}
