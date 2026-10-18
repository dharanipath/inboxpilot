"""Temporal resolver: dates are relative to the email's SENT time in the USER's timezone.

Reference week (Oct 2026): Mon 12, Tue 13, Wed 14, Thu 15, Fri 16, Sat 17, Sun 18, Mon 19, Tue 20.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from app.pipeline.temporal import find_due_phrase, resolve_due

IST = "Asia/Kolkata"
WED_10AM_IST = datetime(2026, 10, 14, 4, 30, tzinfo=timezone.utc)  # Wed 14 Oct, 10:00 IST


def d(s: str) -> date:
    return date.fromisoformat(s)


@pytest.mark.parametrize(
    ("phrase", "expected"),
    [
        # weekdays: next occurrence on or after the sent date
        ("by Friday", "2026-10-16"),
        ("Fri", "2026-10-16"),
        ("this Friday", "2026-10-16"),
        ("on Wednesday", "2026-10-14"),
        ("Monday", "2026-10-19"),
        ("before the call on Tuesday", "2026-10-20"),
        # "next <weekday>" = that weekday in the following (Mon-start) week
        ("next Tue", "2026-10-20"),
        ("next Friday", "2026-10-23"),
        ("next Wednesday", "2026-10-21"),
        # relative words
        ("today", "2026-10-14"),
        ("tonight", "2026-10-14"),
        ("tomorrow", "2026-10-15"),
        ("day after tomorrow", "2026-10-16"),
        ("in 2 days", "2026-10-16"),
        ("within three days", "2026-10-17"),
        ("in a week", "2026-10-21"),
        ("in 2 weeks", "2026-10-28"),
        ("next week", "2026-10-19"),
        ("end of the week", "2026-10-16"),
        ("EOW", "2026-10-16"),
        ("end of month", "2026-10-31"),
        # ordinals roll to next month when already past
        ("the 20th", "2026-10-20"),
        ("by the 14th", "2026-10-14"),
        ("the 2nd", "2026-11-02"),
        # explicit dates
        ("Oct 23", "2026-10-23"),
        ("23rd October", "2026-10-23"),
        ("October 20, 2026", "2026-10-20"),
        ("2026-11-02", "2026-11-02"),
        ("20/10", "2026-10-20"),  # D/M (non-US tz)
        ("10/20", "2026-10-20"),  # second part > 12 so it must be M/D
        ("20/10/26", "2026-10-20"),
        ("11/03", "2027-03-11"),  # 11 March, already past -> next year
        ("Oct 10", "2026-10-10"),  # slightly in the past: keep (shows as overdue)
    ],
)
def test_date_only_phrases(phrase: str, expected: str) -> None:
    r = resolve_due(phrase, WED_10AM_IST, IST)
    assert r.source == "resolver", phrase
    assert r.due_date == d(expected), phrase


def test_month_day_rolls_over_year() -> None:
    sent = datetime(2026, 12, 28, 6, 0, tzinfo=timezone.utc)
    assert resolve_due("Jan 3", sent, IST).due_date == d("2027-01-03")
    assert resolve_due("3rd January", sent, IST).due_date == d("2027-01-03")


def test_ordinal_rolls_to_next_month_after_the_day() -> None:
    sent = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)
    assert resolve_due("the 20th", sent, IST).due_date == d("2026-11-20")


def test_ordinal_clamps_to_month_end() -> None:
    sent = datetime(2026, 11, 5, 6, 0, tzinfo=timezone.utc)
    assert resolve_due("the 31st", sent, IST).due_date == d("2026-11-30")


def test_ordinal_rolls_over_year() -> None:
    sent = datetime(2026, 12, 28, 6, 0, tzinfo=timezone.utc)
    assert resolve_due("by the 5th", sent, IST).due_date == d("2027-01-05")


def test_us_timezone_reads_month_first() -> None:
    sent = datetime(2026, 10, 14, 14, 0, tzinfo=timezone.utc)
    assert resolve_due("11/03", sent, "America/New_York").due_date == d("2026-11-03")


@pytest.mark.parametrize(
    ("phrase", "expected_local"),
    [
        ("3 PM", "2026-10-14T15:00"),
        ("at 3:30pm", "2026-10-14T15:30"),
        ("15:30", "2026-10-14T15:30"),
        ("noon tomorrow", "2026-10-15T12:00"),
        ("next Tue 3 PM", "2026-10-20T15:00"),
        ("Friday at 9:30am", "2026-10-16T09:30"),
        ("Tuesday 11 a.m.", "2026-10-20T11:00"),
        ("EOD", "2026-10-14T17:00"),
        ("by end of day Friday", "2026-10-16T17:00"),
        ("12 am tomorrow", "2026-10-15T00:00"),
        ("9 AM", "2026-10-15T09:00"),  # 9 AM already passed at 10:00 -> next day
    ],
)
def test_times(phrase: str, expected_local: str) -> None:
    r = resolve_due(phrase, WED_10AM_IST, IST)
    assert r.has_time, phrase
    assert r.due_at is not None
    assert r.due_at.strftime("%Y-%m-%dT%H:%M") == expected_local, phrase
    assert r.due_at.utcoffset() == timedelta(hours=5, minutes=30)
    assert r.due_date == r.due_at.date()


def test_timezone_boundary_uses_user_local_date() -> None:
    # 20:00Z Wed = 01:30 IST Thursday: "tomorrow" means Friday in IST but Thursday in UTC.
    sent = datetime(2026, 10, 14, 20, 0, tzinfo=timezone.utc)
    assert resolve_due("tomorrow", sent, IST).due_date == d("2026-10-16")
    assert resolve_due("tomorrow", sent, "UTC").due_date == d("2026-10-15")
    # "Thursday" is today in IST, but tomorrow in UTC
    assert resolve_due("Thursday", sent, IST).due_date == d("2026-10-15")
    assert resolve_due("Thursday", sent, "UTC").due_date == d("2026-10-15")
    assert resolve_due("Wednesday", sent, "UTC").due_date == d("2026-10-14")
    assert resolve_due("Wednesday", sent, IST).due_date == d("2026-10-21")


def test_due_at_converts_to_utc_correctly() -> None:
    r = resolve_due("3 PM", WED_10AM_IST, IST)
    assert r.due_at is not None
    assert r.due_at.astimezone(timezone.utc) == datetime(2026, 10, 14, 9, 30, tzinfo=timezone.utc)


def test_dst_transition_new_york() -> None:
    # DST ends Sun 1 Nov 2026; Monday 9 AM is EST (-05:00)
    sent = datetime(2026, 11, 1, 3, 0, tzinfo=timezone.utc)  # Sat 31 Oct 23:00 EDT
    r = resolve_due("Monday 9 AM", sent, "America/New_York")
    assert r.due_at is not None
    assert r.due_at.strftime("%Y-%m-%dT%H:%M") == "2026-11-02T09:00"
    assert r.due_at.utcoffset() == timedelta(hours=-5)


def test_falls_back_to_llm_guess_only_when_resolver_fails() -> None:
    r = resolve_due("after the board meeting", WED_10AM_IST, IST, llm_guess="2026-10-22")
    assert (r.due_date, r.source, r.has_time) == (d("2026-10-22"), "llm", False)

    r = resolve_due(None, WED_10AM_IST, IST, llm_guess="2026-10-22T14:00")
    assert r.source == "llm" and r.has_time
    assert r.due_at is not None and r.due_at.strftime("%H:%M") == "14:00"

    # resolver wins over a (wrong) LLM guess
    r = resolve_due("by Friday", WED_10AM_IST, IST, llm_guess="2026-10-23")
    assert (r.due_date, r.source) == (d("2026-10-16"), "resolver")


@pytest.mark.parametrize(
    ("phrase", "guess"),
    [(None, None), ("soon", None), ("whenever", "not-a-date"), ("asap", "2026-13-45")],
)
def test_no_date(phrase: str | None, guess: str | None) -> None:
    r = resolve_due(phrase, WED_10AM_IST, IST, llm_guess=guess)
    assert (r.due_date, r.due_at, r.has_time, r.source) == (None, None, False, "none")


def test_unknown_timezone_falls_back_to_utc() -> None:
    r = resolve_due("tomorrow", WED_10AM_IST, "Mars/Olympus_Mons")
    assert r.due_date == d("2026-10-15")


@pytest.mark.parametrize(
    ("sentence", "phrase"),
    [
        ("Can you send the deck before the call on Tuesday?", "Tuesday"),
        ("Please pay invoice #2043 of Rs 5,000 by the 20th.", "the 20th"),
        ("Interview is scheduled for next Tue 3 PM.", "next Tue 3 PM"),
        ("Submit the form by EOD tomorrow please", "EOD tomorrow"),
        ("Thanks for the update, looks good.", None),
        ("Your order #402-1234567 has shipped.", None),
    ],
)
def test_find_due_phrase(sentence: str, phrase: str | None) -> None:
    assert find_due_phrase(sentence) == phrase
