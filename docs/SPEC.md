# InboxPilot — Specification

Status: **Draft for review (Phase 0)** · Last updated: 2026-10-17

## 1. Problem

Action items ("review by Friday", "invoice due on the 20th", "interview Tuesday 3 PM") are buried in email threads. The inbox is sorted by arrival time, not by what needs doing, so commitments get missed.

## 2. Users

| User | Need |
|---|---|
| **Primary: a busy individual Gmail user** | Open one page in the morning and see what they must do today and this week, and why. |
| **Reviewer / interviewer** (no Gmail access granted) | Run every test suite, including the browser e2e against a local fake Google, without a Google account or LLM keys. Running the app itself needs a free Google OAuth client. |

Single user per deployment. Multi-tenancy is a non-goal.

## 3. Outcomes (what "working" means)

InboxPilot connects to a user's Gmail **read-only**, reads the last 7–14 days of mail, and returns a prioritised task list for **today** and the **next 7 days**. Each task has:

- a title that starts with a verb, and a type (`deadline | meeting | payment | review | reply | send | call | follow_up | other`)
- a due date (and time if one is known), resolved relative to **when the email was sent**, in the **user's timezone**
- a priority P0–P3, a 0–100 score, and human-readable reasons for the score
- a confidence, the model that extracted it, and the **exact evidence sentence** from the email
- a deep link back to the Gmail thread

The dashboard shows **Overdue · Today · Next 7 days · Later · No date**, a separate **Needs review** list for low-confidence items, and a short daily briefing.

### Success criteria

| Criterion | Target | Checked by |
|---|---|---|
| Action-item recall on the eval set | ≥ 85% | `make eval`, 30 labelled emails |
| Action-item precision | ≥ 80% | same eval |
| Due-date accuracy (exact day) | ≥ 90% | resolver unit tests + eval |
| Sync of 50 emails, end to end | < 30 s on free LLM tiers | timing in the agent trace |
| App still answers with all LLM keys removed | 100% | router test with zero keys |
| Tests green in CI | all suites | GitHub Actions on every push |

## 4. Functional requirements

| ID | Requirement |
|---|---|
| F1 | Sign in with Google OAuth 2.0 (Authorization Code + PKCE). Scopes: `openid email profile https://www.googleapis.com/auth/gmail.readonly`, nothing broader. |
| F2 | ~~Demo mode~~ removed (2026-10-17): the app works only with real Gmail. New mail is picked up by a background check (`AUTO_SYNC_INTERVAL_S`, default 120 s) and the dashboard refreshes itself. `GET /api/emails?days=1–30` (default 7) lists the mail from the N days **before today** (user's timezone) with what happened to each email; the UI shows it as **Past 7 days**. |
| F3 | Sync: fetch up to 50 messages from the last N days (default 14, range 1–30), excluding `category:promotions` and `category:social`. Only unseen message ids go to the agent. Incremental sync uses `historyId`. |
| F4 | Agent pipeline: Preprocess (with PII redaction) → Triage → Extract (LLM, 5–6 emails per call) → Grounding → Temporal → Priority → Dedupe + Planner. Only Extract and, optionally, the briefing call an LLM. |
| F5 | Live progress over SSE: `fetching`, `triage`, `extracting`, `provider_switch`, `done`, `error`. |
| F6 | Task actions: mark done, snooze until a time, dismiss, edit the due date. **A re-sync never overwrites these user edits and never duplicates a task.** |
| F7 | Buckets are computed **at read time** from `due_date` and the user's current local date, so lists are correct tomorrow without re-running the agent. |
| F8 | Ask box: answers questions such as "What's due before Friday?" using only the user's tasks, and cites the task ids it used. |
| F9 | Settings: profile, appearance (light/dark mode and live background), sign out (with an option to forget this browser), and disconnect plus delete all data. The AI model is chosen from the header menu, not from Settings. |
| F10 | Explainability: every task shows its evidence, extractor, confidence and priority reasons. Every sync stores a step-by-step agent trace that records fallbacks. |

### Deterministic rules (not done by the LLM)

**Temporal resolver.** Converts `due_phrase` + email `sent_at` + user timezone into `due_date` / `due_at` / `has_time`. It must handle weekday names ("Friday" means the next occurrence on or after the sent date; "next Tue" means the weekday in the following week), times ("3 PM", "15:30", "noon"), "EOD" (17:00 local), "tomorrow", "in N days", "end of month", ordinals ("the 20th" rolls to next month if already past) and month-day ("Jan 3" sent on Dec 28 rolls to next year). It falls back to the LLM's `due_iso_guess` only when the resolver cannot parse the phrase. `date_source` records which path was used: `resolver | llm | none`.

**Priority scorer.** Raw score = urgency + type weight + VIP + urgent words, then scaled by confidence.

| Component | Values |
|---|---|
| Urgency | overdue 45 · today 40 · tomorrow 32 · ≤ 3 days 24 · ≤ 7 days 14 · later 6 · no date 4 |
| Type weight | interview 18 (a `meeting` whose title or evidence mentions "interview"; there is no separate `interview` type) · payment 15 · deadline 14 · meeting 12 · review 10 · reply/send/call 8 · follow_up 6 · other 4 |
| VIP sender | +15 |
| Urgent words ("urgent", "ASAP", "immediately", "final notice", "overdue") | +12 |
| Confidence scaling | `score = round(raw × (0.6 + 0.4 × confidence))`, clamped to 0–100 |
| Thresholds | P0 ≥ 70 · P1 ≥ 50 · P2 ≥ 30 · P3 otherwise |

Every non-zero component adds a reason string, e.g. `"Due today"`, `"Payment"`, `"VIP sender"`.

**Low confidence.** Items with confidence < 0.5 go to **Needs review**, not to Today.

## 5. Constraints

- **Free and open-source models only.** No paid subscription is needed. The LLM router fails over Gemini → Groq → GitHub Models → Cerebras → OpenRouter → Mistral → HF → Ollama → Heuristic. The heuristic is always available. Quota limits are never hard-coded.
- **Runs locally with one command** (`make dev`, Docker Compose). No cloud deployment is required.
- **Privacy.** Full email bodies are never stored in Postgres. Bodies sit in Redis with a 1 h TTL during processing only. PII is redacted before any prompt. Refresh tokens are AES-256-GCM encrypted. Metadata retention is 30 days and the audit log 90 days.
- **Untrusted input.** Email content is data, never instructions. The LLM has no tools, its output is schema-validated, and items whose evidence is not found in the email are dropped.
- **Stack** (see ADRs): React 18 + Vite + TS · Node 22 + Fastify 5 + TS · Python 3.12 + FastAPI · Postgres 16 · Redis 7.
- **Tests never call real LLMs or Gmail.** Real-LLM checks run only in `make eval`.

## 6. Non-goals

- Sending, replying to, labelling or modifying email (the scope is read-only)
- Calendar write-back
- Multi-user tenancy, SSO or org admin
- Mobile apps (no Flutter or React Native)
- Production cloud deployment or hosting
- Real-time push sync via Gmail `users.watch` (this is on the roadmap)
- Tracking the user's own commitments from Sent mail (this is on the roadmap)

## 7. Interfaces

- Public API (browser → Node gateway, `/api/*`): see the playbook §7. Errors use RFC 7807 problem JSON, and every response carries `x-request-id`.
- Internal API (gateway → agent, `/v1/*`, header `X-Internal-Key`): `GET /v1/health`, `GET /v1/providers`, `POST /v1/extract`, `POST /v1/ask`.
- **Contract source of truth:** [`packages/contracts/extract.schema.json`](../packages/contracts/extract.schema.json), plus fixtures in `packages/contracts/fixtures/`. Both services validate against it in CI.

## 8. Open questions (need a decision before or during Phase 1)

Each question has a proposed default. Unless you say otherwise, the proposed default is what gets built.

| # | Question | Proposed default |
|---|---|---|
| Q1 | **Stable task id.** The playbook uses `sha1(gmail_id + normalised title)`. Titles are LLM-generated and differ between providers, so a re-sync that fails over to another model would create a duplicate task and lose the user's "done" status. | `sha1(gmail_id + normalised evidence)`. Grounding guarantees the evidence is verbatim from the email, so it is stable across providers. The title is kept as display data only. |
| Q2 | **SQLite fallback.** Prisma fixes the provider per schema, and the design relies on Postgres features (`JSONB`, `TEXT[]`, `BYTEA`, `gen_random_uuid()`). | Drop the SQLite fallback and require Docker for Postgres. Keep "no Docker" out of scope, and note it in the README. |
| Q3 | **In-memory Redis fallback.** BullMQ needs a real Redis. | Redis is required (in Docker). A fake Redis is used only inside unit tests. |
| Q4 | **LLM cache key.** `sha256(prompt + model)` includes "Today is {now}", so the key changes every call and the cache never hits. | Hash `system + model + emails (id, sent, clean body) + user timezone + date(now)`. A same-day re-sync then hits the cache. |
| Q5 | **Confidence scaling formula.** The playbook says only "scaled by confidence". | `raw × (0.6 + 0.4 × confidence)` (see §4). A confidence of 0.5 still keeps 80% of the urgency signal. |
| Q6 | **Urgency for items more than 7 days out, or with no date.** The playbook doesn't specify. | later 6, no date 4. |
| Q7 | **Agent orchestration.** LangGraph or a hand-written state machine? | Hand-written orchestrator (ADR 0005). |
| Q8 | **Which buckets the agent returns.** The agent returns `bucket` for convenience, but the gateway recomputes buckets at read time (F7). | Keep `bucket` in the contract as advisory. The gateway is authoritative. |
| Q9 | **Default timezone.** | `Asia/Kolkata`, overridable in settings. On Google sign-in, use the browser's `Intl` timezone. |
| Q10 | **ORM.** Prisma or Drizzle? | Prisma (named in the master prompt). |

### Status after Phase 1 (agent core)

- **Built as proposed:** Q1 (the task id comes from the evidence), Q5 (confidence scaling), Q6 (urgency for later and undated items), Q7 (hand-written orchestrator) and Q8 (the agent's `bucket` is advisory).
- **Contract change:** `EmailInput.body_text` now has `maxLength: 200000`. This rejects oversized payloads before any regex runs on them.
- **Decided while building:**
  - "next <weekday>" means that weekday in the following Monday-start week.
  - Explicit dates up to 7 days in the past stay put and show as overdue. Older ones roll forward to next year.
  - Numeric dates are read as D/M, except in US timezones, where they are read as M/D.
  - A time with no date means today, or tomorrow if that time had already passed when the email was sent.
  - Grounding drops a `due_phrase` that is not found in the email, and lowers the item's confidence by 20%.
  - Contact boilerplate ("call us for queries") is never turned into a task.

### Status after Phase 2 (LLM router + eval)

- **Q4 (cache key):** resolved by putting today's *date*, not a timestamp, in the prompt. The cache key stays `sha256(provider, model, system, user)` as ADR 0003 says, and a same-day re-sync hits the cache.
- **New:** `/v1/providers` and `/v1/ask` are in the contract (`ProviderStatus`, `ProvidersResponse`).
  - Ask always runs a deterministic filter (date bound, overdue, type, sender). An LLM may only rephrase the answer and cite ids it was given.
- **New:** an optional LLM briefing (`use_llm_briefing`). The counts always stay deterministic, and any failure falls back to the template.
- **New:** `EXTRACT_CONCURRENCY` (default 3) caps parallel LLM calls per sync, because free tiers rate-limit by requests per minute.
- **Dedupe rule added:** within one email, an undated item merges into a dated item of the same type (found by the eval).
- **Open:**
  - The real-LLM eval rows are still pending API keys or a pulled Ollama model.
  - The eval set is small and was written by the same author as the rules, so it should grow with untuned emails.

### Status after Phase 3 (gateway)

- **Q2/Q3 confirmed:** Postgres and Redis are required, via `docker compose`. There is no SQLite or in-memory fallback.
- **Tasks key:** the primary key is `(user_id, id)`, not `id`. Gmail message ids are unique per mailbox, not globally, so the agent's task id is unique per user.
- **Briefing over all open tasks:** a new `POST /v1/briefing` endpoint in the contract. Per-sync agent briefings only saw that sync's emails. Counts are always live; the text is cached per local day.
- **`date_source: "user"`** was added to the contract. A due date edited in the UI is kept on re-sync (`due_overridden`).
- **`reprocess`** sync option: re-sends already-processed mail (LLM-cache-friendly). Used to show that a re-sync never reopens done tasks.
- **Found by the live run:** times in Ask and briefing text were formatted in UTC. They are now converted to the user's timezone, with a regression test.
- **Found by the integration test:** urgency in the subject line ("URGENT: …") now counts toward priority.
- **Q11 (open): priority staleness.** The priority score is computed at sync time. Buckets are recomputed at read time, but a task that was P2 "due in 5 days" keeps its score as the date approaches. Options:
  - (a) re-score the urgency part at read time in the gateway, sharing a fixture table with the agent so the two implementations can't drift (**proposed**)
  - (b) a nightly re-score job
  - (c) accept it, because sorting within a bucket is still correct

### Status after Phase 4 (Gmail)

- **Built:** Google OAuth (Code + PKCE, `gmail.readonly` only), AES-256-GCM token storage, Gmail fetch and MIME parsing, incremental sync via `historyId`, back-off, and disconnect with revocation at Google. See `services/api/README.md`.
- **Additions beyond the playbook:**
  - The sign-in `state` is bound to the starting browser by a cookie (login-CSRF).
  - Token ciphertext is bound to the user id, so a token copied onto another row fails to decrypt.
  - Granted scopes and email verification are checked.
  - The history checkpoint is captured before listing, so mail arriving mid-sync is never skipped.
- **"Done when: your real inbox syncs" is not yet verified.** It needs your Google Cloud OAuth client (setup steps in the README). Everything up to Google's servers is tested against a protocol-faithful fake. A real-account run is the remaining check.
- **Known limits:**
  - Message bodies larger than Gmail inlines (`attachmentId` on a text part) are skipped rather than fetched.
  - Real-time push (`users.watch`) remains on the roadmap.

### Status after Phase 5 (UI)

- **Built:** landing, dashboard (briefing, KPIs, 7-day strip, grouped lists, filters, Needs review), live agent-run panel over SSE, Ask, the Agent runs page, settings (timezone, VIPs, model order, theme, delete), dark mode, skeletons, and empty and error states. See `apps/web/README.md`.
- **Decided while building:**
  - Task actions are optimistic, with Undo.
  - Snooze presets are computed in the user's timezone (DST-safe).
  - The first visit after connecting Gmail auto-starts a sync so the agent trace is visible immediately.
  - One shared EventSource per page.
  - `Intl.supportedValuesOf` is used only for timezone suggestions. Validation goes through `Intl.DateTimeFormat`, because the CLDR list says `Asia/Calcutta`, not `Asia/Kolkata`.
- **Not done:**
  - Recharts KPI charts. The 7-day strip is a plain accessible bar list instead, to avoid another dependency.
  - Snooze presets beyond the three listed above.

### Status after Phase 6 (ship)

- **One command:** `docker compose up --build -d --wait` (or `make dev`) runs Postgres, Redis, agent, gateway and web (nginx). Ollama is an optional profile. Without LLM keys extraction is rules-only; a Google OAuth client is required.
- **Delivered:**
  - **CI:** lint and types, tests for all three services, the contract in both directions, Playwright e2e, gitleaks + npm audit + pip-audit, and a Docker image build.
  - **Retention:** a nightly job.
  - **Docs:** README, ARCHITECTURE, ROADMAP, and an updated SECURITY.
- **Google redirect URI** is now `http://localhost:5173/api/auth/google/callback` in every mode. Vite and nginx both proxy `/api` on the web origin.
- **Still open:**
  - real-LLM eval rows (need keys)
  - a real-Gmail run (needs an OAuth client)
  - the CI workflow has not been executed on GitHub (the project is not a git repository by choice)

### Q11 resolved: read-time re-scoring

- The agent now also returns `priority_base`, the date-independent points (type + VIP + urgent words). This is an additive, optional field in contract v1.
- The gateway stores it and recomputes urgency, score, priority and the first reason for **today** on every read. The task list, Ask and the briefing all see current priorities. Priority filtering and sorting run after re-scoring.
- Both implementations (`prioritize.combine` in Python, `lib/priority.ts` in TypeScript) are tested against one table, `packages/contracts/fixtures/priority_cases.json` (11 cases, values computed by hand from §4).
- Rows written before this change have no base and keep their sync-time score until the next sync.
- **Side effect:** a user-edited due date now also updates the priority. Previously the stored score was computed from the agent's date.

### Change after Phase 6: real Gmail only, auto-refresh, past 7 days (2026-10-17)

- **Demo mode removed.** `POST /api/auth/demo`, the demo inbox and the landing "Try the demo" button are gone. Migration `20261018010000_google_only` deletes old demo users and restricts `auth_mode` to `google`. API tests use a fixture mail source (`services/api/tests/fixtures/inbox.ts`); the e2e suite signs in through a local fake Google (`GOOGLE_EMULATOR_URL`, refused in production).
- **Auto-refresh.** Gmail push (`users.watch`) needs a public Pub/Sub endpoint, so instead a BullMQ scheduler checks every connected inbox whose last sync is older than `AUTO_SYNC_INTERVAL_S` (default 120 s; `0` disables). It skips users who are already syncing and backs off 10 minutes after a failed run. A background check that finds nothing new advances the checkpoint and leaves no run row behind. The web app polls `/api/sync/runs` every 15 s: it follows a running background sync live, and refreshes tasks, briefing and mail when one finishes.
- **Past 7 days.** `GET /api/emails?days=7` returns mail from the 7 local days before today (today's mail is excluded: it belongs to *Upcoming*), newest first, each with its status, skip reason, Gmail link and all of its tasks (any status). The response carries `from` (first day, inclusive) and `today`. The dashboard has *Upcoming* / *Past 7 days* tabs. Past 7 days renders the same KPI tiles (over the tasks from those emails), a 7-day calendar strip of the past week (weekday, date, email count; a day with mail jumps to its group), and tasks with the same `TaskCard` and filters as Upcoming; done, dismissed and still-snoozed tasks are labelled in words (never "overdue") and have a **Reopen** action.
- **Reverting actions.** `GET /api/tasks?status=closed` returns done, dismissed and still-snoozed tasks. The Upcoming tab lists them under *Done, snoozed & dismissed* (most recently changed first, 5 shown, "Show all"), each with **Reopen** (`PATCH {status: "open"}`, which also clears `snoozed_until`). Actions never touch due date, priority or evidence, so reopening restores the original task; a gateway test checks the reopened list is identical to the original.
- **Your own AI keys (ADR 0006).** Settings → AI models lists every provider with a "Get a free key" link. A pasted key is tested with one tiny call (`POST /v1/providers/test`): rejected keys are refused with the reason, unreachable providers are not saved, and a valid key that is out of free quota is saved with its cooldown. Keys are stored as one AES-256-GCM blob per user (`users.llm_keys_enc`) and sent to the agent per request in `options.provider_keys`. The browser only sees `••••last4`. Cooldowns are tracked per key fingerprint. The header has a model picker (Auto / one provider / Rules only), and the dashboard shows a banner when the chosen model is paused (free limit used up, key rejected, not responding) with a switch-to picker. API: `GET /api/providers`, `PUT /api/llm/model`, `PUT|DELETE /api/llm/keys/:name`.
- **Gmail access stays on the operator's own Google OAuth client (decided 2026-10-18).** Third-party managed sign-in (Composio, Pipedream Connect) was considered: it removes the Google Cloud setup, but it routes Gmail tokens and mail through a third party, uses fixed scopes broader than `gmail.readonly`, and read-only setups were reported blocked or shown as unverified. Instead the setup guide has the app published **In production** (no test-user list, no 7-day expiry, a one-time "unverified app" notice). `/api/me` reports `gmail_connected`, and the dashboard shows **Reconnect Gmail** when Google ends access.
- **One-click re-login (2026-10-18).** A Google sign-in remembers the browser (`remembered_devices`: a random secret in an `httpOnly` cookie, only its SHA-256 stored, rotated on every use, 180 days). After logout the landing page shows **Continue as …**: one `POST /api/auth/resume` signs in with no trip to Google (Gmail access is the stored refresh token) and starts a sync. **Use another Google account** and **Not you? Forget this browser** / **Sign out and forget this browser** are always offered. If Google ended access, the button becomes **Reconnect Gmail** (Google, with consent). The first sign-in on a browser still goes through Google's screens, including the "unverified app" notice until the app is verified.
- **Server keys, model choice, themes (2026-10-18).** Gemini defaults to `gemini-flash-lite-latest` (Google closed `gemini-2.5-flash` to new keys, and the full Flash answered in 28-56 s). Picking a specific, working model re-reads the last 14 days with it, keeping user edits. Agent error codes `NO_CREDIT` (HTTP 402: free credits used up) and `MODEL_RETIRED` give plain messages. The dashboard has five colour themes (Inbox Blue, Inbox Zero, Paper & Ink, Midnight Courier, Lavender Digest), each with light and dark variants, chosen in the header theme menu or Settings → Appearance and remembered per browser. Priority colours never change between themes, and a test checks WCAG AA contrast for every theme.
- **Settings trimmed (2026-10-18).** Settings now holds only Profile, Appearance (mode + live background), Sign out and Delete. The AI models card (per-user keys), Prioritisation (timezone, VIP senders) and the Colour theme picker were removed from Settings at the product owner's request. Colour themes remain in the header theme menu; model choice remains in the header picker (and at the top of the dashboard on phones). AI keys are set in `.env`. The backend endpoints for user keys and settings are unchanged.
- **The selected model writes everything (2026-10-18).** The daily briefing and Ask answers used the server's default model order, so with another model selected the briefing still said "Written by gemini". `/v1/briefing`, `/v1/ask` and the pipeline's plan step now pass the user's selection (`options.providers`) to the router, and **Rules only** means no LLM call at all (task titles are no longer sent to a model for the briefing). The briefing is rewritten whenever the model changes (cache invalidated), and the card names the author in plain words ("Written by OpenAI GPT (GitHub Models)"). A selected model that cannot answer is never silently replaced by another AI model: the briefing falls back to rules and says so. A model that is out of credit (HTTP 402, `NO_CREDIT`) opens its circuit for 10 minutes with reason `no_credit`, and the dashboard banner explains it and offers the models that work.
- **Open:** real-time push via Pub/Sub remains on the roadmap.
- **Free and open-source models only (2026-10-18).** Anthropic Claude (a paid subscription API) was removed: its adapter, key handling, contract value and tests are gone. The model menu offers **Google Gemini** (free tier), **Groq** (open-weights Llama, free tier), **OpenAI GPT via GitHub Models** (`gpt-4o-mini`, free with a GitHub token), **Ollama** (local Llama, fully open source, no key) and **Rules only (no AI)**. The default server order is `gemini,groq,github,cerebras,openrouter,mistral,hf,ollama,heuristic`; every other adapter stays a configuration choice. A saved selection or saved key that names a removed provider is ignored (treated as automatic) and migration `20261018040000` resets it.

