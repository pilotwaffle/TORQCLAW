"""Bounded, keyless web search using Hermes's canonical providers.

DuckDuckGo is the always-available fast path. An operator-configured SearXNG
instance is used only when DuckDuckGo fails. This module owns orchestration;
provider implementations remain vendored with Hermes.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any


VENDOR = Path(__file__).parents[1] / "vendor" / "hermes-agent"
MAX_QUERY_CHARS = 500
MAX_RESULTS = 10
BACKEND_TIMEOUT_SECONDS = 20
MAX_CLI_OUTPUT_BYTES = 256_000


def _ensure_vendor_importable() -> None:
    vendor = str(VENDOR)
    if vendor not in sys.path:
        sys.path.insert(0, vendor)


def _ddgs_provider():
    _ensure_vendor_importable()
    from plugins.web.ddgs.provider import DDGSWebSearchProvider

    return DDGSWebSearchProvider()


def _searxng_provider():
    _ensure_vendor_importable()
    from plugins.web.searxng.provider import SearXNGWebSearchProvider

    return SearXNGWebSearchProvider()


def _ddgs_cli_path() -> str | None:
    configured = os.getenv("DDGS_CLI_PATH", "").strip()
    if configured:
        return configured
    sibling = Path(sys.executable).with_name("ddgs.exe" if sys.platform == "win32" else "ddgs")
    if sibling.exists():
        return str(sibling)
    return shutil.which("ddgs")


def _validate(query: str, limit: int) -> tuple[str, int]:
    normalized = query.strip()
    if not normalized:
        raise ValueError("query must not be empty")
    if len(normalized) > MAX_QUERY_CHARS:
        raise ValueError(f"query must be at most {MAX_QUERY_CHARS} characters")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_RESULTS:
        raise ValueError(f"limit must be an integer from 1 to {MAX_RESULTS}")
    return normalized, limit


async def _call(provider: Any, query: str, limit: int) -> dict[str, Any]:
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(provider.search, query, limit),
            timeout=BACKEND_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        return {"success": False}
    except Exception:
        return {"success": False}
    return result if isinstance(result, dict) else {"success": False}


async def _search_ddgs_cli(query: str, limit: int) -> dict[str, Any]:
    executable = _ddgs_cli_path()
    if executable is None:
        return {"success": False}

    process = await asyncio.create_subprocess_exec(
        executable,
        "text",
        "-q",
        query,
        "-m",
        str(limit),
        "-o",
        "json",
        "--no-color",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _stderr = await asyncio.wait_for(
            process.communicate(), timeout=BACKEND_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        return {"success": False}
    if process.returncode != 0 or len(stdout) > MAX_CLI_OUTPUT_BYTES:
        return {"success": False}

    text = stdout.decode("utf-8", errors="replace").strip()
    try:
        decoded = json.loads(text)
        rows = decoded if isinstance(decoded, list) else [decoded]
    except json.JSONDecodeError:
        try:
            rows = [json.loads(line) for line in text.splitlines() if line.strip()]
        except json.JSONDecodeError:
            return {"success": False}

    web = []
    for position, row in enumerate(rows[:limit], start=1):
        if not isinstance(row, dict):
            continue
        web.append({
            "title": row.get("title", ""),
            "url": row.get("href") or row.get("url", ""),
            "description": row.get("body") or row.get("description", ""),
            "position": position,
        })
    return {"success": True, "data": {"web": web}}


def _bounded_success(backend: str, result: dict[str, Any], limit: int) -> dict[str, Any] | None:
    if result.get("success") is not True:
        return None
    raw = result.get("data", {}).get("web", [])
    if not isinstance(raw, list):
        return None

    web = []
    for position, item in enumerate(raw[:limit], start=1):
        if not isinstance(item, dict):
            continue
        web.append({
            "title": str(item.get("title", ""))[:500],
            "url": str(item.get("url", ""))[:2048],
            "description": str(item.get("description", ""))[:2000],
            "position": position,
        })
    return {"success": True, "backendUsed": backend, "data": {"web": web}}


async def search(query: str, limit: int = 5) -> dict[str, Any]:
    """Search via DDGS CLI, DDGS Python, then optional SearXNG."""
    query, limit = _validate(query, limit)

    cli_result = await _search_ddgs_cli(query, limit)
    success = _bounded_success("ddgs_cli", cli_result, limit)
    if success is not None:
        return success

    python_result = await _call(_ddgs_provider(), query, limit)
    success = _bounded_success("ddgs_python", python_result, limit)
    if success is not None:
        return success

    searxng = _searxng_provider()
    if os.getenv("SEARXNG_URL", "").strip() and searxng.is_available():
        searxng_result = await _call(searxng, query, limit)
        success = _bounded_success("searxng", searxng_result, limit)
        if success is not None:
            return success
        fallback = "failed"
    else:
        fallback = "not_configured"

    return {
        "success": False,
        "backendUsed": None,
        "error": "Keyless web search is temporarily unavailable.",
        "attempts": [
            {"backend": "ddgs_cli", "status": "failed"},
            {"backend": "ddgs_python", "status": "failed"},
            {"backend": "searxng", "status": fallback},
        ],
    }
