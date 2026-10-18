"""Deterministic due-date resolver (ADR 0002).

All dates are resolved relative to the email's *sent* time, converted into the *user's* timezone.
The LLM's ISO guess is used only when no rule here matches.
"""

from __future__ import annotations

import calendar
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.schemas import DateSource

EOD = time(17, 0)
PAST_TOLERANCE_DAYS = 7  # an explicit date up to a week in the past stays put (shows as overdue)

_MONTHS = (
    r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?"
    r"|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
)
_WEEKDAYS = (
    r"monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu"
    r"|friday|fri|saturday|sat|sunday|sun"
)
_NUM_WORDS = {
    "a": 1,
    "an": 1,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "a couple of": 2,
    "a few": 3,
}
_MONTH_FIRST_ZONES = {
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Phoenix",
    "America/Anchorage",
    "America/Detroit",
    "Pacific/Honolulu",
}

_F = re.IGNORECASE


@dataclass(frozen=True)
class Resolution:
    due_date: date | None
    due_at: datetime | None
    has_time: bool
    source: DateSource


NO_DATE = Resolution(None, None, False, "none")


@dataclass(frozen=True)
class _Ctx:
    anchor: date
    month_first: bool


# ---------------------------------------------------------------- helpers


def zone_for(tz_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _month_num(token: str) -> int:
    return [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
    ].index(token[:3].lower()) + 1


def _weekday_num(token: str) -> int:
    return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].index(token[:3].lower())


def _safe_date(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _roll_year(y: int | None, m: int, d: int, anchor: date) -> date | None:
    """Explicit year wins; otherwise roll to next year if the date is well in the past."""
    if y is not None:
        return _safe_date(y, m, d)
    candidate = _safe_date(anchor.year, m, d)
    if candidate is None:
        return None
    if candidate < anchor - timedelta(days=PAST_TOLERANCE_DAYS):
        return _safe_date(anchor.year + 1, m, d)
    return candidate


def _next_weekday(anchor: date, weekday: int) -> date:
    return anchor + timedelta(days=(weekday - anchor.weekday()) % 7)


def _parse_count(token: str) -> int:
    t = token.lower()
    return int(t) if t.isdigit() else _NUM_WORDS[t]


# ---------------------------------------------------------------- date rules
# Each rule: (pattern, handler(match, ctx) -> date | None). First rule that yields a date wins.


def _iso(m: re.Match[str], c: _Ctx) -> date | None:
    return _safe_date(int(m[1]), int(m[2]), int(m[3]))


def _numeric(m: re.Match[str], c: _Ctx) -> date | None:
    a, b = int(m[1]), int(m[2])
    if a > 12:
        day, month = a, b
    elif b > 12 or c.month_first:
        month, day = a, b
    else:
        day, month = a, b
    year = None
    if m[3]:
        year = int(m[3]) + (2000 if len(m[3]) == 2 else 0)
    return _roll_year(year, month, day, c.anchor)


def _month_day(m: re.Match[str], c: _Ctx) -> date | None:
    return _roll_year(int(m[3]) if m[3] else None, _month_num(m[1]), int(m[2]), c.anchor)


def _day_month(m: re.Match[str], c: _Ctx) -> date | None:
    return _roll_year(int(m[3]) if m[3] else None, _month_num(m[2]), int(m[1]), c.anchor)


def _offset(days: int) -> Callable[[re.Match[str], _Ctx], date | None]:
    return lambda m, c: c.anchor + timedelta(days=days)


def _in_n(m: re.Match[str], c: _Ctx) -> date | None:
    n = _parse_count(m[1])
    return c.anchor + timedelta(days=n * (7 if m[2].lower().startswith("week") else 1))


def _next_week(m: re.Match[str], c: _Ctx) -> date | None:
    return c.anchor - timedelta(days=c.anchor.weekday()) + timedelta(days=7)


def _end_of_week(m: re.Match[str], c: _Ctx) -> date | None:
    return _next_weekday(c.anchor, 4)


def _end_of_month(m: re.Match[str], c: _Ctx) -> date | None:
    last = calendar.monthrange(c.anchor.year, c.anchor.month)[1]
    return c.anchor.replace(day=last)


def _weekday(m: re.Match[str], c: _Ctx) -> date | None:
    wd = _weekday_num(m[2])
    if (m[1] or "").lower() == "next":
        monday_next = c.anchor - timedelta(days=c.anchor.weekday()) + timedelta(days=7)
        return monday_next + timedelta(days=wd)
    return _next_weekday(c.anchor, wd)


def _ordinal(m: re.Match[str], c: _Ctx) -> date | None:
    day = int(m[1])
    if not 1 <= day <= 31:
        return None
    y, mo = c.anchor.year, c.anchor.month
    if day < c.anchor.day:
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    return date(y, mo, min(day, calendar.monthrange(y, mo)[1]))


_DATE_RULES: list[tuple[re.Pattern[str], Callable[[re.Match[str], _Ctx], date | None]]] = [
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), _iso),
    (re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?\b"), _numeric),
    (
        re.compile(rf"\b({_MONTHS})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s+(\d{{4}})\b)?", _F),
        _month_day,
    ),
    (
        re.compile(
            rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({_MONTHS})\b\.?(?:,?\s+(\d{{4}})\b)?", _F
        ),
        _day_month,
    ),
    (re.compile(r"\bday after tomorrow\b", _F), _offset(2)),
    (re.compile(r"\b(?:tomorrow|tmrw|tmr)\b", _F), _offset(1)),
    (re.compile(r"\b(?:today|tonight|this evening|this afternoon)\b", _F), _offset(0)),
    (
        re.compile(
            r"\b(?:in|within)\s+(a couple of|a few|\d{1,3}|an?|one|two|three|four|five|six"
            r"|seven|eight|nine|ten)\s+(days?|weeks?)\b",
            _F,
        ),
        _in_n,
    ),
    (re.compile(r"\bnext week\b", _F), _next_week),
    (re.compile(r"\b(?:end of (?:the |this )?week|eow|this week)\b", _F), _end_of_week),
    (re.compile(r"\b(?:end of (?:the |this )?month|eom)\b", _F), _end_of_month),
    (re.compile(rf"\b(?:(next|this|coming)\s+)?({_WEEKDAYS})\b", _F), _weekday),
    (re.compile(r"\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b", _F), _ordinal),
]

# ---------------------------------------------------------------- time rules

_TIME_RULES: list[tuple[re.Pattern[str], Callable[[re.Match[str]], time | None]]] = [
    (
        re.compile(r"\b(?:eod|cob|end of (?:the )?(?:business )?day|close of business)\b", _F),
        lambda m: EOD,
    ),
    (re.compile(r"\b(?:noon|midday)\b", _F), lambda m: time(12, 0)),
    (re.compile(r"\bmidnight\b", _F), lambda m: time(23, 59)),
    (
        re.compile(r"\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?!\w)", _F),
        lambda m: _twelve_hour(int(m[1]), int(m[2] or 0), m[3]),
    ),
    (
        re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b"),
        lambda m: time(int(m[1]), int(m[2])),
    ),
]


def _twelve_hour(h: int, minute: int, meridiem: str) -> time | None:
    if not 1 <= h <= 12 or minute > 59:
        return None
    pm = meridiem.lower().startswith("p")
    return time((h % 12) + (12 if pm else 0), minute)


def _match_time(text: str) -> tuple[time, tuple[int, int]] | None:
    for pattern, handler in _TIME_RULES:
        for m in pattern.finditer(text):
            t = handler(m)
            if t is not None:
                return t, m.span()
    return None


def _match_date(text: str, ctx: _Ctx) -> date | None:
    for pattern, handler in _DATE_RULES:
        for m in pattern.finditer(text):
            d = handler(m, ctx)
            if d is not None:
                return d
    return None


def _parse_llm_guess(guess: str | None, zone: ZoneInfo) -> Resolution:
    if not guess:
        return NO_DATE
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?", guess.strip())
    if not m:
        return NO_DATE
    d = _safe_date(int(m[1]), int(m[2]), int(m[3]))
    if d is None:
        return NO_DATE
    if m[4] is None:
        return Resolution(d, None, False, "llm")
    h, mi = int(m[4]), int(m[5])
    if h > 23 or mi > 59:
        return Resolution(d, None, False, "llm")
    return Resolution(d, datetime.combine(d, time(h, mi), tzinfo=zone), True, "llm")


# ---------------------------------------------------------------- public API


def resolve_due(
    phrase: str | None,
    sent_at: datetime,
    tz_name: str,
    llm_guess: str | None = None,
) -> Resolution:
    """Turn a due phrase into a concrete date (and time) in the user's timezone."""
    zone = zone_for(tz_name)
    sent_local = sent_at.astimezone(zone)
    ctx = _Ctx(
        anchor=sent_local.date(),
        month_first=tz_name in _MONTH_FIRST_ZONES or tz_name.startswith("US/"),
    )

    if phrase and phrase.strip():
        text = phrase
        matched_time = _match_time(text)
        if matched_time:
            start, end = matched_time[1]
            text = text[:start] + " " * (end - start) + text[end:]
        due_date = _match_date(text, ctx)

        if due_date is not None or matched_time is not None:
            if matched_time is None:
                return Resolution(due_date, None, False, "resolver")
            t = matched_time[0]
            if due_date is None:
                # time only: today, or tomorrow if that time had already passed when sent
                due_date = ctx.anchor
                if datetime.combine(due_date, t, tzinfo=zone) < sent_local:
                    due_date += timedelta(days=1)
            return Resolution(
                due_date, datetime.combine(due_date, t, tzinfo=zone), True, "resolver"
            )

    return _parse_llm_guess(llm_guess, zone)


_PHRASE_GAP = 12  # chars allowed between matched fragments that form one phrase


def find_due_phrase(text: str) -> str | None:
    """Return the first date/time expression in free text (used by the heuristic extractor)."""
    spans: list[tuple[int, int]] = []
    for pattern, _ in [*_DATE_RULES, *_TIME_RULES]:
        spans.extend(m.span() for m in pattern.finditer(text))
    if not spans:
        return None
    spans.sort()
    start, end = spans[0]
    for s, e in spans[1:]:
        if s > end + _PHRASE_GAP:
            break
        end = max(end, e)
    return text[start:end].strip() or None


__all__ = ["NO_DATE", "Resolution", "find_due_phrase", "resolve_due", "zone_for"]
