"""FastAPI entrypoint. Run: uvicorn app.main:create_app --factory --port 8000"""

from __future__ import annotations

import hmac
import logging
import os
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.ask import answer
from app.config import Settings, load_env_file
from app.llm.prompts import today_line
from app.llm.registry import build_providers, provider_factory
from app.llm.router import LLMRouter
from app.llm.store import store_from_url
from app.pipeline.briefing import build_briefing
from app.pipeline.orchestrator import Pipeline
from app.schemas import (
    AskRequest,
    AskResponse,
    Briefing,
    BriefingRequest,
    ExtractRequest,
    ExtractResponse,
    ProvidersRequest,
    ProvidersResponse,
    ProviderStatus,
    ProviderTestRequest,
    ProviderTestResponse,
    plain_keys,
)

VERSION = "1.1.0"


def repo_env_file() -> Path | None:
    """The repo-root .env when running from source; None inside the container (shallower path)."""
    parents = Path(__file__).resolve().parents
    return parents[3] / ".env" if len(parents) > 3 else None


log = logging.getLogger("inboxpilot.agent")
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def _request_id(request: Request) -> str:
    return str(getattr(request.state, "request_id", "")) or "unknown"


def problem(
    request: Request, status: int, title: str, detail: str | None = None, **extra: Any
) -> JSONResponse:
    """RFC 7807 problem+json."""
    body = {
        "type": "about:blank",
        "title": title,
        "status": status,
        "detail": detail,
        "traceId": _request_id(request),
        **extra,
    }
    return JSONResponse(
        body,
        status_code=status,
        media_type="application/problem+json",
        headers={"x-request-id": _request_id(request)},
    )


def build_router(settings: Settings, client: httpx.AsyncClient | None) -> LLMRouter:
    return LLMRouter(
        build_providers(os.environ, client),
        store_from_url(settings.redis_url),
        timeout_s=settings.llm_timeout_s,
        factory=provider_factory(os.environ, client),
    )


def create_app(settings: Settings | None = None, router: LLMRouter | None = None) -> FastAPI:
    if settings is None:
        env_file = repo_env_file()
        if env_file is not None:
            load_env_file(env_file)  # local dev convenience; Docker passes env directly
        settings = Settings.from_env()
    client: httpx.AsyncClient | None = None
    if router is None:
        client = httpx.AsyncClient(limits=httpx.Limits(max_connections=20))
        router = build_router(settings, client)
    pipeline = Pipeline(router, settings)
    llm_router = router

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        if client is not None:
            await client.aclose()

    app = FastAPI(title="InboxPilot agent", version=VERSION, lifespan=lifespan)

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get("x-request-id", "")
        rid = incoming if _SAFE_REQUEST_ID.match(incoming) else uuid.uuid4().hex
        request.state.request_id = rid
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        # never log bodies or headers: only route, status and timing
        log.info(
            "request",
            extra={
                "request_id": rid,
                "path": request.url.path,
                "status": response.status_code,
                "ms": int((time.perf_counter() - started) * 1000),
            },
        )
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return problem(request, exc.status_code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # drop "input"/"ctx" so email bodies are never echoed back or logged
        errors = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        return problem(
            request,
            422,
            "Request validation failed",
            f"{len(errors)} validation error(s)",
            errors=errors,
        )

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", extra={"request_id": _request_id(request)})
        return problem(request, 500, "Internal error", "The agent failed to process the request.")

    def require_internal_key(x_internal_key: str | None = Header(default=None)) -> None:
        if not settings.internal_api_key:
            raise HTTPException(503, "Agent is not configured: INTERNAL_API_KEY is unset")
        if not x_internal_key or not hmac.compare_digest(
            x_internal_key.encode(), settings.internal_api_key.encode()
        ):
            raise HTTPException(401, "Missing or invalid X-Internal-Key")

    @app.get("/v1/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": VERSION}

    @app.get(
        "/v1/providers",
        response_model=ProvidersResponse,
        dependencies=[Depends(require_internal_key)],
    )
    async def providers() -> ProvidersResponse:
        statuses = await llm_router.status()
        return ProvidersResponse(providers=[ProviderStatus(**s) for s in statuses])

    @app.post(
        "/v1/providers",
        response_model=ProvidersResponse,
        dependencies=[Depends(require_internal_key)],
    )
    async def user_providers(req: ProvidersRequest) -> ProvidersResponse:
        """Status as one user sees it: their own keys, and the cooldowns of those keys."""
        keys: dict[str, str] = {
            n: k.get_secret_value() for n, k in (req.provider_keys or {}).items()
        }
        statuses = await llm_router.with_keys(keys).status()
        return ProvidersResponse(providers=[ProviderStatus(**s) for s in statuses])

    @app.post(
        "/v1/providers/test",
        response_model=ProviderTestResponse,
        dependencies=[Depends(require_internal_key)],
    )
    async def test_provider(req: ProviderTestRequest) -> ProviderTestResponse:
        """One tiny call to check a key before the gateway saves it."""
        r = await llm_router.probe(req.name, req.api_key.get_secret_value())
        return ProviderTestResponse(
            name=req.name,
            model=r.model,
            outcome=r.outcome,
            retry_after_s=r.retry_after_s,
            message=r.message,
        )

    @app.post(
        "/v1/extract",
        response_model=ExtractResponse,
        dependencies=[Depends(require_internal_key)],
    )
    async def extract(req: ExtractRequest) -> ExtractResponse:
        return await pipeline.run(req)

    @app.post("/v1/ask", response_model=AskResponse, dependencies=[Depends(require_internal_key)])
    async def ask(req: AskRequest) -> AskResponse:
        return await answer(req, llm_router.with_keys(plain_keys(req.options)))

    @app.post("/v1/briefing", response_model=Briefing, dependencies=[Depends(require_internal_key)])
    async def briefing(req: BriefingRequest) -> Briefing:
        result, _, _ = await build_briefing(
            req.tasks,
            router=llm_router.with_keys(plain_keys(req.options)),
            user_name=req.user.name,
            today_line=today_line(req.user.now, req.user.timezone),
            horizon_days=req.options.horizon_days,
            use_llm=req.options.use_llm_briefing,
            timezone_name=req.user.timezone,
            order=req.options.providers,
        )
        return result

    return app
