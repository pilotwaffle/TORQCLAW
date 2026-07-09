"""Covers mcp_wrapper.contracts: GatewayRequest validation only (no other
schemas — GatewayEvent/ClientCommand/ConnectFrame fixtures belong to
10A/Epic 10, out of scope here). No env needed for this module."""
import copy
import json
from pathlib import Path

import jsonschema
import pytest

from mcp_wrapper import contracts

FIXTURE_PATH = (
    Path(__file__).resolve().parent / ".." / ".." / ".." / "tests" / "fixtures" / "gateway-request.json"
).resolve()


@pytest.fixture
def fixture() -> dict:
    with open(FIXTURE_PATH) as f:
        return json.load(f)


def test_fixture_path_exists():
    assert FIXTURE_PATH.exists(), f"fixture not found at {FIXTURE_PATH}"


def test_happy_path_fixture_validates(fixture):
    # Cross-language lock: this fixture is shared with the TS side. If schema
    # drift breaks this, it breaks the TS contract too.
    assert contracts.validate_gateway_request(fixture) is None


def test_missing_required_top_level_enrichment(fixture):
    bad = copy.deepcopy(fixture)
    del bad["enrichment"]
    with pytest.raises(jsonschema.exceptions.ValidationError):
        contracts.validate_gateway_request(bad)


def test_missing_payload_granted_tools(fixture):
    bad = copy.deepcopy(fixture)
    del bad["payload"]["grantedTools"]
    with pytest.raises(jsonschema.exceptions.ValidationError):
        contracts.validate_gateway_request(bad)


def test_invalid_task_type_enum(fixture):
    bad = copy.deepcopy(fixture)
    bad["payload"]["taskType"] = "NONSENSE"
    with pytest.raises(jsonschema.exceptions.ValidationError):
        contracts.validate_gateway_request(bad)


def test_additional_properties_rejected_in_constraints(fixture):
    bad = copy.deepcopy(fixture)
    bad["constraints"]["foo"] = 1
    with pytest.raises(jsonschema.exceptions.ValidationError):
        contracts.validate_gateway_request(bad)


def test_context_size_wrong_type(fixture):
    bad = copy.deepcopy(fixture)
    bad["payload"]["contextSize"] = "big"
    with pytest.raises(jsonschema.exceptions.ValidationError):
        contracts.validate_gateway_request(bad)


def test_execution_mode_invalid_enum(fixture):
    bad = copy.deepcopy(fixture)
    bad["constraints"]["executionMode"] = "REMOTE"
    with pytest.raises(jsonschema.exceptions.ValidationError):
        contracts.validate_gateway_request(bad)


def test_classifier_confidence_out_of_range(fixture):
    bad = copy.deepcopy(fixture)
    bad["enrichment"]["classifierConfidence"] = 1.5
    with pytest.raises(jsonschema.exceptions.ValidationError):
        contracts.validate_gateway_request(bad)


def test_id_not_a_uuid_rejected_by_pattern(fixture):
    bad = copy.deepcopy(fixture)
    bad["id"] = "not-a-uuid"
    with pytest.raises(jsonschema.exceptions.ValidationError):
        contracts.validate_gateway_request(bad)


def test_missing_schema_raises_runtime_error(monkeypatch, tmp_path):
    monkeypatch.setattr(contracts, "SCHEMA_DIR", tmp_path)
    with pytest.raises(RuntimeError, match="Missing contract schema"):
        contracts._load("GatewayRequest")
