# ADR 0003 — Multi-provider LLM router with a heuristic floor

- Status: Proposed
- Date: 2026-10-17

## Context

The project must run on free LLM tiers. Free quotas are small, change often, and run out mid-sync. A reviewer may have no keys at all. The app must keep answering in every case (success criterion: 100% with zero keys).

## Options

| Option | Notes |
|---|---|
| Single provider | Simplest, but one 429 breaks the sync. Rejected. |
| LiteLLM | Broad coverage, but a large dependency; its failover semantics are harder to show and test precisely. |
| **Own thin router over a `LLMProvider` protocol, using `httpx`** | Around 300 lines. Every behaviour is explicit and mockable with `respx`. |

## Decision

One `LLMProvider` protocol (`name`, `model`, `is_configured()`, `async complete_json(system, user, schema, timeout_s)`) with four adapters:

- `OpenAICompatibleProvider`. This is configured by base URL, key and model, and covers Groq, Cerebras, OpenRouter, Mistral, GitHub Models, HF and OpenAI.
- `GeminiProvider` (native JSON mode)
- `OllamaProvider` (local, keeps data on the machine)
- `HeuristicProvider` (rules, always configured, always last)

Every LLM call made for a user (extraction, briefing, Ask) passes that user's selected order (`options.providers`), so a selected model is never bypassed; a selection of only `heuristic` means no LLM call. A model that is out of credit (HTTP 402) raises `OutOfCredit`, which opens the circuit for 10 minutes with reason `no_credit`.

`LLMRouter` reads `LLM_PROVIDERS` (default `gemini,groq,github,cerebras,openrouter,mistral,hf,ollama,heuristic`) and skips any provider without a key. For each batch it calls the first provider whose circuit is closed:

| Event | Behaviour |
|---|---|
| 429 / quota | Open the circuit for `Retry-After` seconds (default 60), then try the next provider immediately. |
| 5xx / timeout (25 s) | Count a failure. After 3 in a row, open the circuit for 30 s. Then go to the next provider. |
| Invalid JSON / schema mismatch | Make one repair retry that includes the validation error. If that fails, go to the next provider. |
| Success | Reset the failure count and record latency. |

Circuit state is stored in Redis under `cb:{provider}`, so all workers share it. Usage (calls, failures, latency, last error) is returned in `provider_usage` and shown in the UI ("Extracted by Groq — Gemini rate-limited").

Responses are cached in Redis for 24 h. The cache key is described in SPEC open question Q4: it excludes the wall-clock "now", so same-day re-syncs hit the cache.

Temperature is 0. Batches are 5–6 emails. Triage runs before any LLM call.

## Consequences

- Adding a provider that has an OpenAI-compatible API is a config change only.
- Provider quality varies, so the eval reports precision, recall and date accuracy **per provider**.
- The heuristic provider's recall will be low, but it guarantees a non-empty, grounded answer, and it is the deterministic provider used in tests.

## Implementation notes (Phase 2)

- **Cache key.** The key is `sha256(provider, model, system prompt, user prompt)`. The user prompt states only today's date, so it is stable across same-day re-syncs (SPEC Q4).
- **Auth errors.** 401 and 403 open the circuit for 10 minutes. Retrying a bad key wastes the remaining time budget.
- **Repair retry.** The repair prompt quotes Pydantic error *locations and messages only*, never input values, so email text cannot leak into traces or `/v1/providers`.
- **Concurrency.** `EXTRACT_CONCURRENCY` (default 3) bounds parallel batches.
- **All providers failing.** `AllProvidersFailed` carries every attempt, so a fully failed batch still reports why in `provider_usage` and the trace.

## Update (2026-10-18): free models only

The `AnthropicProvider` was removed: the project runs on free-tier and open-source models (Gemini, Groq's Llama, GPT-4o mini through GitHub Models, local Ollama) plus the rules floor. The `LLMProvider` protocol is unchanged, so a paid provider can still be added as one more adapter or OpenAI-compatible entry.

