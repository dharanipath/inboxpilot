"""Google Gemini (AI Studio) via the native REST API with JSON output mode."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from app.llm.base import InvalidOutput, ProviderError, parse_json_text, post_json

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


@dataclass
class GeminiProvider:
    api_key: str | None
    model: str = "gemini-flash-lite-latest"  # current Flash-Lite: fast; 2.5 is closed to new keys
    base_url: str = GEMINI_BASE_URL
    client: httpx.AsyncClient | None = field(default=None, repr=False)
    timeout_s: float | None = None
    name: str = "gemini"

    def is_configured(self) -> bool:
        return bool(self.api_key)

    async def complete_json(
        self, system: str, user: str, schema: dict[str, Any], timeout_s: float = 25
    ) -> dict[str, Any]:
        data = await post_json(
            self.client,
            self.name,
            f"{self.base_url.rstrip('/')}/models/{self.model}:generateContent",
            # key goes in a header, so it never appears in a URL or access log
            headers={"x-goog-api-key": self.api_key or ""},
            payload={
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
            },
            timeout_s=timeout_s,
        )
        candidates = data.get("candidates") or []
        if not candidates:
            reason = (data.get("promptFeedback") or {}).get("blockReason", "no candidates")
            raise ProviderError(f"{self.name}: {reason}")
        try:
            parts = candidates[0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts)
        except (KeyError, IndexError, TypeError, AttributeError):
            raise InvalidOutput(f"{self.name}: unexpected response shape") from None
        return parse_json_text(text)
