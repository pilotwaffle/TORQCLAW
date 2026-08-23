"""Sanitized Agent Reach availability probe for gateway tier routing."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from typing import Any


CHANNELS = {
    "github", "twitter", "youtube", "reddit", "facebook", "instagram",
    "bilibili", "xiaohongshu", "linkedin", "xiaoyuzhou", "v2ex", "xueqiu",
    "rss", "exa_search", "web",
}
PROBE_TIMEOUT_SECONDS = 10


async def doctor() -> dict[str, Any]:
    executable = os.getenv("AGENT_REACH_CLI_PATH", "").strip() or shutil.which("agent-reach")
    if not executable:
        return {"ok": False, "channels": {}}
    try:
        process = await asyncio.create_subprocess_exec(
            executable,
            "doctor",
            "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(
            process.communicate(), timeout=PROBE_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        return {"ok": False, "channels": {}}
    except Exception:
        return {"ok": False, "channels": {}}
    if process.returncode != 0 or len(stdout) > 256_000:
        return {"ok": False, "channels": {}}
    try:
        raw = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"ok": False, "channels": {}}

    channels = {}
    for channel in CHANNELS:
        entry = raw.get(channel, {}) if isinstance(raw, dict) else {}
        active = entry.get("active_backend") if isinstance(entry, dict) else None
        channels[channel] = {
            "available": entry.get("status") == "ok" and isinstance(active, str) and bool(active),
            "activeBackend": active if isinstance(active, str) else None,
        }
    return {"ok": True, "channels": channels}
