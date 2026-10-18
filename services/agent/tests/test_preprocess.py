from __future__ import annotations

import pytest

from app.pipeline.preprocess import clean_body, html_to_text, redact_pii


def test_html_to_text_drops_tags_scripts_and_entities() -> None:
    html = (
        "<html><head><style>p{color:red}</style><script>alert(1)</script></head>"
        "<body><p>Hi&nbsp;Sam,</p><p>Please review <b>the doc</b> &amp; reply.</p>"
        "<br>Thanks</body></html>"
    )
    text = html_to_text(html)
    assert "alert" not in text and "color" not in text and "<" not in text
    assert "Hi Sam," in text
    assert "Please review the doc & reply." in text


def test_strips_quoted_reply_gmail_style() -> None:
    body = (
        "Sounds good, please send it by Friday.\n\n"
        "On Tue, Oct 13, 2026 at 9:00 AM Priya <priya@example.com> wrote:\n"
        "> Can you also pay the invoice?\n> Thanks"
    )
    text, _ = clean_body(body)
    assert text == "Sounds good, please send it by Friday."


def test_strips_outlook_original_message_and_quote_lines() -> None:
    body = "Approved.\n> old quoted line\n-----Original Message-----\nFrom: x\nPlease pay"
    text, _ = clean_body(body)
    assert text == "Approved."


def test_strips_signature_and_disclaimer() -> None:
    body = "Please sign the NDA today.\n\n-- \nJohn Doe\nCTO, Acme\n"
    assert clean_body(body)[0] == "Please sign the NDA today."
    body2 = (
        "Review the deck.\n\nCONFIDENTIALITY NOTICE: This email and any attachments are "
        "confidential. Please delete if received in error."
    )
    assert clean_body(body2)[0] == "Review the deck."
    assert clean_body("Call me.\n\nSent from my iPhone")[0] == "Call me."


def test_truncates_long_bodies() -> None:
    text, _ = clean_body("word " * 2000, max_chars=4000)
    assert len(text) <= 4000


def test_collapses_whitespace_but_keeps_paragraphs() -> None:
    text, _ = clean_body("Line one.   \n\n\n\nLine   two.")
    assert text == "Line one.\n\nLine two."


@pytest.mark.parametrize(
    ("raw", "token"),
    [
        ("Call me on +91 98765 43210 today", "[PHONE]"),
        ("Call me on 98765 43210 today", "[PHONE]"),
        ("Phone: (080) 2345-6789", "[PHONE]"),
        ("Card 4111 1111 1111 1111 was charged", "[CARD]"),
        ("Card 4111-1111-1111-1111 was charged", "[CARD]"),
        ("Aadhaar 2345 6789 0123 linked", "[AADHAAR]"),
        ("PAN ABCDE1234F on file", "[PAN]"),
        ("Account no 123456789 credited", "[ACCOUNT]"),
    ],
)
def test_redacts_pii(raw: str, token: str) -> None:
    redacted, count = redact_pii(raw)
    assert token in redacted
    assert count >= 1
    assert not any(ch.isdigit() for ch in redacted.split(token)[0][-3:])


@pytest.mark.parametrize(
    "safe",
    [
        "Due 2026-10-20 at 15:30",
        "Invoice #2043 for Rs 5,000",
        "Meeting on 20/10/2026",
        "Order 4021",
        "Pay ₹12,500 by the 20th",
    ],
)
def test_does_not_redact_dates_amounts_or_short_ids(safe: str) -> None:
    redacted, count = redact_pii(safe)
    assert redacted == safe and count == 0


def test_clean_body_reports_redactions() -> None:
    text, redactions = clean_body("<p>Call 98765 43210</p>")
    assert text == "Call [PHONE]"
    assert redactions == 1
