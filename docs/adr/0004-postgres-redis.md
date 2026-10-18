# ADR 0004 — Postgres for durable data, Redis for short-lived data

- Status: Proposed
- Date: 2026-10-17

## Context

There are two classes of data:

- **Durable:** users and encrypted tokens, email metadata (for idempotency), tasks with user status, sync runs with traces, and the audit log.
- **Short-lived with natural expiry:** OAuth state and PKCE verifier, sessions, Gmail access tokens, raw email bodies, the job queue, the LLM cache, circuit-breaker state, and rate-limit counters.

Data minimisation requires that full email bodies are never stored durably.

## Decision

- **PostgreSQL 16** (Docker), accessed through **Prisma** with versioned migrations. The tables are `users`, `emails` (metadata only), `tasks`, `sync_runs` (JSONB trace, usage and briefing) and `audit_log`, as specified in the playbook §6.
  - Idempotency comes from `UNIQUE (user_id, gmail_id)` on emails and a stable task id (SPEC Q1).
  - The task upsert updates only extraction fields and never touches `status`, `snoozed_until` or a user-edited due date.
  - Disconnect deletes the user, which cascades to all of their data.
- **Redis 7** (Docker) holds everything with a TTL:

| Key | TTL |
|---|---|
| `oauth:{state}` | 10 min |
| `session:{jti}` | 7 d |
| `gtoken:{userId}` | ~55 min |
| `body:{msgId}` | 1 h |
| `llm:{sha256}` | 24 h |
| `cb:{provider}` | the cooldown period |
| `rl:{ip}` | 1 min |

  The Redis instance also runs the BullMQ queue and the Pub/Sub channel used for SSE fan-out.
- A **nightly retention job** deletes emails and sync runs older than 30 days, and audit entries older than 90 days.

## Alternatives considered

- **SQLite + in-memory cache as a zero-Docker fallback.** This is deferred (SPEC Q2 and Q3). Prisma cannot target both providers from one schema, the design uses Postgres-only types, and BullMQ needs real Redis. Supporting it would double the persistence code for a marginal benefit.
- **Postgres only, with no Redis** (queue via `SKIP LOCKED`, TTL via cron). This is possible, but we would lose native TTLs, BullMQ retries and back-off, and cheap Pub/Sub. Rejected.

## Consequences

- Docker is a hard prerequisite for `make dev`. The README states this up front.
- Unit tests use a fake Redis. API tests use Postgres and Redis service containers in CI.

## Implementation notes (Phase 3)

- **Task key.** `tasks` uses a composite primary key `(user_id, id)`. The agent's task id is `sha1(gmail_id + evidence)`, which is unique per mailbox but not across users (two users can receive the same message).
- **Upsert.** One raw SQL `INSERT … ON CONFLICT DO UPDATE` refreshes the extraction fields. It never sets `status` or `snoozed_until`, and it keeps the due date when `due_overridden` is set.
- **Redis keys** in use:

| Key | Purpose | TTL |
|---|---|---|
| `session:{jti}` | session allow-list | 7 d |
| `synclock:{user}` | one sync at a time per user | 15 min, released by its owner only |
| `body:{user}:{msg}` | email body during processing | 1 h, deleted at the end of the run |
| `syncev:{run}` | SSE replay log | 1 h |
| `sync:{run}` | pub/sub channel | — |
| `briefing:{user}:{date}` | briefing text | 6 h |
| `rl:*` | rate limiting | per window |
| `bull:*` | the job queue | — |

- **SSE fan-out.** One `PSUBSCRIBE sync:*` connection per process feeds an in-process emitter, so open streams don't each cost a Redis connection.
