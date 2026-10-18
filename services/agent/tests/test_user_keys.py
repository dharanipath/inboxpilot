"""Users bring their own API keys (ADR 0006): per-request keys, per-key circuits, key probes.

Every provider call is mocked with respx; no real LLM is ever called.
"""

from __future__ import annotations

import asyncio
import functools
import json
from collections.abc import Callable, Coroutine
from typing import Any

import httpx
import jsonschema
import pytest
import respx
from fastapi.testclient import TestClient

from app.config import Settings
from app.llm.registry import build_providers, provider_factory
from app.llm.router import LLMRouter, key_fingerprint
from app.llm.store import InMemoryStore
from app.main import create_app
from app.schemas import ExtractOptions
from tests.conftest import INTERNAL_KEY, load_contract

AUTH = {"X-Internal-Key": INTERNAL_KEY}
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
ALICE = "gsk_alice_0123456789"
BOB = "gsk_bob_9876543210"

ITEM = {
    "email_id": "m1",
    "title": "Send the deck to Priya",
    "type": "send",
    "due_phrase": "before the call on Tuesday",
    "due_iso_guess": "2026-10-20",
    "confidence": 0.9,
    "evidence": "Can you send the deck before the call on Tuesday?",
}


def run_async(fn: Callable[..., Coroutine[Any, Any, None]]) -> Callable[..., None]:
    """Run an async test body with asyncio.run (the suite has no async test plugin)."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> None:
        asyncio.run(fn(*args, **kwargs))

    return wrapper


def _reply(content: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})


def _validator(name: str) -> jsonschema.Draft202012Validator:
    return jsonschema.Draft202012Validator({**load_contract(), "$ref": f"#/$defs/{name}"})


def _router(env: dict[str, str]) -> LLMRouter:
    return LLMRouter(build_providers(env), InMemoryStore(), factory=provider_factory(env))


@pytest.fixture
def no_server_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """The server has no keys of its own: only users' keys can enable a model."""
    monkeypatch.setenv("LLM_PROVIDERS", "gemini,groq,heuristic")
    for var in ("GEMINI_API_KEY", "GROQ_API_KEY"):
        monkeypatch.delenv(var, raising=False)


def _bearer(request: httpx.Request) -> str:
    return request.headers["authorization"].removeprefix("Bearer ")


@run_async
@respx.mock
async def test_with_keys_uses_the_users_key_and_leaves_the_base_router_alone() -> None:
    groq = respx.post(GROQ_URL).mock(return_value=_reply({"items": []}))
    base = _router({"LLM_PROVIDERS": "groq,heuristic"})
    assert not base.has_llm()  # no server key

    mine = base.with_keys({"groq": ALICE})
    assert mine.has_llm()
    result = await mine.complete(system="s", user="u", schema={}, validate=lambda raw: raw)
    assert result.provider == "groq"
    assert _bearer(groq.calls.last.request) == ALICE
    assert not base.has_llm()  # the shared router never sees the key


@run_async
@respx.mock
async def test_one_users_exhausted_quota_never_blocks_another_user() -> None:
    def by_key(request: httpx.Request) -> httpx.Response:
        if _bearer(request) == ALICE:
            return httpx.Response(429, headers={"retry-after": "42"})
        return _reply({"items": []})

    respx.post(GROQ_URL).mock(side_effect=by_key)
    base = _router({"LLM_PROVIDERS": "groq,heuristic"})

    alice = base.with_keys({"groq": ALICE})
    first = await alice.complete(system="s", user="a", schema={}, validate=lambda raw: raw)
    assert first.provider == "heuristic"  # Alice's free quota ran out: rules took over
    assert first.chain() == "groq rate-limited → heuristic"

    status = {s["name"]: s for s in await alice.status()}
    assert status["groq"]["key_source"] == "user"
    assert status["groq"]["circuit"] == "open"
    assert status["groq"]["circuit_reason"] == "rate_limited"
    assert 0 < status["groq"]["cooldown_s"] <= 42

    bob = base.with_keys({"groq": BOB})
    second = await bob.complete(system="s", user="b", schema={}, validate=lambda raw: raw)
    assert second.provider == "groq"  # Bob's key has its own circuit
    assert {s["name"]: s for s in await bob.status()}["groq"]["circuit"] == "closed"


@run_async
@respx.mock
@pytest.mark.parametrize(
    ("response", "outcome", "retry"),
    [
        (_reply({"ok": True}), "ok", None),
        (httpx.Response(429, headers={"retry-after": "42"}), "rate_limited", 42),
        (httpx.Response(401), "auth", None),
        (httpx.Response(500), "error", None),
        (httpx.Response(200, json={"choices": []}), "invalid", None),
    ],
)
async def test_probe_reports_what_happened_to_the_key(
    response: httpx.Response, outcome: str, retry: int | None
) -> None:
    respx.post(GROQ_URL).mock(return_value=response)
    router = _router({"LLM_PROVIDERS": "groq,heuristic"})
    result = await router.probe("groq", ALICE)
    assert result.outcome == outcome
    assert result.retry_after_s == retry
    assert result.model == "llama-3.3-70b-versatile"
    assert ALICE not in (result.message or "")
    cooled = await router.store.ttl(f"cb:groq:{key_fingerprint(ALICE)}")
    assert (cooled is not None) == (outcome in ("rate_limited", "auth"))


@run_async
async def test_probe_refuses_providers_without_keys() -> None:
    result = await _router({"LLM_PROVIDERS": "heuristic"}).probe("ollama", ALICE)
    assert result.outcome == "error"


def test_keys_never_appear_in_reprs_or_dumps() -> None:
    opts = ExtractOptions.model_validate({"provider_keys": {"groq": ALICE}})
    assert ALICE not in repr(opts)
    assert ALICE not in opts.model_dump_json()


@respx.mock
def test_extract_with_a_users_key_end_to_end(
    inbox_request: dict[str, Any], no_server_keys: None
) -> None:
    def groq_reply(request: httpx.Request) -> httpx.Response:
        prompt = json.loads(request.content)["messages"][1]["content"]
        return _reply({"items": [ITEM] if 'id="m1"' in prompt else []})

    groq = respx.post(GROQ_URL).mock(side_effect=groq_reply)
    inbox_request["options"] = {"use_llm_briefing": False, "provider_keys": {"groq": ALICE}}
    assert list(_validator("ExtractRequest").iter_errors(inbox_request)) == []

    with TestClient(create_app(Settings(internal_api_key=INTERNAL_KEY))) as c:
        r = c.post("/v1/extract", json=inbox_request, headers=AUTH)
        server_view = {
            p["name"]: p for p in c.get("/v1/providers", headers=AUTH).json()["providers"]
        }

    assert r.status_code == 200, r.text
    body = r.json()
    assert ALICE not in r.text
    assert list(_validator("ExtractResponse").iter_errors(body)) == []
    (task,) = body["tasks"]
    assert task["extracted_by"] == "groq/llama-3.3-70b-versatile"
    assert all(_bearer(call.request) == ALICE for call in groq.calls)
    # the server itself still has no key for groq
    assert server_view["groq"]["configured"] is False


@respx.mock
def test_provider_endpoints_scope_status_to_the_user_and_test_keys(no_server_keys: None) -> None:
    respx.post(GROQ_URL).mock(return_value=httpx.Response(429, headers={"retry-after": "30"}))
    with TestClient(create_app(Settings(internal_api_key=INTERNAL_KEY))) as c:
        probe = c.post("/v1/providers/test", json={"name": "groq", "api_key": ALICE}, headers=AUTH)
        mine = c.post("/v1/providers", json={"provider_keys": {"groq": ALICE}}, headers=AUTH)
        theirs = c.post("/v1/providers", json={"provider_keys": {"groq": BOB}}, headers=AUTH)
        anon = c.post("/v1/providers", json={}, headers=AUTH)
        unauth = c.post("/v1/providers/test", json={"name": "groq", "api_key": ALICE})
        bad = c.post("/v1/providers/test", json={"name": "ollama", "api_key": ALICE}, headers=AUTH)

    assert probe.status_code == 200
    assert probe.json() == {
        "name": "groq",
        "model": "llama-3.3-70b-versatile",
        "outcome": "rate_limited",
        "retry_after_s": 30,
        "message": "groq: rate limited (429)",
    }
    assert list(_validator("ProviderTestResponse").iter_errors(probe.json())) == []
    for resp in (mine, theirs, anon):
        assert list(_validator("ProvidersResponse").iter_errors(resp.json())) == []
    groq_mine = next(p for p in mine.json()["providers"] if p["name"] == "groq")
    assert groq_mine["key_source"] == "user" and groq_mine["circuit_reason"] == "rate_limited"
    groq_theirs = next(p for p in theirs.json()["providers"] if p["name"] == "groq")
    assert groq_theirs["available"] is True  # another user's key is unaffected
    groq_anon = next(p for p in anon.json()["providers"] if p["name"] == "groq")
    assert groq_anon["key_source"] == "none" and groq_anon["configured"] is False
    assert unauth.status_code == 401
    assert bad.status_code == 422
    for resp in (probe, mine, theirs, bad):
        assert ALICE not in resp.text and BOB not in resp.text
