"""Build the provider list from environment variables. No limits or keys are hard-coded."""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping

import httpx

from app.llm.anthropic import AnthropicProvider
from app.llm.base import LLMProvider
from app.llm.gemini import GeminiProvider
from app.llm.heuristic import HeuristicProvider
from app.llm.ollama import OllamaProvider
from app.llm.openai_compat import OpenAICompatibleProvider

log = logging.getLogger("inboxpilot.agent.registry")

DEFAULT_ORDER = "gemini,groq,openrouter,github,cerebras,mistral,ollama,heuristic"

# name -> (base URL, key env var, default model, json_mode)
OPENAI_COMPATIBLE: dict[str, tuple[str, str, str, bool]] = {
    "groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY", "openai/gpt-oss-120b", True),
    "cerebras": ("https://api.cerebras.ai/v1", "CEREBRAS_API_KEY", "llama-3.3-70b", True),
    "openrouter": (
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
        "openrouter/free",
        False,
    ),
    "mistral": ("https://api.mistral.ai/v1", "MISTRAL_API_KEY", "mistral-small-latest", True),
    "github": ("https://models.github.ai/inference", "GITHUB_TOKEN", "openai/gpt-4o-mini", True),
    "openai": ("https://api.openai.com/v1", "OPENAI_API_KEY", "gpt-4o-mini", True),
}


def provider_order(env: Mapping[str, str]) -> list[str]:
    names = [n.strip().lower() for n in env.get("LLM_PROVIDERS", DEFAULT_ORDER).split(",")]
    names = [n for n in dict.fromkeys(names) if n]
    if "heuristic" in names:
        names.remove("heuristic")
    return [*names, "heuristic"]  # the rules floor is always last


def _model(env: Mapping[str, str], name: str, default: str) -> str:
    return env.get(f"{name.upper()}_MODEL") or default


def build_provider(
    name: str, env: Mapping[str, str], client: httpx.AsyncClient | None = None
) -> LLMProvider | None:
    if name == "heuristic":
        return HeuristicProvider()
    if name == "gemini":
        return GeminiProvider(
            env.get("GEMINI_API_KEY"), _model(env, name, "gemini-flash-lite-latest"), client=client
        )
    if name == "anthropic":
        return AnthropicProvider(
            env.get("ANTHROPIC_API_KEY"), _model(env, name, "claude-haiku-4-5"), client=client
        )
    if name == "ollama":
        return OllamaProvider(
            env.get("OLLAMA_BASE_URL"), _model(env, name, "llama3.1:8b"), client=client
        )
    if name in OPENAI_COMPATIBLE:
        base_url, key_var, default_model, json_mode = OPENAI_COMPATIBLE[name]
        extra = {"X-Title": "InboxPilot"} if name == "openrouter" else {}
        return OpenAICompatibleProvider(
            name=name,
            base_url=env.get(f"{name.upper()}_BASE_URL") or base_url,
            api_key=env.get(key_var),
            model=_model(env, name, default_model),
            json_mode=json_mode,
            extra_headers=extra,
            client=client,
            # the free pool is shared and sometimes slow (3-20 s): more than the 25 s default
            timeout_s=60 if name == "openrouter" else None,
        )
    log.warning("unknown LLM provider %r in LLM_PROVIDERS; skipping", name)
    return None


# provider -> env var holding its key (what a user's own key replaces)
KEY_ENV: dict[str, str] = {
    "gemini": "GEMINI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    **{name: spec[1] for name, spec in OPENAI_COMPATIBLE.items()},
}


def provider_factory(
    env: Mapping[str, str], client: httpx.AsyncClient | None = None
) -> Callable[[str, str], LLMProvider | None]:
    """Build a provider that uses a caller-supplied API key (same model and base URL settings)."""

    def build(name: str, api_key: str) -> LLMProvider | None:
        var = KEY_ENV.get(name)
        if var is None:  # heuristic and ollama take no key
            return None
        return build_provider(name, {**env, var: api_key}, client)

    return build


def build_providers(
    env: Mapping[str, str], client: httpx.AsyncClient | None = None
) -> list[LLMProvider]:
    providers = [build_provider(n, env, client) for n in provider_order(env)]
    return [p for p in providers if p is not None]
