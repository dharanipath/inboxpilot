from __future__ import annotations

import os
import re
from collections.abc import MutableMapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    internal_api_key: str
    extract_batch_size: int = 6
    extract_concurrency: int = 3  # parallel LLM calls per sync; free tiers rate-limit by RPM
    max_body_chars: int = 4000
    low_confidence: float = 0.5
    llm_timeout_s: float = 25
    redis_url: str | None = None

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            internal_api_key=os.environ.get("INTERNAL_API_KEY", ""),
            extract_batch_size=int(os.environ.get("EXTRACT_BATCH_SIZE", "6")),
            extract_concurrency=int(os.environ.get("EXTRACT_CONCURRENCY", "3")),
            max_body_chars=int(os.environ.get("MAX_BODY_CHARS", "4000")),
            llm_timeout_s=float(os.environ.get("LLM_TIMEOUT_S", "25")),
            redis_url=os.environ.get("REDIS_URL") or None,
        )


def _env_value(raw: str) -> str:
    """A .env value: a quoted string, or text up to an inline ` # comment`."""
    raw = raw.strip()
    if raw and raw[0] in "'\"":
        end = raw.find(raw[0], 1)
        return raw[1:] if end == -1 else raw[1:end]
    return re.split(r"(?:^|\s+)#", raw, maxsplit=1)[0].strip()


def load_env_file(path: Path, env: MutableMapping[str, str] | None = None) -> int:
    """Minimal .env loader (KEY=VALUE lines). Never overrides variables already set."""
    target = os.environ if env is None else env
    if not path.is_file():
        return 0
    loaded = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip().removeprefix("export ").strip(), _env_value(value)
        if key and key not in target:
            target[key] = value
            loaded += 1
    return loaded
