# ADR 0006: Users bring their own free LLM API keys

- **Status:** accepted (2026-10-18)
- **Extends:** ADR 0003 (LLM router), ADR 0004 (storage)

## Context

Until now the LLM providers were enabled only by API keys in the server's `.env`. A user of a
running instance had no way to switch on an AI model, choose one, or find out why one stopped
working. Every useful provider has a free tier, but each needs its own key, and free quotas run
out mid-sync.

## Decision

1. **Keys can be saved per user** through the gateway (`PUT /api/llm/keys/:name`), one per provider. (This was first a Settings card; see the update at the end: keys now come from `.env`.) Before a key is
   saved, the agent makes one tiny call with it (`POST /v1/providers/test`):
   - a rejected key (401/403) is refused with a plain reason;
   - an unreachable provider is not saved ("try again");
   - a key that is valid but out of free quota (429) is saved, and its cooldown is shown.
2. **Storage:** all of a user's keys are one AES-256-GCM blob in `users.llm_keys_enc`, encrypted
   with `TOKEN_ENC_KEY` and bound to the user id as associated data (the same scheme as Google
   refresh tokens). The browser only ever receives a hint (`••••7a1f`). Audit rows record the
   provider, never the key. Deleting the account deletes the blob.
3. **Transport:** the gateway decrypts the keys only for that user's own agent calls (extract,
   briefing, ask, provider status) and sends them in `options.provider_keys` over the private
   network with the internal key. The agent holds them as `SecretStr` for the request only: they
   are never logged, echoed in errors, cached, or stored.
4. **Circuits per key:** `LLMRouter.with_keys()` builds a per-request view whose providers use the
   user's keys. Cooldowns are keyed by a SHA-256 fingerprint of the key, so one user's exhausted
   free quota never pauses another user or the server's own key. Status reports *why* a circuit is
   open (`rate_limited`, `auth`, `failures`).
5. **Choosing a model:** `PUT /api/llm/model` with `auto` (every model with a key, in order),
   `heuristic` (rules only), or one provider (that provider, then the rules reader). The model
   picker sits in the header like the Types filter. A provider without a key is listed but
   disabled ("add a free key").
6. **Saying what happened:** when the chosen model is paused, the dashboard shows a banner saying
   which model, why (free limit used up, key rejected, not responding), roughly when it is back,
   what is reading the mail meanwhile, and a picker to switch to a model that is ready.
   Automatic fail-over (ADR 0003) is unchanged.
7. **A new key takes effect at once:** saving a working key rewrites today's briefing and starts
   a re-read of the last 14 days with it (`reprocess`), so tasks the rules reader made are upgraded
   immediately, not only for new mail. Done tasks, dismissals and edited due dates are kept. While
   no model has a key, the dashboard says the rules reader is in use and links to Settings.

## Update (2026-10-18)

The Settings → AI models card was removed from the UI at the product owner's request. Keys are now provided in `.env`; the model is chosen in the header picker (Gemini, Groq, OpenAI GPT via GitHub Models, Ollama or Rules only). The storage, transport and per-key circuit design above is unchanged and the `/api/llm/keys/:name` endpoints remain for API use.

## Consequences

- Only providers in the server's `LLM_PROVIDERS` list can be keyed (the default lists them all).
  Ollama takes no key; it is configured on the server.
- Server keys in `.env` still work and act as defaults for everyone.
- `TOKEN_ENC_KEY` is now needed for user keys as well; without it the UI says keys can't be saved.
- Rotating `TOKEN_ENC_KEY` makes saved LLM keys unreadable; they are then treated as absent and
  users re-enter them.
- Tests never call a real LLM: the agent's tests mock HTTP with respx, the gateway uses a
  contract-validated fake agent, and the e2e suite points Groq at a local fake LLM.
