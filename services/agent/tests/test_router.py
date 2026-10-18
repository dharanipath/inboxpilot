"""LLMRouter behaviour with scripted stub providers and a fake clock."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import pytest

from app.llm.base import (
    AllProvidersFailed,
    AuthError,
    InvalidOutput,
    OutOfCredit,
    ProviderError,
    ProviderTimeout,
    RateLimited,
)
from app.llm.heuristic import HeuristicProvider
from app.llm.router import LLMRouter
from app.llm.store import InMemoryStore

OK = {"items": []}


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class Scripted:
    """Returns/raises each scripted outcome in turn (repeating the last one)."""

    def __init__(self, name: str, *script: Any, configured: bool = True, delay: float = 0) -> None:
        self.name, self.model = name, f"{name}-model"
        self.script = list(script) or [OK]
        self.configured = configured
        self.delay = delay
        self.calls: list[str] = []
        self.timeout_s: float | None = None

    def is_configured(self) -> bool:
        return self.configured

    async def complete_json(
        self, system: str, user: str, schema: dict[str, Any], timeout_s: float = 25
    ) -> dict[str, Any]:
        self.calls.append(user)
        if self.delay:
            await asyncio.sleep(self.delay)
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(step, BaseException):
            raise step
        return dict(step)


def make(*providers: Any, clock: Clock | None = None, **kw: Any) -> LLMRouter:
    return LLMRouter(list(providers), InMemoryStore(clock or Clock()), **kw)


def call(
    router: LLMRouter, user: str = "u", validate: Callable[[dict[str, Any]], Any] = dict, **kw: Any
) -> Any:
    return asyncio.run(router.complete(system="s", user=user, schema={}, validate=validate, **kw))


def items_only(raw: dict[str, Any]) -> dict[str, Any]:
    if "items" not in raw:
        raise ValueError("missing items")
    return raw


def test_first_healthy_provider_wins() -> None:
    a, b = Scripted("gemini"), Scripted("groq")
    res = call(make(a, b))
    assert (res.provider, res.degraded, len(b.calls)) == ("gemini", False, 0)
    assert res.chain() == "gemini"


def test_429_fails_over_and_cools_down_for_retry_after() -> None:
    clock = Clock()
    gemini = Scripted("gemini", RateLimited("429", retry_after_s=40), OK)
    groq = Scripted("groq")
    router = make(gemini, groq, clock=clock)

    res = call(router)
    assert res.provider == "groq" and res.degraded
    assert res.chain() == "gemini rate-limited → groq"
    assert [a.outcome for a in res.attempts] == ["rate_limited", "ok"]

    res = call(router, user="u2")  # still cooling down: gemini not even called
    assert res.provider == "groq" and len(gemini.calls) == 1
    assert res.attempts[0].outcome == "cooling_down"

    clock.t += 41
    assert call(router, user="u3").provider == "gemini"


def test_429_without_retry_after_uses_default_cooldown() -> None:
    clock = Clock()
    router = make(Scripted("gemini", RateLimited("429"), OK), Scripted("groq"), clock=clock)
    call(router)
    clock.t += 59
    assert call(router, user="u2").provider == "groq"
    clock.t += 2
    assert call(router, user="u3").provider == "gemini"


def test_three_consecutive_errors_open_circuit_for_30s() -> None:
    clock = Clock()
    flaky = Scripted(
        "gemini", ProviderError("500"), ProviderTimeout("slow"), ProviderError("502"), OK
    )
    groq = Scripted("groq")
    router = make(flaky, groq, clock=clock)
    for i in range(3):
        assert call(router, user=f"u{i}").provider == "groq"
    assert len(flaky.calls) == 3
    call(router, user="u4")
    assert len(flaky.calls) == 3  # circuit open
    clock.t += 31
    assert call(router, user="u5").provider == "gemini"


def test_success_resets_failure_count() -> None:
    p = Scripted("gemini", ProviderError("500"), ProviderError("500"), OK, ProviderError("500"), OK)
    router = make(p, Scripted("groq"))
    for i in range(5):
        call(router, user=f"u{i}")
    assert len(p.calls) == 5  # never reached 3 in a row


def test_auth_error_opens_circuit_for_10_minutes() -> None:
    clock = Clock()
    bad = Scripted("gemini", AuthError("401"), OK)
    router = make(bad, Scripted("groq"), clock=clock)
    call(router)
    clock.t += 599
    call(router, user="u2")
    assert len(bad.calls) == 1
    clock.t += 2
    assert call(router, user="u3").provider == "gemini"


def test_out_of_credit_is_remembered_and_explained_not_retried() -> None:
    """A paid account with no credit: stop asking, and report *why* (not "errored")."""
    clock = Clock()
    paid = Scripted("openrouter", OutOfCredit("openrouter: HTTP 402 NO_CREDIT"), OK)
    router = make(paid, Scripted("groq"), clock=clock)

    res = call(router)
    assert res.provider == "groq" and res.degraded
    status = {s["name"]: s for s in asyncio.run(router.status())}
    assert status["openrouter"]["available"] is False
    assert status["openrouter"]["circuit"] == "open"
    assert status["openrouter"]["circuit_reason"] == "no_credit"
    assert 590 < status["openrouter"]["cooldown_s"] <= 600

    clock.t += 300  # still no credit: not asked again, no matter how many requests arrive
    for n in range(3):
        call(router, user=f"again-{n}")
    assert len(paid.calls) == 1

    clock.t += 301  # after 10 minutes it is tried again (the user may have added credit)
    assert call(router, user="later").provider == "openrouter"


def test_probe_of_an_out_of_credit_key_reports_why() -> None:
    router = make(Scripted("openrouter", OutOfCredit("openrouter: HTTP 402 NO_CREDIT")))
    router.factory = lambda name, key: Scripted(name, OutOfCredit("openrouter: HTTP 402 NO_CREDIT"))
    result = asyncio.run(router.probe("openrouter", "sk-or-test-123456"))
    assert (result.outcome, result.message) == ("error", "openrouter: HTTP 402 NO_CREDIT")


def test_invalid_json_gets_one_repair_retry() -> None:
    p = Scripted("gemini", {"wrong": 1}, OK)
    res = call(make(p, Scripted("groq")), validate=items_only)
    assert res.provider == "gemini" and res.attempts[0].calls == 2
    assert "Your previous reply was invalid: missing items" in p.calls[1]


def test_invalid_twice_fails_over() -> None:
    p = Scripted("gemini", InvalidOutput("not json"), {"wrong": 1})
    groq = Scripted("groq")
    res = call(make(p, groq), validate=items_only)
    assert res.provider == "groq" and res.chain() == "gemini returned invalid JSON → groq"
    assert res.attempts[0].error == "missing items"


def test_slow_provider_times_out() -> None:
    slow = Scripted("gemini", OK, delay=1)
    router = make(slow, Scripted("groq"), timeout_s=0.01, timeout_grace_s=0.04)
    res = call(router)
    assert res.provider == "groq" and res.attempts[0].outcome == "timeout"


def test_no_keys_falls_back_to_heuristic() -> None:
    router = make(
        Scripted("gemini", configured=False),
        Scripted("groq", configured=False),
        HeuristicProvider(),
    )
    res = call(router)
    assert res.provider == "heuristic" and res.attempts[0].provider == "heuristic"
    assert not router.has_llm()


def test_all_failing_raises_with_attempts() -> None:
    router = make(Scripted("gemini", RateLimited("429")), Scripted("groq", ProviderError("500")))
    with pytest.raises(AllProvidersFailed) as err:
        call(router)
    assert [a.provider for a in err.value.attempts] == ["gemini", "groq"]
    assert "gemini: 429" in str(err.value)


def test_responses_are_cached_per_provider_and_prompt() -> None:
    p = Scripted("gemini")
    router = make(p)
    call(router)
    res = call(router)
    assert res.cached and len(p.calls) == 1
    assert res.chain() == "gemini (cached)"
    call(router, user="different prompt")
    assert len(p.calls) == 2
    assert router.stats["gemini"].cache_hits == 1


def test_corrupt_cache_entry_is_ignored() -> None:
    p = Scripted("gemini")
    router = make(p)
    call(router, validate=items_only)
    for key in list(router.store._data):  # type: ignore[attr-defined]
        router.store._data[key] = ('{"x": 1}', 10**9)  # type: ignore[attr-defined]
    assert not call(router, validate=items_only).cached


def test_heuristic_is_never_cached_or_circuit_broken() -> None:
    router = make(HeuristicProvider())
    call(router)
    assert not call(router).cached
    assert router.store._data == {}  # type: ignore[attr-defined]


def test_order_override_and_exclude() -> None:
    a, b = Scripted("gemini"), Scripted("groq")
    router = make(a, b)
    assert call(router, order=["groq", "gemini"]).provider == "groq"
    assert call(router, user="x", exclude=("gemini",)).provider == "groq"
    assert call(router, user="y", order=["nope", "gemini"]).provider == "gemini"


def test_status_reports_circuit_and_usage() -> None:
    clock = Clock()
    router = make(
        Scripted("gemini", RateLimited("429", 45)),
        Scripted("groq"),
        Scripted("mistral", configured=False),
        HeuristicProvider(),
        clock=clock,
    )
    call(router)
    status = {s["name"]: s for s in asyncio.run(router.status())}
    assert status["gemini"]["circuit"] == "open" and status["gemini"]["cooldown_s"] == 45
    assert status["gemini"]["available"] is False and status["gemini"]["failures"] == 1
    assert status["gemini"]["last_error"] == "429"
    assert status["groq"]["available"] and status["groq"]["calls"] == 1
    assert status["mistral"]["configured"] is False and status["mistral"]["available"] is False
    assert status["heuristic"]["circuit"] == "closed"


def test_validation_errors_do_not_leak_input_values() -> None:
    from app.schemas import LlmExtraction

    leaky = {
        "items": [
            {
                "email_id": "1",
                "title": "x",
                "type": "bogus",
                "confidence": 0.5,
                "evidence": "SECRET EMAIL TEXT",
            }
        ]
    }
    router = make(Scripted("gemini", leaky), Scripted("groq"))
    res = call(router, validate=LlmExtraction.model_validate)
    assert res.provider == "groq"
    assert "SECRET" not in (res.attempts[0].error or "")
    assert "items.0.type" in (res.attempts[0].error or "")
