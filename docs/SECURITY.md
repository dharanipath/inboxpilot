# Security and privacy

InboxPilot reads private email, so security is a feature, not a footnote. This page is the threat model. Each control is listed with **where it lives** and **which test proves it**.

## Data we hold

| Data | Where | Lifetime |
|---|---|---|
| Email **bodies** | Redis only (`body:{user}:{msg}`), during a sync | ≤ 1 h; deleted when the run ends. **Never in Postgres.** |
| Email metadata (id, thread, from, subject, date) | Postgres `emails` | 30 days once none of its tasks remain (nightly retention job) |
| Tasks + evidence sentence (PII-redacted) | Postgres `tasks` | open: until deleted; done or dismissed: 30 days |
| Google refresh token | Postgres `users.refresh_token_enc`, AES-256-GCM | until disconnect |
| Google access token | Redis `gtoken:{user}`, AES-256-GCM | ~55 min |
| Sessions | Redis allow-list `session:{jti}` + `httpOnly` cookie | 7 days, or until logout |

## Users' own LLM API keys (ADR 0006)

- Entered in Settings, checked with one tiny provider call, then stored as one AES-256-GCM blob per user in `users.llm_keys_enc` (key: `TOKEN_ENC_KEY`; the user id is bound as associated data, so a blob copied to another row does not decrypt).
- Never returned to the browser (only `••••` + last 4), never written to logs (Pino redacts `api_key` and `provider_keys`; the agent holds them as `SecretStr`), never cached, and never put in audit rows (only the provider name).
- Sent to the agent only for that user's own requests, over the private network with the internal key. Cooldowns are keyed by a SHA-256 fingerprint, not the key.
- Deleting the account deletes the blob. Rotating `TOKEN_ENC_KEY` makes saved keys unreadable; users re-enter them.

## Remembered browsers (one-click sign-in)

- After a Google sign-in, the browser gets `ip_device` = device id + 32 random bytes (`httpOnly`, `SameSite=Lax`, path `/api/auth`, 180 days). Postgres stores only a SHA-256 of the secret (`remembered_devices`), compared in constant time.
- Each use rotates the secret, so a copied cookie stops working after the owner's next sign-in.
- Trade-off: a normal sign-out keeps the shortcut, so anyone using that browser profile can click **Continue as …**. Shared computers should use **Sign out and forget this browser**, or **Not you? Forget this browser** on the landing page. Deleting the account deletes every device (cascade). The nightly retention job removes expired devices.
- Resuming never grants Gmail access by itself: it needs the stored, encrypted refresh token. If Google ended access, the user must go through Google again.

## Threats and controls

| Threat | Control | Code | Proven by |
|---|---|---|---|
| Over-broad Gmail access | Only `openid email profile gmail.readonly`; the granted scope is re-checked on callback | `google/oauth.ts`, `routes/auth.ts` | `google-unit.test.ts` (no send/modify scopes), `google-flow.test.ts` (`insufficient_scope`) |
| Stolen refresh token (DB leak) | AES-256-GCM with the key in env (`TOKEN_ENC_KEY`), bound to the user id as associated data; never logged; revoked on disconnect | `lib/crypto.ts`, `google/tokens.ts` | tamper / wrong-user / wrong-key tests; "ciphertext only" assertion; revoke-on-delete test |
| OAuth CSRF / code injection | Single-use `state` (Redis `GETDEL`, 10 min) + PKCE S256 + a cookie that binds the flow to the browser that started it | `routes/auth.ts` | replayed callback, missing cookie and bad verifier all rejected |
| Session hijack / XSS | JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production); server-side revocation; CSP via helmet; React escapes output (Phase 5) | `auth/session.ts`, `app.ts` | logout revokes immediately; tampered JWT rejected; security headers present |
| CSRF on the API | Mutating requests with a foreign `Origin` → 403; JSON-only bodies (`text/plain` → 415, so no preflight-free cross-site POSTs) | `app.ts` | `auth.test.ts` CSRF test |
| **Prompt injection** in email | Email is wrapped in `<email>` tags and declared untrusted; fake closing tags are neutralised; the model has no tools; output is schema-validated; **grounding** drops any task whose evidence isn't quoted from the email | agent `llm/prompts.py`, `pipeline/grounding.py` | injected email produces no tasks (agent + cross-service tests); hallucinated task dropped |
| PII sent to LLM providers | Phone, card (Luhn-checked), Aadhaar, PAN and account numbers are redacted **before** any prompt; bodies are cleaned and truncated to 4,000 chars; Ollama keeps everything local | agent `pipeline/preprocess.py` | redaction tests; "no raw numbers in evidence" cross-service test |
| Email text leaking into logs or errors | Pino/structlog redaction (cookies, auth, tokens, `body_text`); validation errors never echo input; LLM repair errors list only field locations | `app.ts`, agent `main.py`, `llm/router.py` | "does not echo input" tests on both services |
| Secrets in code | `.env` (git-ignored) + `.env.example`; config fails fast when incomplete (e.g. Google without `TOKEN_ENC_KEY`) | `config.ts` | config tests |
| Abuse / cost spikes | Redis-backed rate limits (global, plus sign-up, sync and ask); one running sync per user; email and batch caps; LLM cache | `app.ts`, `jobs/sync.ts` | rate-limit 429 test; 409 concurrent-sync test |
| Internal service spoofing | Agent only on the private network; `X-Internal-Key` compared in constant time; gateway validates every agent response against the contract | agent `main.py`, `agent/contract.ts` | 401/503 tests; contract-violation test |
| Cross-user data access | Every query is scoped by `user_id`; task key `(user_id, id)` | `db/tasks.ts`, routes | isolation tests (tasks, runs, SSE) |
| Data retention | No bodies at rest; delete-my-data endpoint cascades every row and revokes Google access | `routes/me.ts` | deletion test (other users untouched) |

## Explainability (governance)

- Every task shows its **evidence sentence**, the **model** that extracted it, its **confidence** and its **priority reasons**.
- Every sync stores an **agent trace** (each step, its duration, and any provider fallback) and per-provider usage.
- Low-confidence items (< 0.5) go to **Needs review**, never into Today.
- The audit log records login, logout, sync and account deletion.

## Operational controls (Phase 6)

- **Nightly retention job** (`services/api/src/jobs/retention.ts`, BullMQ scheduler at 03:00). It removes:
  - closed tasks after 30 days
  - email metadata after 30 days, once none of the email's tasks remain
  - sync runs after 30 days and audit entries after 90 days

  Each run is itself audited. Tested in `tests/retention.test.ts`.
- **CI** (`.github/workflows/ci.yml`) runs gitleaks over the full history, `npm audit --omit=dev --audit-level=high` for both Node apps, and `pip-audit`. Dependabot covers npm, pip, Docker and Actions.
- **Containers:**
  - all services run as non-root
  - the agent publishes no port
  - Postgres, Redis and the gateway bind to `127.0.0.1` only
  - nginx sets CSP, `X-Frame-Options: DENY`, `nosniff` and a referrer policy
  - `.dockerignore` keeps `.env` out of every image

## Not yet done

- Key rotation for `TOKEN_ENC_KEY`. Today, rotating the key forces users to reconnect: decrypt failures are treated as "Reconnect Google", never as a crash.
- HTTPS termination. The compose stack is for local use: cookies are `Secure` in production mode, but `COOKIE_SECURE=false` is the compose default because it serves plain http on localhost.
