from __future__ import annotations

import pytest

from app.pipeline.triage import triage
from tests.factories import email


@pytest.mark.parametrize(
    ("kw", "reason"),
    [
        ({"labels": ("INBOX", "CATEGORY_PROMOTIONS")}, "promotion"),
        ({"labels": ("CATEGORY_SOCIAL",)}, "social"),
        (
            {
                "list_unsubscribe": True,
                "subject": "This week in tech",
                "text": "Top stories: AI chips, new phones and more.",
            },
            "newsletter",
        ),
        (
            {
                "from_email": "no-reply@github.com",
                "subject": "[repo] CI passed",
                "text": "All checks have passed on main.",
            },
            "automated",
        ),
        (
            {
                "from_email": "alerts@bank.com",
                "subject": "Your OTP",
                "text": "Your OTP is 482913. Please do not share it with anyone.",
            },
            "automated",
        ),
        ({"subject": "", "text": "   "}, "empty"),
    ],
)
def test_skips_noise(kw: dict[str, object], reason: str) -> None:
    kept, skipped = triage([email(**kw)])
    assert kept == []
    assert [(s.email_id, s.reason) for s in skipped] == [("m1", reason)]


def test_keeps_newsletter_that_asks_for_action() -> None:
    e = email(
        list_unsubscribe=True, subject="Alumni meet", text="Please confirm your RSVP by Friday."
    )
    kept, skipped = triage([e])
    assert kept == [e] and skipped == []


def test_keeps_noreply_invoice_with_due_date() -> None:
    e = email(
        from_email="billing@noreply.acme.com",
        subject="Invoice #2043",
        text="Your invoice of Rs 5,000 is due on the 20th.",
    )
    kept, _ = triage([e])
    assert kept == [e]


def test_keeps_normal_mail() -> None:
    kept, skipped = triage([email()])
    assert len(kept) == 1 and skipped == []


def test_duplicate_ids_are_skipped_once() -> None:
    kept, skipped = triage([email(), email()])
    assert len(kept) == 1
    assert [s.reason for s in skipped] == ["duplicate"]
