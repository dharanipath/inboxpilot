"""Tiny key-value store for the LLM cache and circuit-breaker state (ADR 0004).

Redis in production, so every worker shares cooldowns. In-memory for tests and when no
REDIS_URL is set. A Redis outage degrades to "no cache, no shared circuit": it never
breaks extraction.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

log = logging.getLogger("inboxpilot.agent.store")


class KVStore(Protocol):
    async def get(self, key: str) -> str | None: ...
    async def set(self, key: str, value: str, ttl_s: float) -> None: ...
    async def incr(self, key: str, ttl_s: float) -> int: ...
    async def delete(self, key: str) -> None: ...
    async def ttl(self, key: str) -> float | None: ...


class InMemoryStore:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._data: dict[str, tuple[str, float]] = {}

    def _live(self, key: str) -> tuple[str, float] | None:
        entry = self._data.get(key)
        if entry and entry[1] <= self._clock():
            del self._data[key]
            return None
        return entry

    async def get(self, key: str) -> str | None:
        entry = self._live(key)
        return entry[0] if entry else None

    async def set(self, key: str, value: str, ttl_s: float) -> None:
        self._data[key] = (value, self._clock() + ttl_s)

    async def incr(self, key: str, ttl_s: float) -> int:
        entry = self._live(key)
        n = int(entry[0]) + 1 if entry else 1
        expires = entry[1] if entry else self._clock() + ttl_s
        self._data[key] = (str(n), expires)
        return n

    async def delete(self, key: str) -> None:
        self._data.pop(key, None)

    async def ttl(self, key: str) -> float | None:
        entry = self._live(key)
        return entry[1] - self._clock() if entry else None


class RedisStore:
    def __init__(self, client: Any) -> None:
        self._r = client

    @classmethod
    def from_url(cls, url: str) -> RedisStore:
        import redis.asyncio as redis

        return cls(
            redis.from_url(url, decode_responses=True, socket_timeout=2, socket_connect_timeout=2)
        )

    async def get(self, key: str) -> str | None:
        try:
            value = await self._r.get(key)
            return None if value is None else str(value)
        except Exception as exc:
            log.warning("redis get failed: %s", type(exc).__name__)
            return None

    async def set(self, key: str, value: str, ttl_s: float) -> None:
        try:
            await self._r.set(key, value, px=max(1, int(ttl_s * 1000)))
        except Exception as exc:
            log.warning("redis set failed: %s", type(exc).__name__)

    async def incr(self, key: str, ttl_s: float) -> int:
        try:
            n = int(await self._r.incr(key))
            if n == 1:
                await self._r.pexpire(key, max(1, int(ttl_s * 1000)))
            return n
        except Exception as exc:
            log.warning("redis incr failed: %s", type(exc).__name__)
            return 1

    async def delete(self, key: str) -> None:
        try:
            await self._r.delete(key)
        except Exception as exc:
            log.warning("redis delete failed: %s", type(exc).__name__)

    async def ttl(self, key: str) -> float | None:
        try:
            ms = int(await self._r.pttl(key))
        except Exception as exc:
            log.warning("redis pttl failed: %s", type(exc).__name__)
            return None
        return ms / 1000 if ms > 0 else None


def store_from_url(url: str | None) -> KVStore:
    return RedisStore.from_url(url) if url else InMemoryStore()
