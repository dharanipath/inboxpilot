"""Adapters against mocked HTTP (respx). No real network calls."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from typing import Any, TypeVar

import httpx
import pytest
import respx

from app.llm.base import (
    AuthError,
    InvalidOutput,
    OutOfCredit,
    ProviderError,
    ProviderTimeout,
    RateLimited,
    parse_json_text,
    parse_retry_after,
)
from app.llm.gemini import GeminiProvider
from app.llm.ollama import OllamaProvider
from app.llm.openai_compat import OpenAICompatibleProvider

T = TypeVar("T")
KEY = "sk-test-SECRET"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent"
ITEMS = {"items": []}


def run(coro: Awaitable[T]) -> T:
    return asyncio.run(coro)  # type: ignore[arg-type]


def groq(**kw: Any) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        name="groq",
        base_url="https://api.groq.com/openai/v1",
        api_key=KEY,
        model="llama-3.3-70b-versatile",
        **kw,
    )


def chat(content: str) -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


# ---------------------------------------------------------------- helpers


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('{"items": []}', ITEMS),
        ('```json\n{"items": []}\n```', ITEMS),
        ('Sure! Here you go: {"items": []} Hope this helps.', ITEMS),
    ],
)
def test_parse_json_text_tolerates_wrapping(text: str, expected: dict[str, Any]) -> None:
    assert parse_json_text(text) == expected


@pytest.mark.parametrize("text", ["no json here", "[1, 2]", '{"items": [}'])
def test_parse_json_text_rejects_garbage(text: str) -> None:
    with pytest.raises(InvalidOutput):
        parse_json_text(text)


def test_parse_retry_after() -> None:
    assert parse_retry_after("12") == 12
    assert parse_retry_after(None) is None
    assert parse_retry_after("soon") is None
    future = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=90), usegmt=True)
    assert 80 < (parse_retry_after(future) or 0) <= 90


# ---------------------------------------------------------------- OpenAI-compatible


@respx.mock
def test_openai_compatible_success_sends_json_mode_and_bearer() -> None:
    route = respx.post(GROQ_URL).mock(return_value=httpx.Response(200, json=chat('{"items": []}')))
    assert run(groq().complete_json("sys", "user", {})) == ITEMS
    req = route.calls.last.request
    body = json.loads(req.content)
    assert req.headers["authorization"] == f"Bearer {KEY}"
    assert body["temperature"] == 0 and body["response_format"] == {"type": "json_object"}
    assert body["messages"][0] == {"role": "system", "content": "sys"}


@respx.mock
def test_openai_compatible_without_json_mode() -> None:
    route = respx.post(GROQ_URL).mock(return_value=httpx.Response(200, json=chat("{}")))
    run(groq(json_mode=False).complete_json("s", "u", {}))
    assert "response_format" not in json.loads(route.calls.last.request.content)


@respx.mock
def test_rate_limit_carries_retry_after() -> None:
    respx.post(GROQ_URL).mock(return_value=httpx.Response(429, headers={"retry-after": "12"}))
    with pytest.raises(RateLimited) as err:
        run(groq().complete_json("s", "u", {}))
    assert err.value.retry_after_s == 12


@pytest.mark.parametrize(
    ("status", "exc"),
    [(401, AuthError), (403, AuthError), (500, ProviderError), (400, ProviderError)],
)
@respx.mock
def test_http_errors_map_to_provider_errors(status: int, exc: type[Exception]) -> None:
    respx.post(GROQ_URL).mock(return_value=httpx.Response(status, text=f"echo {KEY} prompt"))
    with pytest.raises(exc) as err:
        run(groq().complete_json("s", "u", {}))
    assert KEY not in str(err.value) and "prompt" not in str(err.value)


@respx.mock
def test_timeout_and_network_errors() -> None:
    respx.post(GROQ_URL).mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(ProviderTimeout):
        run(groq().complete_json("s", "u", {}, timeout_s=1))
    respx.post(GROQ_URL).mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(ProviderError):
        run(groq().complete_json("s", "u", {}))


@pytest.mark.parametrize(
    "payload", [{"choices": []}, {"choices": [{"message": {"content": None}}]}, ["not", "dict"]]
)
@respx.mock
def test_unexpected_shapes_are_invalid_output(payload: Any) -> None:
    respx.post(GROQ_URL).mock(return_value=httpx.Response(200, json=payload))
    with pytest.raises(InvalidOutput):
        run(groq().complete_json("s", "u", {}))


@respx.mock
def test_non_json_body_is_invalid_output() -> None:
    respx.post(GROQ_URL).mock(return_value=httpx.Response(200, text="<html>oops</html>"))
    with pytest.raises(InvalidOutput):
        run(groq().complete_json("s", "u", {}))


def test_not_configured_without_key() -> None:
    p = OpenAICompatibleProvider(name="x", base_url="http://x", api_key=None, model="m")
    assert not p.is_configured() and groq().is_configured()


@respx.mock
def test_shared_client_is_used() -> None:
    respx.post(GROQ_URL).mock(return_value=httpx.Response(200, json=chat("{}")))

    async def go() -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            return await groq(client=client).complete_json("s", "u", {})

    assert run(go()) == {}


# ---------------------------------------------------------------- Gemini


@respx.mock
def test_gemini_success_uses_header_key_and_json_mime() -> None:
    route = respx.post(GEMINI_URL).mock(
        return_value=httpx.Response(
            200, json={"candidates": [{"content": {"parts": [{"text": '{"items": []}'}]}}]}
        )
    )
    assert run(GeminiProvider(KEY).complete_json("sys", "user", {})) == ITEMS
    req = route.calls.last.request
    assert req.headers["x-goog-api-key"] == KEY and KEY not in str(req.url)
    body = json.loads(req.content)
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    assert body["systemInstruction"]["parts"][0]["text"] == "sys"


@respx.mock
def test_gemini_retry_delay_from_body() -> None:
    body = {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "31s"}],
        }
    }
    respx.post(GEMINI_URL).mock(return_value=httpx.Response(429, json=body))
    with pytest.raises(RateLimited) as err:
        run(GeminiProvider(KEY).complete_json("s", "u", {}))
    assert err.value.retry_after_s == 31


@respx.mock
def test_gemini_blocked_prompt_is_provider_error() -> None:
    respx.post(GEMINI_URL).mock(
        return_value=httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})
    )
    with pytest.raises(ProviderError, match="SAFETY"):
        run(GeminiProvider(KEY).complete_json("s", "u", {}))


@respx.mock
def test_gemini_bad_shape() -> None:
    respx.post(GEMINI_URL).mock(
        return_value=httpx.Response(200, json={"candidates": [{"content": "nope"}]})
    )
    with pytest.raises(InvalidOutput):
        run(GeminiProvider(KEY).complete_json("s", "u", {}))


# ---------------------------------------------------------------- Ollama


@respx.mock
def test_ollama_sends_schema_format_and_is_local() -> None:
    route = respx.post("http://localhost:11434/api/chat").mock(
        return_value=httpx.Response(200, json={"message": {"content": '{"items": []}'}})
    )
    p = OllamaProvider("http://localhost:11434")
    schema = {"type": "object"}
    assert run(p.complete_json("s", "u", schema)) == ITEMS
    body = json.loads(route.calls.last.request.content)
    assert body["format"] == schema and body["stream"] is False
    assert p.timeout_s == 120
    assert not OllamaProvider(None).is_configured()


@respx.mock
def test_ollama_bad_shape() -> None:
    respx.post("http://localhost:11434/api/chat").mock(return_value=httpx.Response(200, json={}))
    with pytest.raises(InvalidOutput):
        run(OllamaProvider("http://localhost:11434").complete_json("s", "u", {}))


def _google_error(code: int, status: str, reason: str | None = None) -> httpx.Response:
    details = (
        [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason}] if reason else []
    )
    return httpx.Response(
        code,
        json={
            "error": {
                "code": code,
                "message": f"echo {KEY} prompt",
                "status": status,
                "details": details,
            }
        },
    )


@respx.mock
def test_gemini_invalid_key_is_an_auth_error_even_though_google_sends_400() -> None:
    # Google answers a bad key with 400 API_KEY_INVALID, not 401
    respx.post(GEMINI_URL).mock(
        return_value=_google_error(400, "INVALID_ARGUMENT", "API_KEY_INVALID")
    )
    with pytest.raises(AuthError) as err:
        run(GeminiProvider(KEY).complete_json("s", "u", {}))
    assert str(err.value) == "gemini: key rejected (400 API_KEY_INVALID)"


@respx.mock
def test_other_errors_carry_the_code_but_never_the_message_text() -> None:
    respx.post(GEMINI_URL).mock(return_value=_google_error(400, "FAILED_PRECONDITION"))
    with pytest.raises(ProviderError) as err:
        run(GeminiProvider(KEY).complete_json("s", "u", {}))
    assert not isinstance(err.value, AuthError)
    assert str(err.value) == "gemini: HTTP 400 FAILED_PRECONDITION"
    assert KEY not in str(err.value) and "prompt" not in str(err.value)


@respx.mock
@pytest.mark.parametrize(
    ("status", "message", "code"),
    [
        (402, "You have exceeded your monthly included credits.", "NO_CREDIT"),
        (404, "This model models/x is no longer available to new users.", "MODEL_RETIRED"),
    ],
)
def test_known_provider_messages_become_codes(status: int, message: str, code: str) -> None:
    respx.post(GEMINI_URL).mock(
        return_value=httpx.Response(status, json={"error": {"message": message, "type": "x"}})
    )
    with pytest.raises(ProviderError) as err:
        run(GeminiProvider(KEY).complete_json("s", "u", {}))
    assert str(err.value) == f"gemini: HTTP {status} {code}"
    assert "credits" not in str(err.value) and "users" not in str(err.value)


@respx.mock
def test_any_402_is_out_of_credit_even_without_a_json_body() -> None:
    """OpenRouter answers 402 Payment Required when free credits run out."""
    respx.post(GROQ_URL).mock(return_value=httpx.Response(402, text="Payment Required"))
    with pytest.raises(OutOfCredit) as err:
        run(groq().complete_json("s", "u", {}))
    assert str(err.value) == "groq: HTTP 402 NO_CREDIT"
