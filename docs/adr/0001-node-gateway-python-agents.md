# ADR 0001 — Node.js gateway + Python agent service

- Status: Proposed
- Date: 2026-10-17

## Context

InboxPilot has two kinds of work:

1. **User-facing I/O.** This covers Google OAuth, sessions, Gmail fan-out, a job queue, SSE streaming, and CRUD on tasks.
2. **AI work.** This covers LLM calls across many providers, text cleaning, date parsing, scoring, and offline evals.

The role being interviewed for is full-stack JS plus AI. The reviewer will also look for clear service boundaries.

## Options

| Option | Pros | Cons |
|---|---|---|
| A. Node for everything | One language, one toolchain | Weaker LLM eval and NLP ecosystem; date and NLP libraries are less mature |
| B. Python for everything | One language, strongest AI tooling | Less natural fit for the streaming/OAuth gateway and a JS front end; weaker match to the team's stack |
| **C. Node gateway + Python agent service** | Each side plays to its ecosystem's strength; a clean, testable contract between them | Two runtimes, two CI jobs, and risk of contract drift |

## Decision

**Option C.**

- `services/api` (Node 22, Fastify 5, TS) owns users, OAuth, Gmail, Postgres, Redis, jobs and SSE. It is the **only** service the browser talks to.
- `services/agent` (Python 3.12, FastAPI, Pydantic v2) is a **stateless**, private service. It holds no user credentials, never talks to Gmail, and never writes to Postgres. It receives cleaned email payloads and returns tasks.
- The agent is reachable only on the private Docker network, authenticated with `X-Internal-Key`. `x-request-id` is propagated across the hop.

## Consequences

- Contract drift is the main risk. It is mitigated by one JSON Schema (`packages/contracts/extract.schema.json`), shared fixtures, Ajv validation in Node, `jsonschema` validation in Python, and a CI `contract` job. The contract is versioned (`/v1`); a breaking change means `/v2` plus a new ADR.
- The agent being stateless keeps it trivially scalable and testable. All persistence and idempotency live in the gateway.
- There are two lint, type-check and test toolchains. This is accepted.
