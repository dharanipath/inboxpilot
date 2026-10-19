"""Pydantic models mirroring packages/contracts/extract.schema.json (v1).

tests/test_contract.py keeps these in sync with the JSON Schema.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, SecretStr

TaskType = Literal[
    "deadline", "meeting", "payment", "review", "reply", "send", "call", "follow_up", "other"
]
Priority = Literal["P0", "P1", "P2", "P3"]
Bucket = Literal["overdue", "today", "week", "later", "undated", "needs_review"]
DateSource = Literal["resolver", "llm", "none", "user"]  # "user": edited in the UI
SkipReason = Literal[
    "promotion", "social", "newsletter", "automated", "no_action_items", "empty", "duplicate"
]
StepName = Literal["preprocess", "triage", "extract", "ground", "dates", "priority", "plan"]
StepStatus = Literal["ok", "degraded", "skipped", "failed"]
# providers that take an API key (a user may bring their own: ADR 0006)
KeyedProvider = Literal[
    "anthropic", "gemini", "groq", "cerebras", "openrouter", "mistral", "github", "openai"
]
ApiKey = Annotated[SecretStr, Field(min_length=8, max_length=512)]
ProbeOutcome = Literal["ok", "rate_limited", "auth", "timeout", "error", "invalid"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------- request ----------


class UserContext(_Strict):
    email: str
    name: str | None = None
    timezone: str = Field(min_length=1)
    now: AwareDatetime
    vip_senders: list[str] = Field(default_factory=list)


class EmailInput(_Strict):
    id: str = Field(min_length=1)
    thread_id: str = Field(min_length=1)
    from_name: str | None = None
    from_email: str
    to: list[str] = Field(default_factory=list)
    cc: list[str] = Field(default_factory=list)
    subject: str
    body_text: str = Field(max_length=200_000)
    received_at: AwareDatetime
    labels: list[str] = Field(default_factory=list)
    list_unsubscribe: bool = False


class ExtractOptions(_Strict):
    horizon_days: int = Field(default=7, ge=1, le=30)
    use_llm_briefing: bool = True
    providers: list[str] | None = None
    # the user's own API keys; SecretStr keeps them out of reprs, logs and error messages
    provider_keys: dict[KeyedProvider, ApiKey] | None = None


def plain_keys(options: ExtractOptions | None) -> dict[str, str]:
    if options is None or not options.provider_keys:
        return {}
    return {name: key.get_secret_value() for name, key in options.provider_keys.items()}


class ExtractRequest(_Strict):
    user: UserContext
    emails: list[EmailInput] = Field(min_length=1, max_length=200)
    options: ExtractOptions = Field(default_factory=ExtractOptions)


# ---------- response ----------


class TaskSource(_Strict):
    from_name: str | None = None
    from_email: str
    subject: str
    received_at: AwareDatetime
    thread_id: str


class Task(_Strict):
    id: str
    email_id: str
    title: str = Field(min_length=1, max_length=80)
    details: str | None = None
    type: TaskType
    due_phrase: str | None
    due_date: date | None
    due_at: AwareDatetime | None
    has_time: bool
    date_source: DateSource
    priority: Priority
    priority_score: int = Field(ge=0, le=100)
    priority_base: int | None = Field(default=None, ge=0, le=100)
    priority_reasons: list[str]
    confidence: float = Field(ge=0, le=1)
    evidence: str = Field(min_length=1)
    bucket: Bucket
    source: TaskSource
    extracted_by: str


class SkippedEmail(_Strict):
    email_id: str
    reason: SkipReason


class TraceStep(_Strict):
    step: StepName
    agent: str
    status: StepStatus
    duration_ms: int = Field(ge=0)
    detail: str | None = None
    counts: dict[str, int] | None = None


class ProviderUsage(_Strict):
    provider: str
    model: str
    calls: int = Field(default=0, ge=0)
    failures: int = Field(default=0, ge=0)
    latency_ms: int = Field(default=0, ge=0)
    cache_hits: int = Field(default=0, ge=0)
    last_error: str | None = None


class BucketCounts(_Strict):
    overdue: int = 0
    today: int = 0
    week: int = 0
    later: int = 0
    undated: int = 0
    needs_review: int = 0


class Briefing(_Strict):
    headline: str
    summary: str
    generated_by: str
    counts: BucketCounts


class ExtractResponse(_Strict):
    run_id: str
    tasks: list[Task]
    skipped: list[SkippedEmail]
    trace: list[TraceStep]
    provider_usage: list[ProviderUsage]
    briefing: Briefing


# ---------- raw LLM output (agent-internal) ----------


class LlmExtractionItem(_Strict):
    email_id: str
    title: str = Field(min_length=1, max_length=80)
    type: TaskType
    due_phrase: str | None = None
    due_iso_guess: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
    confidence: float = Field(ge=0, le=1)
    evidence: str = Field(min_length=1)


class LlmExtraction(_Strict):
    items: list[LlmExtractionItem]


# ---------- /v1/ask ----------


class AskRequest(_Strict):
    user: UserContext
    question: str = Field(min_length=1, max_length=500)
    tasks: list[Task] = Field(max_length=500)
    options: ExtractOptions = Field(default_factory=ExtractOptions)


class AskResponse(_Strict):
    answer: str
    cited_task_ids: list[str]
    generated_by: str


# ---------- /v1/providers ----------


class ProviderStatus(_Strict):
    name: str
    model: str
    configured: bool
    key_source: Literal["server", "user", "none"]
    available: bool
    circuit: Literal["closed", "open"]
    circuit_reason: Literal["rate_limited", "auth", "no_credit", "failures"] | None = None
    cooldown_s: int = Field(ge=0)
    calls: int = Field(ge=0)
    failures: int = Field(ge=0)
    cache_hits: int = Field(ge=0)
    avg_latency_ms: int = Field(ge=0)
    last_error: str | None = None


class ProvidersResponse(_Strict):
    providers: list[ProviderStatus]


class ProvidersRequest(_Strict):
    """Provider status as seen by one user (their own keys and per-key cooldowns)."""

    provider_keys: dict[KeyedProvider, ApiKey] | None = None


class ProviderTestRequest(_Strict):
    name: KeyedProvider
    api_key: ApiKey


class ProviderTestResponse(_Strict):
    name: KeyedProvider
    model: str
    outcome: ProbeOutcome
    retry_after_s: int | None = Field(default=None, ge=0)
    message: str | None = None


# ---------- /v1/briefing ----------


class BriefingRequest(_Strict):
    user: UserContext
    tasks: list[Task] = Field(max_length=500)
    options: ExtractOptions = Field(default_factory=ExtractOptions)
