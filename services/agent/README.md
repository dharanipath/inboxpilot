# InboxPilot agent service

A stateless FastAPI service that receives emails and returns prioritised tasks. Only the gateway calls it (`X-Internal-Key`). It holds no credentials and stores nothing.

```
Preprocess (+PII) → Triage → Extract (LLM / heuristic) → Ground → Dates → Priority → Dedupe + Plan
```

Only **Extract** uses a model. Every other step is deterministic code with unit tests (ADR 0002).

## Run locally

```bash
cd services/agent
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt     # Windows (use .venv/bin/ on macOS/Linux)
INTERNAL_API_KEY=dev-key .venv/Scripts/python -m uvicorn app.main:create_app --factory --port 8000
```

| Variable | Default | Meaning |
|---|---|---|
| `INTERNAL_API_KEY` | *(required)* | Shared secret the gateway sends in `X-Internal-Key`. If it is unset, protected routes return 503. |
| `LLM_PROVIDERS` | `gemini,groq,github,cerebras,openrouter,mistral,hf,ollama,heuristic` | Failover order. Providers without a key are skipped, and `heuristic` is always appended last. |
| `<PROVIDER>_API_KEY` / `GITHUB_TOKEN` / `HF_TOKEN` / `OLLAMA_BASE_URL` | unset | See the repo-root `.env.example` |
| `<PROVIDER>_MODEL` | see `app/llm/registry.py` | Model override |
| `REDIS_URL` | unset (in-memory) | LLM cache (24 h) and circuit state shared by all workers |
| `EXTRACT_BATCH_SIZE` / `EXTRACT_CONCURRENCY` | `6` / `3` | Emails per LLM call, and parallel calls per sync |
| `LLM_TIMEOUT_S` | `25` | Per-call timeout (Ollama defaults to 120 s) |
| `MAX_BODY_CHARS` | `4000` | Body length after cleaning |

When run outside Docker, the app also reads the repo-root `.env`. It never overrides variables that are already set.

The Docker image (Phase 6) uses Python 3.12. The code also runs on 3.10 or later.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/health` | none | liveness |
| POST | `/v1/extract` | `X-Internal-Key` | `ExtractRequest` → `ExtractResponse` |
| POST | `/v1/ask` | `X-Internal-Key` | `AskRequest` → `AskResponse`. Answers only from the given tasks, and cites only their ids. |
| GET | `/v1/providers` | `X-Internal-Key` | Configured flag, circuit state, cooldown and usage per provider |
| GET | `/docs` | none | OpenAPI UI |

All of these are defined in `packages/contracts/extract.schema.json`.

## LLM router (ADR 0003)

Adapters: `OpenAICompatibleProvider` (Groq, Cerebras, OpenRouter, Mistral, GitHub Models, HF, OpenAI), `GeminiProvider`, `OllamaProvider` and `HeuristicProvider`.

| Event | What the router does |
|---|---|
| 429 / quota | Cools the provider down for `Retry-After` (default 60 s; Gemini's `retryDelay` is honoured), then tries the next one |
| 401 / 403 | Cools down for 10 min |
| 3 consecutive 5xx / timeouts | Cools down for 30 s |
| Invalid JSON or schema | Makes one repair retry with the validation error (input values are never echoed), then moves on |

Responses are cached for 24 h, keyed by `sha256(provider, model, system, user)`. The prompt carries today's *date*, not a timestamp, so a same-day re-sync costs no quota. The heuristic is never cached or cooled down.

The trace shows the chain, e.g. `gemini rate-limited → groq`. `provider_usage` reports calls, failures, cache hits and latency per provider.

## Evals

```bash
.venv/Scripts/python -m evals.run_evals --verbose     # or `make eval` from the repo root
```

See [docs/EVALS.md](../../docs/EVALS.md).

Errors are RFC 7807 `application/problem+json` with a `traceId`. `x-request-id` is echoed back, or generated if absent or unsafe. Validation errors never echo request bodies.

## Quality gate

```bash
.venv/Scripts/ruff check app tests evals && .venv/Scripts/ruff format --check app tests evals
.venv/Scripts/mypy                       # strict (app + evals)
.venv/Scripts/python -m pytest --cov     # fails under 80% coverage
```

Tests never call a real LLM. An autouse fixture strips every provider key from the environment, HTTP is mocked with `respx`, and the providers are stubs or the heuristic.

## Layout

```
app/
  main.py            FastAPI app factory, auth, problem+json, request ids
  schemas.py         Pydantic mirror of the contract (tests/test_contract.py keeps them in sync)
  config.py
  ask.py             /v1/ask: deterministic filter + optional LLM phrasing
  llm/base.py        LLMProvider protocol, error types, HTTP/JSON helpers
  llm/{openai_compat,gemini,ollama,heuristic}.py   adapters
  llm/router.py      failover, circuit breaker, repair retry, cache, usage
  llm/registry.py    builds providers from env
  llm/store.py       Redis / in-memory KV for cache and circuit state
  llm/prompts.py     extraction (3 few-shots), briefing and ask prompts; untrusted text is delimited and de-tagged
  pipeline/          preprocess, triage, extract, grounding, temporal, prioritize, dedupe, planner, orchestrator
```
