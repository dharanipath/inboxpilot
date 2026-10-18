# ADR 0002 — Dates, priority, buckets and dedupe are deterministic code

- Status: Proposed
- Date: 2026-10-17

## Context

LLMs read language well, and the task depends on reading phrases such as "can you send the deck before the call?". LLMs are unreliable at calendar arithmetic: which date "Friday" means for an email sent last Wednesday in IST, whether "the 20th" has already passed, or a year rollover. They are also non-deterministic, so the same email can get different priorities on different runs, which is untestable. A due-date accuracy target of ≥ 90% needs exact, repeatable behaviour.

## Decision

The LLM returns **only** language-level fields: `title`, `type`, `due_phrase` (verbatim), an optional `due_iso_guess`, `confidence` and `evidence`. Everything else is pure, unit-tested Python:

- **Temporal resolver** (`pipeline/temporal.py`). Inputs are `due_phrase`, the email's `sent_at` (not "now") and the user's IANA timezone. Outputs are `due_date`, `due_at` and `has_time`. It is regex and rule based, so it is easy to read and easy to test. It falls back to `due_iso_guess` only when no rule matches. `date_source` records `resolver | llm | none`.
- **Priority scorer** (`pipeline/prioritize.py`). This is an additive, explainable score that emits a reason for every component. The weights and thresholds are in SPEC §4.
- **Buckets.** These are computed at read time by the gateway from `due_date` and the user's current local date. The agent's `bucket` field is advisory only.
- **Dedupe.** Items in the same thread with title similarity ≥ 0.6 and the same due date are merged, keeping the higher confidence and the earlier evidence.

## Update: priorities are re-scored at read time (SPEC Q11)

Buckets were always computed at read time, but the score was frozen at sync time. The agent now returns the date-independent `priority_base`, and the gateway re-applies the urgency points for today. One shared fixture table tests the Python and TypeScript copies of the formula.

## Consequences

- Behaviour is reproducible and covered by table-driven tests (weekday rules, "next Tue", ordinal rollover, year rollover, 3 PM / 15:30 / noon / EOD, and IST vs UTC day boundaries).
- Unusual phrasings ("after Diwali", "when the quarter closes") will not resolve. They fall back to the LLM guess or no date, which is visible to the user through `date_source`.
- The `Today` list stays correct as days pass without re-running the agent.
