# InboxPilot API gateway

Node 22+, Fastify 5, TypeScript (strict), Prisma (Postgres), Redis (BullMQ, cache, pub/sub), and jose JWT sessions.

This is the only service the browser talks to. It owns users, sessions, sync jobs, tasks and SSE. It calls the Python agent over a private network using `X-Internal-Key` and validates every agent response against `packages/contracts` at runtime.

## Run locally

```bash
docker compose up -d --wait           # from the repo root: Postgres 16 + Redis 7
cd services/api
npm install
npx prisma migrate deploy             # needs DATABASE_URL (see the repo-root .env.example)
npm run dev                           # http://localhost:4000; reads the repo-root .env
```

The agent must be running for syncs (`services/agent`, port 8000). Without it, `/api/health` reports `degraded` and existing tasks are still served.

## API

All errors are RFC 7807 `application/problem+json` with a `traceId`. `x-request-id` is echoed back and forwarded to the agent.

| Method       | Path                                  | Notes                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET          | `/api/health`                         | DB, Redis and agent checks. Returns `ok`, `degraded` (agent down) or `down` (503).                                                                                                                                                                          |
| POST         | `/api/auth/logout`                    | Revokes the session server-side (Redis allow-list), not just the cookie. `{forget: true}` also forgets this browser.                                                                                                                                        |
| GET          | `/api/auth/remembered`                | The account this browser remembers (`{email, name, gmail_connected}`), or 204. Powers "Continue as …".                                                                                                                                                      |
| POST         | `/api/auth/resume`                    | One-click sign-in on a remembered browser, with no trip to Google. Rotates the device secret and starts a sync. 401 if not remembered, 409 if Google ended Gmail access. Limit 20/min.                                                                      |
| POST         | `/api/auth/forget`                    | Forget this browser ("Not you?").                                                                                                                                                                                                                           |
| GET          | `/api/me`                             | The current user.                                                                                                                                                                                                                                           |
| PATCH        | `/api/me/settings`                    | `{timezone?, vip_senders?, llm_providers?}`, validated (IANA zone, email or `@domain`, known providers).                                                                                                                                                    |
| DELETE       | `/api/me`                             | Deletes the account. All rows cascade; an audit record is kept.                                                                                                                                                                                             |
| POST         | `/api/sync`                           | `{days: 1–30 = 14, reprocess = false}` → `202 {jobId}`. One running sync per user (409 with the live `jobId`). Limit 10/min.                                                                                                                                |
| GET          | `/api/sync/:jobId/events`             | **SSE.** Events: `queued`, `fetching`, `triage`, `extracting`, `provider_switch`, `saving`, then `done` or `error`. Replays history and supports `Last-Event-ID`.                                                                                           |
| GET          | `/api/sync/:jobId` · `/api/sync/runs` | The run with its merged agent trace, provider usage and briefing.                                                                                                                                                                                           |
| GET          | `/api/tasks`                          | `?range=today\|week\|overdue\|later\|undated\|review\|all&status=open\|done\|dismissed\|snoozed\|closed\|all&type=&priority=&limit=&cursor=`. Buckets are computed **at read time** in the user's timezone.                                                 |
| GET / PATCH  | `/api/tasks/:id`                      | `{status}` (open, done, dismissed) or `{snoozed_until}` or `{due_date \| due_at}`. **A re-sync never overwrites any of these.**                                                                                                                             |
| GET          | `/api/emails`                         | `?days=1–30 (7)&limit=`. Mail from the N days **before today** in the user's timezone (today excluded), newest first: sender, subject, local date, status, skip reason, Gmail link and **all** its tasks (any status).                                      |
| GET          | `/api/briefing`                       | Covers all open tasks. Counts are always live; the text is cached per local day, with a template fallback.                                                                                                                                                  |
| POST         | `/api/ask`                            | `{question}`. Answered from the user's own tasks; citations to unknown ids are dropped. Limit 20/min.                                                                                                                                                       |
| GET          | `/api/providers`                      | Every LLM provider as this user sees it: key source (yours / server / none), key hint `••••last4`, available, and why it is paused (`circuit_reason`: free limit, key rejected, errors) with `cooldown_s`. Plus `mode` (`auto`, `heuristic` or a provider). |
| PUT          | `/api/llm/model`                      | `{model: "auto" \| "heuristic" \| provider}`. A provider without a key is 409.                                                                                                                                                                              |
| PUT / DELETE | `/api/llm/keys/:name`                 | Save your own key `{api_key}` after one test call (422 if rejected, 502 if the provider can't be reached; a key out of free quota is saved with `test: "rate_limited"`), or remove it. Limit 10/min. ADR 0006.                                              |

## Connect a real Gmail account

This is a one-time setup on the free tier, done once by whoever runs InboxPilot (not by each user).

Reading Gmail is a _restricted_ Google permission: every app that reads Gmail goes through an OAuth client registered in Google Cloud by someone. Third-party "managed" sign-in services only swap in their own client, and route your tokens and mail through them, so InboxPilot uses your own client (decision recorded in SPEC, 2026-10-18).

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, then go to **APIs & Services → Library** and enable the **Gmail API**.
2. Go to **OAuth consent screen** (Google Auth Platform → Audience). Choose **External**.
3. Add the scopes `openid`, `email`, `profile` and `https://www.googleapis.com/auth/gmail.readonly`. Add nothing broader.
4. Go to **Credentials → Create credentials → OAuth client ID → Web application**. Set the authorised redirect URI to `http://localhost:5173/api/auth/google/callback`.
5. Put the client ID and secret in the repo-root `.env`, along with a token key:
   ```bash
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   TOKEN_ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
   ```
6. **Publish the app:** on **Audience**, click **Publish app** so the status is **In production**. Do this even for personal use:
   - In **Testing**, only addresses on the _Test users_ list can sign in, and Google expires every sign-in after **7 days** (the dashboard then shows "Your Gmail connection has expired… Reconnect Gmail").
   - **In production**, any Google account can sign in with no test-user list, and sign-ins stop expiring weekly.
   - Until Google verifies the app (only needed for a public product), people see **"Google hasn't verified this app"** once. They click **Advanced → Go to InboxPilot (unsafe)** to continue, and Google may cap the app at 100 users. Access stays read-only.
7. Restart the stack, open http://localhost:5173 and click **Connect Gmail**. Approve the consent screen and you land back on the dashboard, signed in; **Sync** then reads your real inbox.

If Google ever ends access (the 7-day Testing limit, or access removed under your Google account's _Third-party connections_), the stored token is cleared, background checks stop, and the dashboard shows **Reconnect Gmail**. One click signs in again to the same account; tasks are kept.

### What the Google integration does

- **Sign-in** uses the Authorization Code flow with PKCE (S256). The `state` value is single-use (Redis `GETDEL`, 10 min), and it must match an `httpOnly` cookie set when sign-in started, which defends against login-CSRF. The flow requests `access_type=offline`. `prompt=consent` (the permission screen, which is what makes Google return a refresh token) is sent only when we hold no Gmail token for the person. After a sign-in, an `httpOnly` cookie `ip_account` (the InboxPilot user id, 180 days, kept after logout, cleared on account deletion) remembers the account on this browser, so the next sign-in sends `login_hint` (no account chooser) and skips consent. If Google then returns no refresh token for an account we hold none for, the flow restarts once with consent. A returning user's sign-in also starts a background sync at once. It checks that the `gmail.readonly` scope was actually granted and that the email is verified. Every failure lands on the web app as `?auth_error=<code>`.
- **Tokens.** Refresh tokens are stored as AES-256-GCM ciphertext in `users.refresh_token_enc`, bound to the user id as associated data. Access tokens are cached in Redis (`gtoken:{user}`), also encrypted, for their lifetime minus 60 s. If Google returns `invalid_grant` (the user revoked access), the stored token is cleared and the run fails with "Sign in with Google again."
- **Gmail.** The first sync lists `newer_than:14d in:inbox -category:promotions -category:social` (up to `SYNC_MAX_EMAILS`) and fetches messages 5 at a time with `format=full`. Later syncs use `users.history.list` from the stored `historyId`, and fall back to a full listing if that id has expired. The checkpoint is read _before_ listing and saved only after a successful run, so no mail is ever skipped. The client backs off exponentially on 429, 5xx and rate-limit 403s (honouring `Retry-After`) and refreshes the token once on a 401.
- **MIME parsing** prefers `text/plain`; otherwise it converts `text/html` to text, dropping scripts, styles and comments and decoding entities. It ignores attachments, honours each part's charset, and decodes RFC 2047 encoded headers.
- **Disconnect.** `DELETE /api/me` revokes the refresh token at Google (best effort; the account is deleted even if Google is unreachable), then deletes every row.

The tests use an in-process fake Google (`tests/fake-google.ts`) that enforces PKCE, single-use codes, `redirect_uri` matching, expiring access tokens and revocable refresh tokens. No test calls the real Google.

## How a sync works

1. `POST /api/sync` takes a Redis lock `synclock:{user}`, creates a `sync_runs` row and queues a BullMQ job.
2. The worker fetches mail from Gmail (full listing or incremental, as above). It records email metadata (`UNIQUE(user_id, gmail_id)`), skips emails already processed (unless `reprocess`), and holds bodies **in Redis only** (`body:*`, 1 h TTL, deleted when the run ends).
3. It sends batches of `SYNC_CHUNK_SIZE` (12) emails to `POST /v1/extract`, retrying once on a transient error. Each chunk streams progress, and a degraded extract step streams a `provider_switch` event.
4. Tasks are upserted with one SQL `INSERT … ON CONFLICT`. `status` and `snoozed_until` are never in the update set, and a due date the user edited (`due_overridden`) is kept.
5. The briefing is regenerated over **all** open tasks (`POST /v1/briefing`). The run is saved with its merged trace and usage, and an audit row is written. Progress events go out over Redis pub/sub with one shared subscriber per process.

**Background checks (auto-refresh).** A BullMQ job scheduler (`src/jobs/autosync.ts`) starts the same sync, with `stats.trigger = "auto"`, for every connected user whose last sync is older than `AUTO_SYNC_INTERVAL_S` (default 120; `0` turns it off). It skips users who are already syncing and waits 10 minutes after a failed run. A background check that finds no new mail advances the Gmail checkpoint and `last_sync_at` but deletes its run row, so the Agent runs page only lists checks that did something. The web app notices new runs by polling `/api/sync/runs`.

## Security

- Sessions are HS256 JWTs in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). They are revocable through a Redis allow-list.
- Mutating requests are rejected when `Origin` is a foreign origin. Only JSON bodies are parsed, so `text/plain` gets a 415 (no "simple" cross-site POSTs).
- `@fastify/helmet` sets CSP and related headers. `@fastify/rate-limit` keeps its counters in Redis (`rl:*`).
- Pino logs redact cookies, auth headers, tokens and any `body_text`. Validation errors never echo input.
- Email bodies are never written to Postgres; a test checks the schema for this.

## Tests

```bash
npm run lint && npm run typecheck
npm test                 # or: npm run test:cov
```

Tests need Postgres and Redis from `docker compose`. They use a separate `inboxpilot_test` database and Redis db 15.

The agent is a **contract-validated fake**: every request and response it handles is checked against the shared JSON Schema. The exception is `tests/integration.agent.test.ts`, which starts the **real Python agent** (heuristic only, no keys) and runs the fixture inbox end to end. It skips itself when `services/agent/.venv` is missing.

Pinned majors: Prisma 6, zod 3, vitest 3, BullMQ 5. These are well-known stable lines; newer majors exist.
