"""Keep the Pydantic models and packages/contracts/extract.schema.json in lock-step."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from app import schemas
from tests.conftest import load_contract, load_fixture

MODELS: list[type[BaseModel]] = [
    schemas.UserContext,
    schemas.EmailInput,
    schemas.ExtractOptions,
    schemas.ExtractRequest,
    schemas.TaskSource,
    schemas.Task,
    schemas.SkippedEmail,
    schemas.TraceStep,
    schemas.ProviderUsage,
    schemas.BucketCounts,
    schemas.Briefing,
    schemas.ExtractResponse,
    schemas.LlmExtractionItem,
    schemas.LlmExtraction,
    schemas.AskRequest,
    schemas.AskResponse,
    schemas.ProviderStatus,
    schemas.ProvidersResponse,
    schemas.BriefingRequest,
    schemas.ProvidersRequest,
    schemas.ProviderTestRequest,
    schemas.ProviderTestResponse,
]


@pytest.mark.parametrize("model", MODELS, ids=lambda m: m.__name__)
def test_model_fields_match_contract(model: type[BaseModel]) -> None:
    definition = load_contract()["$defs"][model.__name__]
    assert set(model.model_fields) == set(definition["properties"])
    assert definition.get("additionalProperties") is False


def test_fixtures_parse_into_models() -> None:
    schemas.ExtractRequest.model_validate(load_fixture("extract.request.json"))
    schemas.ExtractResponse.model_validate(load_fixture("extract.response.json"))


def test_enums_match_contract() -> None:
    defs = load_contract()["$defs"]
    assert set(defs["TaskType"]["enum"]) == set(schemas.TaskType.__args__)
    assert set(defs["Bucket"]["enum"]) == set(schemas.Bucket.__args__)
    assert set(defs["Priority"]["enum"]) == set(schemas.Priority.__args__)
    assert set(defs["SkippedEmail"]["properties"]["reason"]["enum"]) == set(
        schemas.SkipReason.__args__
    )
    assert set(defs["TraceStep"]["properties"]["step"]["enum"]) == set(schemas.StepName.__args__)
