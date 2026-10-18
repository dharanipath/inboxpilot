# Architecture

## Services and stores

| Component | Tech | Owns | Talks to |
|---|---|---|---|
| **web** | React 18 + Vite, served by nginx | UI only | `/api/*` on the same origin (nginx proxies it to the gateway) |
| **api** (gateway) | Node 22, Fastify 5, Prisma, BullMQ | users, sessions, Google OAuth + Gmail, sync jobs, SSE, tasks, briefing, ask, retention | Postgres, Redis, agent, Google |
| **agent** | Python 3.12, FastAPI | the 7-step pipeline, the LLM router, ask, briefing | LLM providers, Redis (LLM cache + circuit state) |
| **Postgres 16** | | users, emails (metadata only), tasks, sync_runs (JSONB trace), audit_log | |
| **Redis 7** | | job queue, sessions, OAuth state, Gmail access tokens, email bodies (≤ 1 h), SSE log + pub/sub, LLM cache, circuit breakers, rate limits | |

The agent has **no published port** and holds no user credentials. The gateway reaches it on the private Docker network with `X-Internal-Key`, and validates every response against [`packages/contracts/extract.schema.json`](../packages/contracts/extract.schema.json).

## Sync flow

```mermaid
sequenceDiagram
  participant U as Browser
  participant G as Gateway
  participant Q as BullMQ worker
  participant M as Gmail
  participant A as Agent
  participant L as LLM router
  U->>G: POST /api/sync
  G->>G: lock synclock:{user} (one sync per user, 409 otherwise)
  G-->>U: 202 {jobId}
  U->>G: GET /api/sync/{jobId}/events (SSE: replay + live)
  Q->>M: list (newer_than:14d in:inbox -promotions -social) or history since historyId
  Q->>Q: skip already-processed ids; bodies → Redis (1 h)
  loop chunks of 12 emails
    Q->>A: POST /v1/extract (user tz, now, VIPs, provider order)
    A->>A: Preprocess (+PII redaction) → Triage
    A->>L: Extract (5–6 emails per call)
    L-->>A: items (or failover: 429 → next provider … → rules)
    A->>A: Ground → Dates → Priority → Dedupe/Plan
    A-->>Q: tasks, skipped, trace, provider usage
    Q->>G: upsert tasks (never touching status or a user-edited due date)
    Q-->>U: SSE extracting / provider_switch
  end
  Q->>A: POST /v1/briefing (all open tasks)
  Q->>G: save run (merged trace + usage), advance historyId, audit
  Q-->>U: SSE done
```

## Agent pipeline

| # | Agent | LLM? | Key rules |
|---|---|---|---|
| 1 | Preprocess | no | HTML → text; strip quoted replies, signatures and disclaimers; cap at 4,000 chars; **redact PII before any prompt** |
| 2 | Triage | no | skip promotions, social, unsubscribable newsletters without action words, automated mail and OTPs, and duplicates |
| 3 | Extract | **yes** | batched; JSON-schema output; email text wrapped in `<email>` tags and declared untrusted; 3 few-shot examples |
| 4 | Ground | no | drop items whose evidence is not verbatim in the email; drop invented due phrases (with a confidence penalty) |
| 5 | Dates | no | a rules resolver relative to the **email's sent time** in the **user's timezone**; falls back to the LLM's ISO guess only when no rule matches |
| 6 | Priority | no | urgency + type + VIP + urgent words, scaled by confidence → P0–P3, with a reason for every point |
| 7 | Dedupe + Plan | briefing only | merge repeats within a thread, and undated duplicates of a dated task in the same email; buckets; briefing (LLM with a template fallback) |

## Data lifecycle

| Data | Where | Kept |
|---|---|---|
| Email bodies | Redis `body:*` | ≤ 1 h, deleted when the run ends |
| Email metadata | Postgres `emails` | 30 days once none of its tasks remain |
| Done or dismissed tasks | Postgres `tasks` | 30 days after closing |
| Sync runs and traces | Postgres `sync_runs` | 30 days |
| Audit log | Postgres `audit_log` | 90 days |

The nightly retention job (`services/api/src/jobs/retention.ts`, BullMQ scheduler, 03:00) enforces this policy. "Delete my data" removes everything immediately and revokes Google access.

## Contracts and versioning

- `/v1` is the agent API. A breaking change means `/v2` plus an ADR.
- The Python Pydantic models, the TypeScript types and the gateway's Ajv validator are all tested against the same schema and fixtures (`contract` CI job).
