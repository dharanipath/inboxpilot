"""LLMRouter: try providers in order; fail over on quota, errors, timeouts and bad JSON (ADR 0003).

| Event                   | Behaviour                                                        |
|-------------------------|------------------------------------------------------------------|
| 429 / quota             | open circuit for Retry-After (default 60 s), try next now        |
| 401 / 403               | open circuit for 10 min, try next                                |
| 5xx / timeout / network | count failure; 3 in a row opens the circuit for 30 s             |
| invalid JSON / schema   | one repair retry with the error, then next provider              |
| success                 | reset failure count; cache response for 24 h                     |

Users can bring their own API keys (ADR 0006). `with_keys()` returns a view of the router whose
providers use those keys. Circuits are tracked per key (a fingerprint, never the key itself), so
one user's exhausted free quota never blocks another user or the server's own key.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypeVar

from pydantic import ValidationError

from app.llm.base import (
    AllProvidersFailed,
    AuthError,
    InvalidOutput,
    LLMProvider,
    OutOfCredit,
    ProviderError,
    ProviderTimeout,
    RateLimited,
)
from app.llm.store import InMemoryStore, KVStore

T = TypeVar("T")
Outcome = Literal[
    "ok", "cached", "rate_limited", "auth", "timeout", "error", "invalid", "cooling_down"
]
FAILED_OUTCOMES = frozenset({"rate_limited", "auth", "timeout", "error", "invalid"})

_LABELS: dict[str, str] = {
    "rate_limited": "rate-limited",
    "auth": "auth failed",
    "timeout": "timed out",
    "error": "errored",
    "invalid": "returned invalid JSON",
    "cooling_down": "cooling down",
}


@dataclass
class Attempt:
    provider: str
    model: str
    outcome: Outcome
    calls: int = 0
    latency_ms: int = 0
    error: str | None = None


@dataclass
class RouterResult(Generic[T]):
    value: T
    provider: str
    model: str
    attempts: list[Attempt]
    cached: bool = False

    @property
    def tag(self) -> str:
        return f"{self.provider}/{self.model}"

    @property
    def degraded(self) -> bool:
        return any(
            a.outcome in FAILED_OUTCOMES or a.outcome == "cooling_down" for a in self.attempts
        )

    def chain(self) -> str:
        """e.g. 'gemini rate-limited → groq'."""
        steps = [
            f"{a.provider} {_LABELS[a.outcome]}"
            for a in self.attempts
            if a.outcome not in ("ok", "cached")
        ]
        return " → ".join([*steps, self.provider + (" (cached)" if self.cached else "")])


@dataclass
class ProviderStats:
    calls: int = 0
    failures: int = 0
    cache_hits: int = 0
    latency_ms: int = 0
    last_error: str | None = None


@dataclass
class _Ctx:
    attempts: list[Attempt] = field(default_factory=list)


ProbeOutcome = Literal["ok", "rate_limited", "auth", "timeout", "error", "invalid"]


@dataclass
class ProbeResult:
    outcome: ProbeOutcome
    model: str
    retry_after_s: int | None = None
    message: str | None = None


# builds a provider that uses the given API key (None if the name takes no key)
ProviderFactory = Callable[[str, str], LLMProvider | None]

_PROBE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}},
    "required": ["ok"],
}


def key_fingerprint(api_key: str) -> str:
    """Stable, non-reversible id for a key: circuits are per key without storing the key."""
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


class LLMRouter:
    def __init__(
        self,
        providers: Sequence[LLMProvider],
        store: KVStore | None = None,
        *,
        timeout_s: float = 25,
        timeout_grace_s: float = 5,
        rate_limit_cooldown_s: float = 60,
        failure_threshold: int = 3,
        failure_cooldown_s: float = 30,
        failure_window_s: float = 300,
        auth_cooldown_s: float = 600,
        cache_ttl_s: float = 86_400,
        factory: ProviderFactory | None = None,
    ) -> None:
        self.providers = list(providers)
        self.factory = factory
        self.store = store or InMemoryStore()
        self.timeout_s = timeout_s
        self.timeout_grace_s = timeout_grace_s  # hard stop if a provider ignores its timeout
        self.rate_limit_cooldown_s = rate_limit_cooldown_s
        self.failure_threshold = failure_threshold
        self.failure_cooldown_s = failure_cooldown_s
        self.failure_window_s = failure_window_s
        self.auth_cooldown_s = auth_cooldown_s
        self.cache_ttl_s = cache_ttl_s
        self.stats: dict[str, ProviderStats] = {p.name: ProviderStats() for p in self.providers}

    # ------------------------------------------------------------ selection

    def ordered(
        self, order: Sequence[str] | None = None, exclude: Collection[str] = ()
    ) -> list[LLMProvider]:
        providers = self.providers
        if order:
            by_name = {p.name: p for p in providers}
            providers = [by_name[n] for n in order if n in by_name]
        return [p for p in providers if p.name not in exclude and p.is_configured()]

    def has_llm(self, order: Sequence[str] | None = None) -> bool:
        """Would a real LLM be tried for this selection? False for "rules only"."""
        return any(not _always_on(p) for p in self.ordered(order))

    def with_keys(self, keys: Mapping[str, str] | None) -> LLMRouter:
        """A view of this router whose providers use the caller's own API keys where given.

        Shares the store (cache, circuits) and settings. Only providers already in the router's
        order can be keyed; unknown names are ignored.
        """
        if not keys or self.factory is None:
            return self
        view = copy.copy(self)
        swapped: list[LLMProvider] = []
        for p in self.providers:
            key = keys.get(p.name)
            built = self.factory(p.name, key) if key else None
            if built is not None and key:
                setattr(built, "key_id", key_fingerprint(key))  # noqa: B010 (not on the Protocol)
            swapped.append(built or p)
        view.providers = swapped
        # fresh stats for keyed providers: error text from one user's key is never shown in
        # another user's (or the server's) provider status
        view.stats = {
            p.name: (
                ProviderStats()
                if _key_id(p) != "server"
                else self.stats.setdefault(p.name, ProviderStats())
            )
            for p in swapped
        }
        return view

    async def probe(self, name: str, api_key: str) -> ProbeResult:
        """One tiny call to check a key before it is saved. Updates that key's circuit."""
        p = self.factory(name, api_key) if self.factory else None
        if p is None:
            return ProbeResult("error", "", message=f"{name} does not take an API key")
        setattr(p, "key_id", key_fingerprint(api_key))  # noqa: B010 (not on the Protocol)
        try:
            await asyncio.wait_for(
                p.complete_json(
                    "You check that an API key works. Reply with JSON only.",
                    'Reply with exactly {"ok": true}',
                    _PROBE_SCHEMA,
                    timeout_s=15,
                ),
                15 + self.timeout_grace_s,
            )
        except RateLimited as exc:
            wait = exc.retry_after_s or self.rate_limit_cooldown_s
            await self.store.set(_cb_key(p), "rate_limited", wait)
            return ProbeResult("rate_limited", p.model, int(wait), _short(exc))
        except AuthError as exc:
            await self.store.set(_cb_key(p), "auth", self.auth_cooldown_s)
            return ProbeResult("auth", p.model, message=_short(exc))
        except OutOfCredit as exc:
            await self.store.set(_cb_key(p), "no_credit", self.auth_cooldown_s)
            return ProbeResult("error", p.model, message=_short(exc))
        except InvalidOutput as exc:  # it answered, so the key works; the reply was just odd
            await self.store.delete(_cb_key(p))
            return ProbeResult("invalid", p.model, message=_short(exc))
        except (ProviderTimeout, asyncio.TimeoutError) as exc:
            return ProbeResult("timeout", p.model, message=_short(exc) or "timed out")
        except ProviderError as exc:
            return ProbeResult("error", p.model, message=_short(exc))
        await self.store.delete(_cb_key(p))
        await self.store.delete(_fail_key(p))
        return ProbeResult("ok", p.model)

    # ------------------------------------------------------------ main entry

    async def complete(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        validate: Callable[[dict[str, Any]], T],
        order: Sequence[str] | None = None,
        exclude: Collection[str] = (),
    ) -> RouterResult[T]:
        ctx = _Ctx()
        for p in self.ordered(order, exclude):
            stats = self.stats.setdefault(p.name, ProviderStats())
            if not _always_on(p) and await self.store.get(_cb_key(p)) is not None:
                ctx.attempts.append(Attempt(p.name, p.model, "cooling_down"))
                continue

            cache_key = None if _always_on(p) else _cache_key(p, system, user)
            if cache_key and (hit := await self.store.get(cache_key)) is not None:
                try:
                    value = validate(json.loads(hit))
                except (ValueError, TypeError):
                    await self.store.delete(cache_key)
                else:
                    stats.cache_hits += 1
                    ctx.attempts.append(Attempt(p.name, p.model, "cached"))
                    return RouterResult(value, p.name, p.model, ctx.attempts, cached=True)

            result = await self._try(p, stats, ctx, system, user, schema, validate)
            if result is not None:
                raw, value = result
                if cache_key:
                    await self.store.set(cache_key, json.dumps(raw), self.cache_ttl_s)
                return RouterResult(value, p.name, p.model, ctx.attempts)

        tried = "; ".join(f"{a.provider}: {a.error or a.outcome}" for a in ctx.attempts) or "none"
        raise AllProvidersFailed(f"all providers failed ({tried})", ctx.attempts)

    async def _try(
        self,
        p: LLMProvider,
        stats: ProviderStats,
        ctx: _Ctx,
        system: str,
        user: str,
        schema: dict[str, Any],
        validate: Callable[[dict[str, Any]], T],
    ) -> tuple[dict[str, Any], T] | None:
        attempt = Attempt(p.name, p.model, "ok")
        ctx.attempts.append(attempt)
        timeout = getattr(p, "timeout_s", None) or self.timeout_s
        prompt = user
        started = time.perf_counter()
        try:
            for repair in (False, True):
                attempt.calls += 1
                stats.calls += 1
                try:
                    raw = await asyncio.wait_for(
                        p.complete_json(system, prompt, schema, timeout_s=timeout),
                        timeout + self.timeout_grace_s,
                    )
                    value = validate(raw)
                except (InvalidOutput, ValueError, TypeError) as exc:
                    if repair:
                        raise InvalidOutput(_short(exc)) from None
                    prompt = (
                        f"{user}\n\nYour previous reply was invalid: {_short(exc)}\n"
                        "Reply again with ONLY the JSON object."
                    )
                    continue
                await self.store.delete(_fail_key(p))
                return raw, value
        except RateLimited as exc:
            await self._fail(p, stats, attempt, "rate_limited", exc)
            await self.store.set(
                _cb_key(p), "rate_limited", exc.retry_after_s or self.rate_limit_cooldown_s
            )
        except AuthError as exc:
            await self._fail(p, stats, attempt, "auth", exc)
            await self.store.set(_cb_key(p), "auth", self.auth_cooldown_s)
        except OutOfCredit as exc:
            # a paid account with no credit: stop asking for a while, and say why in the status
            await self._fail(p, stats, attempt, "error", exc)
            await self.store.set(_cb_key(p), "no_credit", self.auth_cooldown_s)
        except InvalidOutput as exc:
            await self._fail(p, stats, attempt, "invalid", exc)
        except (ProviderTimeout, asyncio.TimeoutError) as exc:
            await self._fail(p, stats, attempt, "timeout", exc)
            await self._count_failure(p)
        except ProviderError as exc:
            await self._fail(p, stats, attempt, "error", exc)
            await self._count_failure(p)
        finally:
            attempt.latency_ms = int((time.perf_counter() - started) * 1000)
            stats.latency_ms += attempt.latency_ms
        return None

    async def _fail(
        self,
        p: LLMProvider,
        stats: ProviderStats,
        attempt: Attempt,
        outcome: Outcome,
        exc: BaseException,
    ) -> None:
        attempt.outcome = outcome
        attempt.error = _short(exc) or outcome
        stats.failures += 1
        stats.last_error = attempt.error

    async def _count_failure(self, p: LLMProvider) -> None:
        if await self.store.incr(_fail_key(p), self.failure_window_s) >= self.failure_threshold:
            await self.store.set(_cb_key(p), "failures", self.failure_cooldown_s)
            await self.store.delete(_fail_key(p))

    # ------------------------------------------------------------ status

    async def status(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for p in self.providers:
            s = self.stats.get(p.name, ProviderStats())
            cooldown = None if _always_on(p) else await self.store.ttl(_cb_key(p))
            reason = None if cooldown is None else await self.store.get(_cb_key(p))
            configured = p.is_configured()
            key_source = (
                "none"
                if not configured or _always_on(p)
                else ("server" if _key_id(p) == "server" else "user")
            )
            out.append(
                {
                    "name": p.name,
                    "model": p.model,
                    "configured": configured,
                    "key_source": key_source,
                    "available": configured and cooldown is None,
                    "circuit": "open" if cooldown is not None else "closed",
                    "circuit_reason": reason if reason in _REASONS else None,
                    "cooldown_s": int(cooldown or 0),
                    "calls": s.calls,
                    "failures": s.failures,
                    "cache_hits": s.cache_hits,
                    "avg_latency_ms": s.latency_ms // s.calls if s.calls else 0,
                    "last_error": s.last_error,
                }
            )
        return out


def _always_on(p: LLMProvider) -> bool:
    return bool(getattr(p, "always_available", False))


_REASONS = frozenset({"rate_limited", "auth", "no_credit", "failures"})


def _key_id(p: LLMProvider) -> str:
    return str(getattr(p, "key_id", "server"))


def _cb_key(p: LLMProvider) -> str:
    kid = _key_id(p)
    return f"cb:{p.name}" if kid == "server" else f"cb:{p.name}:{kid}"


def _fail_key(p: LLMProvider) -> str:
    kid = _key_id(p)
    return f"cbfail:{p.name}" if kid == "server" else f"cbfail:{p.name}:{kid}"


def _cache_key(p: LLMProvider, system: str, user: str) -> str:
    digest = hashlib.sha256(f"{p.name}\0{p.model}\0{system}\0{user}".encode()).hexdigest()
    return f"llm:{digest}"


def _short(exc: BaseException) -> str:
    if isinstance(exc, ValidationError):  # never echo input values (email text) into logs/traces
        text = "; ".join(
            f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors(include_input=False)
        )
    else:
        text = str(exc)
    return text.replace("\n", " ")[:300]
