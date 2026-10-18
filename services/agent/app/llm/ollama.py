"""Ollama (local, fully offline): email text never leaves the machine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from app.llm.base import InvalidOutput, parse_json_text, post_json


@dataclass
class OllamaProvider:
    base_url: str | None
    model: str = "llama3.1:8b"
    client: httpx.AsyncClient | None = field(default=None, repr=False)
    timeout_s: float | None = 120  # local CPU inference is slow; overrides the router default
    name: str = "ollama"

    def is_configured(self) -> bool:
        return bool(self.base_url)

    async def complete_json(
        self, system: str, user: str, schema: dict[str, Any], timeout_s: float = 25
    ) -> dict[str, Any]:
        data = await post_json(
            self.client,
            self.name,
            f"{(self.base_url or '').rstrip('/')}/api/chat",
            headers={},
            payload={
                "model": self.model,
                "stream": False,
                "format": schema or "json",  # structured outputs (JSON schema) on Ollama >= 0.5
                "options": {"temperature": 0},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            timeout_s=timeout_s,
        )
        message = data.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str):
            raise InvalidOutput(f"{self.name}: unexpected response shape")
        return parse_json_text(content)
