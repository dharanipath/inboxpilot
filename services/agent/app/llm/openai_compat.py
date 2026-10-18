"""One adapter for every OpenAI-compatible API: Groq, Cerebras, OpenRouter, Mistral,
GitHub Models, Hugging Face router and OpenAI itself. Adding one is a config change."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from app.llm.base import InvalidOutput, parse_json_text, post_json


@dataclass
class OpenAICompatibleProvider:
    name: str
    base_url: str
    api_key: str | None
    model: str
    json_mode: bool = True  # send response_format={"type":"json_object"}
    extra_headers: dict[str, str] = field(default_factory=dict)
    client: httpx.AsyncClient | None = field(default=None, repr=False)
    timeout_s: float | None = None

    def is_configured(self) -> bool:
        return bool(self.api_key)

    async def complete_json(
        self, system: str, user: str, schema: dict[str, Any], timeout_s: float = 25
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if self.json_mode:
            payload["response_format"] = {"type": "json_object"}
        data = await post_json(
            self.client,
            self.name,
            f"{self.base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}", **self.extra_headers},
            payload=payload,
            timeout_s=timeout_s,
        )
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise InvalidOutput(f"{self.name}: unexpected response shape") from None
        if not isinstance(content, str):
            raise InvalidOutput(f"{self.name}: empty message content")
        return parse_json_text(content)
