import asyncio
import json

from mcp_wrapper import server


def test_health_is_fixed_secret_free_stub(monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.setattr(server, "_get_hermes_available", lambda: False)

    assert server._health_payload() == {
        "service": "torqclaw-hermes-engine",
        "status": "ready",
        "mode": "stub",
        "modelConfigured": False,
        "hermesAvailable": False,
    }


def test_health_is_fixed_secret_free_live(monkeypatch):
    monkeypatch.setenv("HERMES_MODEL", "model-without-secret")
    monkeypatch.setenv("HERMES_API_KEY", "must-not-appear")
    monkeypatch.setattr(server, "_get_hermes_available", lambda: True)

    payload = server._health_payload()
    assert payload == {
        "service": "torqclaw-hermes-engine",
        "status": "ready",
        "mode": "live",
        "modelConfigured": True,
        "hermesAvailable": True,
    }
    assert "must-not-appear" not in json.dumps(payload)


def test_health_route_returns_json_contract(monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    monkeypatch.setattr(server, "_get_hermes_available", lambda: False)
    response = asyncio.run(server.health(None))
    assert response.status_code == 200
    assert json.loads(response.body) == server._health_payload()
