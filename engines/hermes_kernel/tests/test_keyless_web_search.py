import asyncio

import pytest

from mcp_wrapper import keyless_web_search as search


class FakeProvider:
    def __init__(self, result, *, available=True):
        self.result = result
        self.available = available
        self.calls = []

    def is_available(self):
        return self.available

    def search(self, query, limit):
        self.calls.append((query, limit))
        return self.result


def success_result(title="Result"):
    return {
        "success": True,
        "data": {"web": [{"title": title, "url": "https://example.com", "description": "Text"}]},
    }


def test_ddgs_cli_is_the_fast_path(monkeypatch):
    async def cli_search(_query, _limit):
        return success_result()

    ddgs = FakeProvider(success_result("Python"))
    searxng = FakeProvider(success_result("Fallback"))
    monkeypatch.setattr(search, "_search_ddgs_cli", cli_search)
    monkeypatch.setattr(search, "_ddgs_provider", lambda: ddgs)
    monkeypatch.setattr(search, "_searxng_provider", lambda: searxng)

    result = asyncio.run(search.search("torqclaw", 5))

    assert result["backendUsed"] == "ddgs_cli"
    assert ddgs.calls == []
    assert searxng.calls == []


def test_python_provider_is_used_after_cli_failure(monkeypatch):
    async def cli_search(_query, _limit):
        return {"success": False}

    ddgs = FakeProvider(success_result("Python"))
    searxng = FakeProvider(success_result("Fallback"))
    monkeypatch.setattr(search, "_search_ddgs_cli", cli_search)
    monkeypatch.setattr(search, "_ddgs_provider", lambda: ddgs)
    monkeypatch.setattr(search, "_searxng_provider", lambda: searxng)

    result = asyncio.run(search.search("torqclaw", 3))

    assert result["backendUsed"] == "ddgs_python"
    assert ddgs.calls == [("torqclaw", 3)]
    assert searxng.calls == []


def test_searxng_is_used_after_both_ddgs_paths_fail(monkeypatch):
    monkeypatch.setenv("SEARXNG_URL", "http://searxng.test")

    async def cli_search(_query, _limit):
        return {"success": False}

    ddgs = FakeProvider({"success": False})
    searxng = FakeProvider(success_result("Fallback"))
    monkeypatch.setattr(search, "_search_ddgs_cli", cli_search)
    monkeypatch.setattr(search, "_ddgs_provider", lambda: ddgs)
    monkeypatch.setattr(search, "_searxng_provider", lambda: searxng)

    result = asyncio.run(search.search("torqclaw", 3))

    assert result["backendUsed"] == "searxng"
    assert searxng.calls == [("torqclaw", 3)]


def test_total_failure_is_bounded_and_does_not_leak_provider_errors(monkeypatch):
    async def cli_search(_query, _limit):
        return {"success": False, "error": "secret cli detail"}

    ddgs = FakeProvider({"success": False, "error": "secret provider detail"})
    searxng = FakeProvider({"success": False}, available=False)
    monkeypatch.setattr(search, "_search_ddgs_cli", cli_search)
    monkeypatch.setattr(search, "_ddgs_provider", lambda: ddgs)
    monkeypatch.setattr(search, "_searxng_provider", lambda: searxng)

    result = asyncio.run(search.search("torqclaw"))

    assert result["success"] is False
    assert result["attempts"][2]["status"] == "not_configured"
    assert "secret cli detail" not in str(result)
    assert "secret provider detail" not in str(result)


@pytest.mark.parametrize("query,limit", [("", 5), ("x" * 501, 5), ("ok", 0), ("ok", 11)])
def test_input_bounds(query, limit):
    with pytest.raises(ValueError):
        asyncio.run(search.search(query, limit))
