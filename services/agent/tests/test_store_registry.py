from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from app.config import load_env_file
from app.llm.gemini import GeminiProvider
from app.llm.heuristic import HeuristicProvider
from app.llm.ollama import OllamaProvider
from app.llm.openai_compat import OpenAICompatibleProvider
from app.llm.registry import build_providers, provider_order
from app.llm.store import InMemoryStore, RedisStore, store_from_url


def run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------- store


def test_in_memory_store_ttl_and_incr() -> None:
    now = [0.0]
    s = InMemoryStore(lambda: now[0])
    run(s.set("k", "v", 10))
    assert run(s.get("k")) == "v" and run(s.ttl("k")) == 10
    assert run(s.incr("n", 5)) == 1 and run(s.incr("n", 5)) == 2
    now[0] = 6
    assert run(s.incr("n", 5)) == 1  # window expired
    now[0] = 11
    assert run(s.get("k")) is None and run(s.ttl("k")) is None
    run(s.delete("n"))
    assert run(s.get("n")) is None


class _BrokenRedis:
    async def _boom(self, *a: Any, **k: Any) -> Any:
        raise ConnectionError("redis down")

    get = set = incr = pexpire = delete = pttl = _boom


class _FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.expiry: dict[str, int] = {}

    async def get(self, k: str) -> str | None:
        return self.data.get(k)

    async def set(self, k: str, v: str, px: int) -> None:
        self.data[k], self.expiry[k] = v, px

    async def incr(self, k: str) -> int:
        self.data[k] = str(int(self.data.get(k, "0")) + 1)
        return int(self.data[k])

    async def pexpire(self, k: str, ms: int) -> None:
        self.expiry[k] = ms

    async def delete(self, k: str) -> None:
        self.data.pop(k, None)

    async def pttl(self, k: str) -> int:
        return self.expiry.get(k, -2) if k in self.data else -2


def test_redis_store_maps_operations() -> None:
    fake = _FakeRedis()
    s = RedisStore(fake)
    run(s.set("k", "v", 1.5))
    assert run(s.get("k")) == "v" and fake.expiry["k"] == 1500
    assert run(s.incr("n", 30)) == 1 and fake.expiry["n"] == 30_000
    assert run(s.incr("n", 30)) == 2
    assert run(s.ttl("k")) == 1.5
    run(s.delete("k"))
    assert run(s.get("k")) is None and run(s.ttl("k")) is None


def test_redis_outage_degrades_instead_of_raising() -> None:
    s = RedisStore(_BrokenRedis())
    assert run(s.get("k")) is None
    run(s.set("k", "v", 1))
    assert run(s.incr("k", 1)) == 1
    run(s.delete("k"))
    assert run(s.ttl("k")) is None


def test_store_from_url() -> None:
    assert isinstance(store_from_url(None), InMemoryStore)
    assert isinstance(store_from_url("redis://localhost:6399/0"), RedisStore)


# ---------------------------------------------------------------- registry


def test_default_order_has_heuristic_last() -> None:
    assert provider_order({}) == [
        "gemini",
        "groq",
        "openrouter",
        "github",
        "cerebras",
        "mistral",
        "ollama",
        "heuristic",
    ]
    assert provider_order({"LLM_PROVIDERS": "heuristic, Groq,groq,,gemini"}) == [
        "groq",
        "gemini",
        "heuristic",
    ]


def test_no_keys_means_only_heuristic_is_configured() -> None:
    providers = build_providers({})
    assert [p.name for p in providers if p.is_configured()] == ["heuristic"]
    assert isinstance(providers[-1], HeuristicProvider)


def test_keys_models_and_base_urls_come_from_env() -> None:
    env = {
        "LLM_PROVIDERS": "gemini,groq,openrouter,ollama,anthropic,openai,bogus",
        "GEMINI_API_KEY": "g",
        "GEMINI_MODEL": "gemini-2.0-flash",
        "GROQ_API_KEY": "q",
        "OPENROUTER_API_KEY": "o",
        "OLLAMA_BASE_URL": "http://ollama:11434",
        "OLLAMA_MODEL": "qwen2.5:7b",
        "OPENAI_API_KEY": "x",
        "OPENAI_BASE_URL": "http://proxy/v1",
    }
    by_name = {p.name: p for p in build_providers(env)}
    assert list(by_name) == [
        "gemini",
        "groq",
        "openrouter",
        "ollama",
        "anthropic",
        "openai",
        "heuristic",
    ]  # unknown names are skipped: "bogus"
    gemini = by_name["gemini"]
    assert isinstance(gemini, GeminiProvider) and gemini.model == "gemini-2.0-flash"
    groq = by_name["groq"]
    assert isinstance(groq, OpenAICompatibleProvider) and groq.model == "openai/gpt-oss-120b"
    openrouter = by_name["openrouter"]
    assert isinstance(openrouter, OpenAICompatibleProvider) and not openrouter.json_mode
    ollama = by_name["ollama"]
    assert isinstance(ollama, OllamaProvider) and ollama.model == "qwen2.5:7b"
    openai = by_name["openai"]
    assert isinstance(openai, OpenAICompatibleProvider) and openai.base_url == "http://proxy/v1"
    assert "anthropic" in by_name


# ---------------------------------------------------------------- .env loader


def test_load_env_file_never_overrides(tmp_path: Path) -> None:
    f = tmp_path / ".env"
    f.write_text("# comment\nA=1\nexport B='two'\nC=\"3\"\nbroken line\nA=override\n", "utf-8")
    env = {"C": "kept"}
    assert load_env_file(f, env) == 2
    assert env == {"A": "1", "B": "two", "C": "kept"}
    assert load_env_file(tmp_path / "missing.env", env) == 0


def test_load_env_file_ignores_inline_comments(tmp_path: Path) -> None:
    """Regression: `KEY=   # https://where-to-get-a-key` loaded the URL as the key."""
    f = tmp_path / ".env"
    f.write_text(
        "GEMINI_API_KEY=   # https://aistudio.google.com/apikey\n"
        "GROQ_API_KEY=gsk_real_key   # trailing note\n"
        "QUOTED='has # inside'  # note\n"
        'DQ="also # inside"\n'
        "URL=http://host/a#frag\n",
        "utf-8",
    )
    env: dict[str, str] = {}
    load_env_file(f, env)
    assert env == {
        "GEMINI_API_KEY": "",  # empty, so the provider stays "not configured"
        "GROQ_API_KEY": "gsk_real_key",
        "QUOTED": "has # inside",
        "DQ": "also # inside",
        "URL": "http://host/a#frag",  # no space before '#': part of the value
    }


def test_repo_env_file_is_optional_for_shallow_container_paths(monkeypatch: Any) -> None:
    """Regression: in the container the app lives at /app/app/main.py (fewer parents)."""
    import app.main as main

    assert main.repo_env_file() is not None  # running from source
    monkeypatch.setattr(main, "__file__", "/app/app/main.py")
    assert main.repo_env_file() is None
