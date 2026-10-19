"""Anthropic Claude via the native Messages REST API."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from app.llm.base import InvalidOutput, parse_json_text, post_json

ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"


@dataclass
class AnthropicProvider:
    api_key: str | None
    model: str = "claude-haiku-4-5"
    base_url: str = ANTHROPIC_BASE_URL
    client: httpx.AsyncClient | None = field(default=None, repr=False)
    timeout_s: float | None = None
    name: str = "anthropic"

    def is_configured(self) -> bool:
        return bool(self.api_key)

    async def complete_json(
        self, system: str, user: str, schema: dict[str, Any], timeout_s: float = 25
    ) -> dict[str, Any]:
        data = await post_json(
            self.client,
            self.name,
            f"{self.base_url.rstrip('/')}/messages",
            headers={
                "x-api-key": self.api_key or "",
                "anthropic-version": "2023-06-01",
            },
            payload={
                "model": self.model,
                "max_tokens": 4096,
                "temperature": 0,
                "system": system + "\nRespond with a single JSON object and nothing else.",
                "messages": [{"role": "user", "content": user}],
            },
            timeout_s=timeout_s,
        )
        try:
            text = "".join(b.get("text", "") for b in data["content"] if b.get("type") == "text")
        except (KeyError, TypeError, AttributeError):
            raise InvalidOutput(f"{self.name}: unexpected response shape") from None
        return parse_json_text(text)
