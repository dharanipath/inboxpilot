"""Agent 1 — Preprocess: HTML → text, strip quotes/signatures/disclaimers, truncate, redact PII.

Everything downstream (LLM prompt, grounding, stored evidence) sees only the redacted text.
"""

from __future__ import annotations

import html
import re

_BLOCK_TAGS = re.compile(r"</?(?:p|div|br|li|tr|h[1-6]|table|ul|ol|blockquote)\b[^>]*>", re.I)
_DROP_BLOCKS = re.compile(r"<(script|style|head)\b.*?</\1\s*>", re.I | re.S)
_TAG = re.compile(r"<[^>]+>")
_LOOKS_HTML = re.compile(r"<(?:html|body|div|p|br|table|span)\b", re.I)

# A line that starts quoted history, a signature or a disclaimer: everything from it on is cut.
_CUT_MARKERS = [
    re.compile(r"^On .{0,200}wrote:\s*$", re.M | re.S),
    re.compile(r"^-{2,}\s*Original Message\s*-{2,}", re.M | re.I),
    re.compile(r"^-{2,}\s*Forwarded message\s*-{2,}", re.M | re.I),
    re.compile(r"^-- ?$", re.M),
    re.compile(r"^Sent from my \w+", re.M | re.I),
    re.compile(r"^(?:CONFIDENTIALITY NOTICE|DISCLAIMER)\b", re.M | re.I),
    re.compile(r"^This (?:e-?mail|message) and any attachments", re.M | re.I),
]
_QUOTE_LINE = re.compile(r"^\s*>.*$", re.M)

# ---------------------------------------------------------------- PII

_PAN = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")
# Digit runs with common separators; classified by digit count below.
_NUMBER_RUN = re.compile(r"(?<![\w/#.,₹$€£-])(\+?\(?\d[\d\s().-]{6,24}\d)(?![\w/,])")
_DATE_LIKE = re.compile(r"^\d{4}-\d{2}-\d{2}$|^\d{1,2}[-.]\d{1,2}[-.]\d{2,4}$")


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _classify(run: str) -> str | None:
    if _DATE_LIKE.match(run.strip()):
        return None
    digits = re.sub(r"\D", "", run)
    n = len(digits)
    if run.lstrip("(").startswith("+"):
        return "[PHONE]" if 8 <= n <= 15 else None
    if 13 <= n <= 19 and _luhn_ok(digits):
        return "[CARD]"
    if n == 12:
        return "[AADHAAR]"
    if 10 <= n <= 11:
        return "[PHONE]"
    if 9 <= n <= 19:
        return "[ACCOUNT]"
    return None


def redact_pii(text: str) -> tuple[str, int]:
    """Replace phone, card, Aadhaar, PAN and account numbers with placeholder tokens."""
    count = 0

    def sub_number(m: re.Match[str]) -> str:
        nonlocal count
        token = _classify(m.group(1))
        if token is None:
            return m.group(0)
        count += 1
        return token

    text, pan_count = _PAN.subn("[PAN]", text)
    count += pan_count
    text = _NUMBER_RUN.sub(sub_number, text)
    return text, count


# ---------------------------------------------------------------- cleaning


def html_to_text(raw: str) -> str:
    text = _DROP_BLOCKS.sub(" ", raw)
    text = _BLOCK_TAGS.sub("\n", text)
    text = _TAG.sub("", text)
    text = html.unescape(text).replace("\xa0", " ")
    return text


def _cut_at_markers(text: str) -> str:
    cut = len(text)
    for marker in _CUT_MARKERS:
        m = marker.search(text)
        if m:
            cut = min(cut, m.start())
    return text[:cut]


def _normalise_whitespace(text: str) -> str:
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    text = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = text.rfind(" ", 0, max_chars)
    return text[: cut if cut > 0 else max_chars].rstrip()


def clean_body(body: str, max_chars: int = 4000) -> tuple[str, int]:
    """Return (clean, redacted text, number of PII redactions)."""
    text = html_to_text(body) if _LOOKS_HTML.search(body) else body
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _cut_at_markers(text)
    text = _QUOTE_LINE.sub("", text)
    text = _normalise_whitespace(text)
    text, redactions = redact_pii(text)
    return _truncate(text, max_chars), redactions
