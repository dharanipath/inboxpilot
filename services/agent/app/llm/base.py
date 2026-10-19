"""The one interface every LLM backend implements (ADR 0003), plus shared HTTP helpers."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Protocol

import httpx


class ProviderError(Exception):
    """Any failure that should make the router try the next provider."""


class RateLimited(ProviderError):
    def __init__(self, message: str, retry_after_s: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class AuthError(ProviderError):
    """Bad or missing key: no point retrying soon."""


class OutOfCredit(ProviderError):
    """The key is valid but the account has no credit (paid APIs): retrying will not help."""


class ProviderTimeout(ProviderError):
    pass


class InvalidOutput(ProviderError):
    """The provider answered, but not with JSON matching the schema."""


class AllProvidersFailed(ProviderError):
    def __init__(self, message: str, attempts: list[Any] | None = None) -> None:
        super().__init__(message)
        self.attempts: list[Any] = attempts or []  # router Attempts, kept for usage reporting


class LLMProvider(Protocol):
    name: str
    model: str

    def is_configured(self) -> bool: ...

    async def complete_json(
        self, system: str, user: str, schema: dict[str, Any], timeout_s: float = 25
    ) -> dict[str, Any]:
        """Return parsed JSON. Raises RateLimited / AuthError / ProviderError / InvalidOutput."""
        ...


# ---------------------------------------------------------------- helpers

_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.S | re.I)
_CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,60}$")
# Google reports a bad key as HTTP 400 API_KEY_INVALID (not 401), and a disabled API as 403
_AUTH_REASONS = frozenset(
    {"API_KEY_INVALID", "API_KEY_EXPIRED", "UNAUTHENTICATED", "PERMISSION_DENIED"}
)
_RETRY_DELAY = re.compile(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"')


def parse_json_text(text: str) -> dict[str, Any]:
    """Parse a model reply that should be a JSON object, tolerating ``` fences and chatter."""
    t = text.strip()
    fence = _FENCE.match(t)
    if fence:
        t = fence.group(1)
    try:
        value = json.loads(t)
    except json.JSONDecodeError:
        start, end = t.find("{"), t.rfind("}")
        if start < 0 or end <= start:
            raise InvalidOutput("reply contains no JSON object") from None
        try:
            value = json.loads(t[start : end + 1])
        except json.JSONDecodeError as exc:
            raise InvalidOutput(f"invalid JSON: {exc.msg}") from None
    if not isinstance(value, dict):
        raise InvalidOutput("reply is not a JSON object")
    return value


def parse_retry_after(value: str | None) -> float | None:
    """Retry-After as seconds or an HTTP date."""
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


_KNOWN_MESSAGES = (
    ("no longer available to new users", "MODEL_RETIRED"),  # Gemini: model closed to new keys
    ("insufficient_quota", "NO_CREDIT"),
    ("credit balance is too low", "NO_CREDIT"),  # Anthropic answers 400 when credit runs out
    ("no credits remaining", "NO_CREDIT"),  # OpenAI answers 429 when credit runs out
)


def error_reason(resp: httpx.Response) -> str | None:
    """A provider's machine-readable error code (e.g. API_KEY_INVALID), if it sent one.

    Only UPPER_SNAKE codes are returned, never free-text messages, which may echo the prompt.
    """
    try:
        data = resp.json()
    except ValueError:
        return None
    err = data.get("error") if isinstance(data, dict) else None
    if not isinstance(err, dict):
        return None
    # a few fixed provider messages that matter to the user, turned into codes (never echoed)
    message = str(err.get("message", "")).lower()
    for phrase, code in _KNOWN_MESSAGES:
        if phrase in message:
            return code
    codes: list[str] = []
    for detail in err.get("details") or []:
        if isinstance(detail, dict) and isinstance(detail.get("reason"), str):
            codes.append(detail["reason"])
    for field in ("status", "code", "type"):
        if isinstance(err.get(field), str):
            codes.append(err[field])
    for code in codes:
        if _CODE.match(code):
            return code
    return None


def _retry_after(resp: httpx.Response) -> float | None:
    header = parse_retry_after(resp.headers.get("retry-after"))
    if header is not None:
        return header
    m = _RETRY_DELAY.search(resp.text[:4000])  # Gemini puts RetryInfo in the error body
    return float(m.group(1)) if m else None


async def post_json(
    client: httpx.AsyncClient | None,
    provider: str,
    url: str,
    *,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_s: float,
) -> dict[str, Any]:
    """POST and map HTTP failures onto provider errors. Error text never includes bodies or keys."""
    try:
        if client is None:
            async with httpx.AsyncClient() as own:
                resp = await own.post(url, headers=headers, json=payload, timeout=timeout_s)
        else:
            resp = await client.post(url, headers=headers, json=payload, timeout=timeout_s)
    except httpx.TimeoutException as exc:
        raise ProviderTimeout(f"{provider}: timed out after {timeout_s:g}s") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(f"{provider}: {type(exc).__name__}") from exc

    if resp.status_code == 429:
        # a spent balance is not a rate limit: retrying later will not help
        if error_reason(resp) == "NO_CREDIT":
            raise OutOfCredit(f"{provider}: HTTP 429 NO_CREDIT")
        raise RateLimited(f"{provider}: rate limited (429)", _retry_after(resp))
    if resp.status_code >= 400:
        reason = error_reason(resp)
        suffix = f" {reason}" if reason else ""
        # 402 Payment Required: free credits used up (OpenRouter) or none left
        if resp.status_code == 402 or reason == "NO_CREDIT":
            raise OutOfCredit(f"{provider}: HTTP {resp.status_code} NO_CREDIT")
        if resp.status_code in (401, 403) or reason in _AUTH_REASONS:
            raise AuthError(f"{provider}: key rejected ({resp.status_code}{suffix})")
        raise ProviderError(f"{provider}: HTTP {resp.status_code}{suffix}")
    try:
        data = resp.json()
    except ValueError:
        raise InvalidOutput(f"{provider}: response body is not JSON") from None
    if not isinstance(data, dict):
        raise InvalidOutput(f"{provider}: unexpected response shape")
    return data
