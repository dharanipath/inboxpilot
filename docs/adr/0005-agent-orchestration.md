# ADR 0005 — Hand-written pipeline orchestrator (not LangGraph)

- Status: Proposed
- Date: 2026-10-17

## Context

The agent is a **fixed, linear** pipeline of seven steps: Preprocess → Triage → Extract → Ground → Dates → Priority → Dedupe/Plan. Only Extract (and, optionally, the briefing) calls an LLM. The pipeline has no branching on model output, no tool use, and no loops. Retries and failover live in the LLM router (ADR 0003).

## Decision

Use a small hand-written orchestrator (`pipeline/orchestrator.py`) that does three things:

1. runs each step as a pure function `(state) -> state`
2. records a `TraceStep` for each step: step, agent, status (`ok | degraded | skipped | failed`), duration and detail
3. on a failure in a non-critical step, degrades and continues rather than aborting the whole run (for example, an LLM briefing failure falls back to the template briefing)

## Consequences

- There is no framework dependency, and every step can be tested in isolation.
- The trace shape is defined by our contract, not by a framework.
- If the pipeline later needs branching (for example, an LLM-driven clarification loop), LangGraph can be reconsidered in a new ADR.
