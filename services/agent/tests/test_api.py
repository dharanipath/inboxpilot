from __future__ import annotations

import json
from typing import Any

import httpx
import jsonschema
import pytest
import respx
from fastapi.testclient import TestClient

from app.config import Settings
from app.llm.router import LLMRouter
from app.main import create_app
from tests.conftest import INTERNAL_KEY, load_contract, load_fixture, mail

AUTH = {"X-Internal-Key": INTERNAL_KEY}


@pytest.fixture
def client() -> TestClient:
    return TestClient(
        create_app(Settings(internal_api_key=INTERNAL_KEY)), raise_server_exceptions=False
    )


def _validator(name: str) -> jsonschema.Draft202012Validator:
    schema = load_contract()
    return jsonschema.Draft202012Validator(
        {**schema, "$ref": f"#/$defs/{name}"},
        format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER,
    )


def test_health_needs_no_key(client: TestClient) -> None:
    r = client.get("/v1/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert r.headers["x-request-id"]


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Key": "wrong"}])
def test_extract_requires_internal_key(
    client: TestClient, headers: dict[str, str], inbox_request: dict[str, Any]
) -> None:
    r = client.post(
        "/v1/extract", json=inbox_request, headers={**headers, "x-request-id": "req-123"}
    )
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["status"] == 401 and body["traceId"] == "req-123"


def test_unconfigured_key_is_503(inbox_request: dict[str, Any]) -> None:
    c = TestClient(create_app(Settings(internal_api_key="")))
    assert c.post("/v1/extract", json=inbox_request, headers=AUTH).status_code == 503


def test_too_many_emails_is_422_without_echoing_bodies(
    client: TestClient, inbox_request: dict[str, Any]
) -> None:
    inbox_request["emails"] = [mail(f"x{i}", "s", "SECRET BODY") for i in range(201)]
    r = client.post("/v1/extract", json=inbox_request, headers=AUTH)
    assert r.status_code == 422
    assert r.json()["title"] == "Request validation failed"
    assert "SECRET BODY" not in r.text


def test_naive_datetime_is_rejected(client: TestClient, inbox_request: dict[str, Any]) -> None:
    inbox_request["emails"][0]["received_at"] = "2026-10-14T10:00:00"
    assert client.post("/v1/extract", json=inbox_request, headers=AUTH).status_code == 422


def test_extract_output_matches_contract(client: TestClient, inbox_request: dict[str, Any]) -> None:
    r = client.post("/v1/extract", json=inbox_request, headers=AUTH)
    assert r.status_code == 200, r.text
    errors = [e.message for e in _validator("ExtractResponse").iter_errors(r.json())]
    assert errors == []
    assert len(r.json()["tasks"]) == 3


def test_email_with_no_task_still_matches_contract(
    client: TestClient, inbox_request: dict[str, Any]
) -> None:
    """A batch whose emails yield no task leaves later steps with nothing to count; the trace
    must still be valid (an empty `counts` object, never null). Regression: a single new
    "FYI" email failed the whole sync at the gateway's contract check."""
    inbox_request["emails"] = [
        mail("fyi-1", "Quick update", "Hi Sam, just an update: the office reopened on Monday.")
    ]
    r = client.post("/v1/extract", json=inbox_request, headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tasks"] == []
    assert [e.message for e in _validator("ExtractResponse").iter_errors(body)] == []
    assert all(isinstance(step.get("counts", {}), dict) for step in body["trace"])


def test_contract_fixture_request_round_trip(client: TestClient) -> None:
    req = load_fixture("extract.request.json")
    assert list(_validator("ExtractRequest").iter_errors(req)) == []
    r = client.post("/v1/extract", json=req, headers=AUTH)
    body = r.json()
    assert list(_validator("ExtractResponse").iter_errors(body)) == []
    (task,) = body["tasks"]
    assert task["evidence"] == "Can you send the deck before the call on Tuesday?"
    assert task["due_date"] == "2026-10-20"
    assert body["skipped"] == [{"email_id": "msg_002", "reason": "newsletter"}]


def test_request_id_is_generated_and_unsafe_ids_replaced(client: TestClient) -> None:
    assert len(client.get("/v1/health").headers["x-request-id"]) == 32
    r = client.get("/v1/health", headers={"x-request-id": "bad id\nwith newline"})
    assert r.headers["x-request-id"] != "bad id\nwith newline"


def test_unknown_route_is_problem_json(client: TestClient) -> None:
    r = client.get("/v1/nope")
    assert r.status_code == 404 and r.json()["title"] == "Not Found"


def test_unhandled_error_is_problem_json(inbox_request: dict[str, Any]) -> None:
    class Exploding:
        name, model = "x", "x"

        def is_configured(self) -> bool:
            return True

        async def complete_json(self, *a: Any, **k: Any) -> dict[str, Any]:
            raise RuntimeError("unexpected")

    c = TestClient(
        create_app(Settings(internal_api_key=INTERNAL_KEY), LLMRouter([Exploding()])),
        raise_server_exceptions=False,
    )
    r = c.post("/v1/extract", json=inbox_request, headers=AUTH)
    assert r.status_code == 500 and r.json()["title"] == "Internal error"
    assert "unexpected" not in r.text


# ---------------------------------------------------------------- Phase 2: providers, ask, failover


def test_providers_requires_key_and_matches_contract(client: TestClient) -> None:
    assert client.get("/v1/providers").status_code == 401
    r = client.get("/v1/providers", headers=AUTH)
    assert r.status_code == 200
    assert list(_validator("ProvidersResponse").iter_errors(r.json())) == []
    names = [p["name"] for p in r.json()["providers"]]
    assert names[-1] == "heuristic"
    assert [p["name"] for p in r.json()["providers"] if p["configured"]] == ["heuristic"]


def test_ask_endpoint(client: TestClient, inbox_request: dict[str, Any]) -> None:
    tasks = client.post("/v1/extract", json=inbox_request, headers=AUTH).json()["tasks"]
    body = {"user": inbox_request["user"], "question": "What do I owe Priya?", "tasks": tasks}
    r = client.post("/v1/ask", json=body, headers=AUTH)
    assert r.status_code == 200
    assert list(_validator("AskResponse").iter_errors(r.json())) == []
    assert r.json()["generated_by"] == "rules"
    assert r.json()["cited_task_ids"] == [t["id"] for t in tasks if t["email_id"] == "m1"]
    assert client.post("/v1/ask", json=body).status_code == 401


GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent"


@respx.mock
def test_gemini_429_fails_over_to_groq_end_to_end(
    inbox_request: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LLM_PROVIDERS", "gemini,groq,heuristic")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-gemini")
    monkeypatch.setenv("GROQ_API_KEY", "fake-groq")
    gemini = respx.post(GEMINI_URL).mock(
        return_value=httpx.Response(429, headers={"retry-after": "60"})
    )
    item = {
        "email_id": "m1",
        "title": "Send the deck to Priya",
        "type": "send",
        "due_phrase": "before the call on Tuesday",
        "due_iso_guess": "2026-10-20",
        "confidence": 0.9,
        "evidence": "Can you send the deck before the call on Tuesday?",
    }

    def groq_reply(request: httpx.Request) -> httpx.Response:
        prompt = json.loads(request.content)["messages"][1]["content"]
        if "<tasks>" in prompt:  # briefing call
            content = {"headline": "1 task today", "summary": "Review the board pack first."}
        else:
            content = {"items": [item] if 'id="m1"' in prompt else []}
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps(content)}}]}
        )

    groq = respx.post("https://api.groq.com/openai/v1/chat/completions").mock(
        side_effect=groq_reply
    )
    inbox_request["options"]["use_llm_briefing"] = True

    with TestClient(create_app(Settings(internal_api_key=INTERNAL_KEY))) as c:
        body = c.post("/v1/extract", json=inbox_request, headers=AUTH).json()
        status = {p["name"]: p for p in c.get("/v1/providers", headers=AUTH).json()["providers"]}

    assert gemini.call_count == 1  # circuit opened: the briefing call skipped gemini
    assert groq.call_count == 2
    (task,) = body["tasks"]
    assert task["extracted_by"] == "groq/llama-3.3-70b-versatile"
    assert task["date_source"] == "resolver" and task["due_date"] == "2026-10-20"
    extract = next(s for s in body["trace"] if s["step"] == "extract")
    assert extract["status"] == "degraded"
    assert extract["detail"] == "gemini rate-limited → groq"
    usage = {u["provider"]: u for u in body["provider_usage"]}
    assert usage["gemini"]["failures"] == 1 and usage["groq"]["failures"] == 0
    assert body["briefing"]["generated_by"] == "groq"
    assert status["gemini"]["circuit"] == "open" and status["groq"]["calls"] == 2
    assert list(_validator("ExtractResponse").iter_errors(body)) == []


def test_briefing_endpoint_covers_given_tasks(
    client: TestClient, inbox_request: dict[str, Any]
) -> None:
    tasks = client.post("/v1/extract", json=inbox_request, headers=AUTH).json()["tasks"]
    body = {"user": inbox_request["user"], "tasks": tasks, "options": {"use_llm_briefing": True}}
    assert list(_validator("BriefingRequest").iter_errors(body)) == []
    r = client.post("/v1/briefing", json=body, headers=AUTH)
    assert r.status_code == 200
    assert list(_validator("Briefing").iter_errors(r.json())) == []
    assert r.json()["counts"]["today"] == 1 and r.json()["generated_by"] == "template"
    assert client.post("/v1/briefing", json=body).status_code == 401
