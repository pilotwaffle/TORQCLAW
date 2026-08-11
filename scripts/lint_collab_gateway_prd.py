#!/usr/bin/env python3
"""Deterministic consistency pre-gate for PRD-TCLAW-COLLAB-GATEWAY-004.

Mirrors the house style of scripts/lint_collaboration_prd.py (Finding
dataclass, Gate.equal()/require(), boundary-aware literal matching, section
extraction, exit 0 on PASS / nonzero on any finding, --report artifact).

This implements EXACTLY the checks specified in
docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004.md §10 — no more, no less.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile

# Determinism: this gate must produce the same verdict regardless of the
# invoking shell's locale. On Windows the default stdio codec is cp1252, which
# cannot represent characters used in required literals (e.g. the set-membership
# symbol in the CT-2 clause); printing a finding then crashes, and locale-
# dependent decoding can otherwise turn a real PASS/FAIL into the opposite.
# Force UTF-8 on stdout/stderr so the linter's result never depends on ambient
# environment settings.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
from dataclasses import dataclass
from pathlib import Path
from typing import Any


BASELINE_REF = "af52430a0d719c449a9379866b84c154fc3c3b8a"
GATEWAY_SCHEMA_PATH = "packages/gateway/db/schema.sql"
COLLAB_MIGRATION_PATH = "packages/collab/src/migration.ts"
LEGACY_CHECK_COUNT = 67

R4_BLOCKS = (
    "BASELINE_STATE_DB_AF52430",
    "BASELINE_GATEWAY_SCHEMA_AF52430",
    "BASELINE_COLLAB_MIGRATION_DDL_AF52430",
    "BASELINE_OBJECT_EXPECTATIONS_V4",
    "STATE_DB_MAP_V4",
)

EXPECTED_COLUMNS = {
    "principals": [
        "id", "kind", "display_name", "owner_principal_id", "status",
        "auth_epoch", "revoked_at", "created_at", "updated_at",
    ],
    "sessions": [
        "id", "role", "client_name", "principal_id", "surface_id",
        "created_at", "last_active_at",
    ],
    "tasks": [
        "request_id", "session_id", "tier", "router_reason", "state",
        "request_json", "result", "error", "telemetry_json", "created_at",
        "finished_at",
    ],
    "tool_approvals": [
        "approval_id", "request_id", "tool_name", "args_json", "status",
        "created_at", "decided_at",
    ],
}

STATE_BASELINE_OBJECTS = {
    "sessions", "events", "tasks", "task_episodes", "task_search",
    "skill_queue", "tool_approvals", "run_receipts", "spend_ledger",
    "resilience_projection_cursor", "provider_attempt_projection",
    "failover_task_projection",
}
COLLAB_BASELINE_OBJECTS = {
    "principals", "principal_credentials", "collab_channels",
    "collab_members", "collab_events", "collab_cursors",
    "collab_mutation_results", "collab_session_bindings", "collab_audit",
    "collab_installation", "collab_schema_migrations",
}
EXPECTED_BASELINE_OBJECTS = STATE_BASELINE_OBJECTS | COLLAB_BASELINE_OBJECTS
C01_AUTH_TABLES = {
    "principal_credentials", "collab_session_bindings",
    "collab_installation", "collab_schema_migrations",
}

TOOL_APPROVAL_ADDITIONS = (
    "origin_principal_id",
    "origin_surface_id",
    "decided_principal_id",
    "decided_surface_id",
    "expires_at",
    "context_hash",
)
TOOL_APPROVAL_ADDITION_TYPES = {
    "origin_principal_id": "TEXT",
    "origin_surface_id": "TEXT",
    "decided_principal_id": "TEXT",
    "decided_surface_id": "TEXT",
    "expires_at": "DATETIME",
    "context_hash": "TEXT",
}
STATE_ADDITIVE_OBJECTS = {
    "gateway_surface_security", "surface_authorities",
    "gateway_approval_bindings", "gateway_approval_payloads",
    "gateway_action_grants", "approval_deliveries",
}
COLLAB_ADDITIVE_OBJECTS = {"surfaces", "surface_credentials"}
CTXHASH_FIELDS = (
    "Principal identity",
    "Surface identity",
    "Task identity",
    "Task origin",
    "Resolved execution profile",
    "Requested capability / tool",
    "Canonical tool arguments",
    "Privacy / security context",
    "Routing / tier context",
    "Relevant policy revision",
)


@dataclass
class Finding:
    check: str
    detail: str


class Gate:
    def __init__(self) -> None:
        self.findings: list[Finding] = []
        self.passed: list[str] = []

    def equal(self, name: str, actual: set[str], expected: set[str]) -> None:
        if actual == expected:
            self.passed.append(name)
            return
        self.findings.append(Finding(
            name,
            f"missing={sorted(expected - actual) or '[]'} "
            f"extra={sorted(actual - expected) or '[]'}",
        ))

    def require(self, name: str, condition: bool, detail: str) -> None:
        if condition:
            self.passed.append(name)
        else:
            self.findings.append(Finding(name, detail))


def section(text: str, heading: str, level: int = 2) -> str:
    """Extract the body of a `## N. Heading` (or `### N.N Heading`) section,
    stopping at the next heading of the same or shallower level."""
    marker_re = re.compile(rf"^#{{{level}}}\s+{re.escape(heading)}", re.MULTILINE)
    match = marker_re.search(text)
    if not match:
        raise ValueError(f"missing section: {heading}")
    body_start = text.find("\n", match.start()) + 1
    next_heading = re.search(rf"^#{{1,{level}}}\s+", text[body_start:], re.MULTILINE)
    end = body_start + next_heading.start() if next_heading else len(text)
    return text[body_start:end]


def boundary_pattern(literal: str) -> str:
    """Boundary-aware literal match: a word-shaped literal must not match as
    a substring of a longer token (e.g. 'expired' inside 'unexpired')."""
    return r"(?<![\w])" + re.escape(literal) + r"(?![\w])"


def contains(text: str, literal: str) -> bool:
    return re.search(boundary_pattern(literal), text) is not None


def count(text: str, literal: str) -> int:
    return len(re.findall(boundary_pattern(literal), text))


def find_positions(text: str, literal: str) -> list[int]:
    return [m.start() for m in re.finditer(boundary_pattern(literal), text)]


def near_negation(text: str, pos: int, window: int = 80) -> bool:
    """True if a negation word appears within `window` chars before the
    match at `pos`, WITHIN THE SAME PARAGRAPH/LINE-GROUP (same clause-local
    heuristic: negations that forbid a phrase normally precede it — 'must
    not offer', 'No', 'never'). The search window is clipped at the nearest
    blank-line paragraph break so a negation word from an unrelated,
    preceding heading or paragraph (e.g. a heading like "...and what it
    does not)" immediately before an unrelated sentence) cannot bleed in
    and produce a false negative."""
    start = max(0, pos - window)
    ctx = text[start:pos]
    para_break = ctx.rfind("\n\n")
    if para_break != -1:
        ctx = ctx[para_break + 2:]
    # Also don't cross a markdown heading line within the clipped window.
    heading_break = None
    for m in re.finditer(r"^#{1,6}\s.*$", ctx, re.MULTILINE):
        heading_break = m.end()
    if heading_break is not None:
        ctx = ctx[heading_break:]
    negations = (
        r"\bno\b", r"\bnot\b", r"\bnever\b", r"must not\b", r"n't\b",
        r"forbid", r"forbidden", r"prohibit", r"disallow", r"refuse",
    )
    return any(re.search(pat, ctx, re.IGNORECASE) for pat in negations)


def _stable_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _stable_value(value[key]) for key in sorted(value, key=str)}
    if isinstance(value, (set, frozenset)):
        return [_stable_value(item) for item in sorted(value, key=repr)]
    if isinstance(value, (list, tuple)):
        return [_stable_value(item) for item in value]
    return value


def _stable_repr(value: Any) -> str:
    return json.dumps(
        _stable_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _same(gate: Gate, name: str, actual: Any, expected: Any) -> bool:
    return gate.require(
        name,
        actual == expected,
        f"expected={_stable_repr(expected)} actual={_stable_repr(actual)}",
    )


def _marker_pattern(marker: str, *, consumes_newline: bool) -> re.Pattern[bytes]:
    suffix = rb"\r?\n" if consumes_newline else rb"\r?(?=\n|\Z)"
    return re.compile(rb"(?m)^" + re.escape(marker.encode("ascii")) + suffix)


def _extract_block(data: bytes, name: str) -> bytes:
    """Return the bytes between one standalone NAME_BEGIN/NAME_END pair."""
    begins = list(_marker_pattern(name + "_BEGIN", consumes_newline=True).finditer(data))
    ends = list(_marker_pattern(name + "_END", consumes_newline=False).finditer(data))
    if len(begins) != 1 or len(ends) != 1:
        raise ValueError(
            f"{name} must have exactly one BEGIN and END marker "
            f"(found {len(begins)} BEGIN, {len(ends)} END)"
        )
    if begins[0].end() > ends[0].start():
        raise ValueError(f"{name} END precedes BEGIN")
    return data[begins[0].end():ends[0].start()]


def _validate_marker_nesting(data: bytes) -> tuple[bool, str]:
    token_re = re.compile(rb"(?m)^([A-Z][A-Z0-9_]+_(?:BEGIN|END))\r?(?=\n|\Z)")
    stack: list[str] = []
    counts: dict[str, list[int]] = {}
    for match in token_re.finditer(data):
        token = match.group(1).decode("ascii")
        base, kind = token.rsplit("_", 1)
        counts.setdefault(base, [0, 0])[kind == "END"] += 1
        if kind == "BEGIN":
            stack.append(base)
        elif not stack or stack.pop() != base:
            return False, f"misnested marker: {token}"
    bad_counts = sorted(
        f"{base}:{begin}/{end}"
        for base, (begin, end) in counts.items()
        if begin != 1 or end != 1
    )
    if stack:
        return False, f"unclosed markers: {stack}"
    if bad_counts:
        return False, f"marker counts must be 1/1: {bad_counts}"
    return True, f"validated {len(counts)} marker pairs"


def _git_bytes(repo: Path, path: str) -> bytes:
    completed = subprocess.run(
        ["git", "show", f"{BASELINE_REF}:{path}"],
        cwd=repo,
        capture_output=True,
        shell=False,
        timeout=30,
        check=False,
    )
    if completed.returncode:
        error = completed.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"git show failed for {path}: {error}")
    return completed.stdout


def _collab_ddl(source: bytes) -> bytes:
    # The spaces before the closing backtick are real template bytes and are
    # intentionally part of the pin even though SQLite ignores them.
    match = re.search(rb"db\.exec\(`(.*?)`\);", source, re.DOTALL)
    if not match:
        raise ValueError("collaboration migration db.exec template was not found")
    return match.group(1)


def _remove_marker_separator(data: bytes) -> bytes:
    """Remove the one newline added solely to put an END marker on its own line."""
    if data.endswith(b"\r\n"):
        return data[:-2]
    if data.endswith(b"\n"):
        return data[:-1]
    return data


def _worktree_text_to_git_bytes(data: bytes) -> bytes:
    """Undo Git's configured CRLF checkout transport for a blob comparison.

    ``git show`` returns the raw LF blob while this Windows checkout uses
    ``core.autocrlf=true``.  Normalizing CRLF is therefore transport removal,
    not content normalization: lone CR bytes remain and make the pin fail.
    """
    return data.replace(b"\r\n", b"\n")


def _byte_difference(actual: bytes, expected: bytes) -> str:
    limit = min(len(actual), len(expected))
    offset = next(
        (index for index in range(limit) if actual[index] != expected[index]),
        limit,
    )
    return (
        f"first_diff={offset} actual_len={len(actual)} expected_len={len(expected)} "
        f"actual_sha256={hashlib.sha256(actual).hexdigest()} "
        f"expected_sha256={hashlib.sha256(expected).hexdigest()}"
    )


def _json_block(gate: Gate, blocks: dict[str, bytes], name: str) -> dict[str, Any] | None:
    raw = blocks.get(name)
    if raw is None:
        return None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        gate.require(f"R4 JSON: {name}", False, f"invalid UTF-8 JSON: {exc}")
        return None
    if not isinstance(value, dict):
        gate.require(f"R4 JSON: {name}", False, "top-level JSON value must be an object")
        return None
    gate.require(f"R4 JSON: {name}", True, "")
    return value


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    escaped = table.replace('"', '""')
    return [str(row[1]) for row in conn.execute(f'PRAGMA table_info("{escaped}")')]


def _declared_names(ddl: bytes, kind: str) -> set[str]:
    if kind == "index":
        pattern = (
            rb"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"
            rb"([A-Za-z_][A-Za-z0-9_]*)"
        )
    else:
        pattern = (
            rb"CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?"
            rb"([A-Za-z_][A-Za-z0-9_]*)"
        )
    return {
        match.decode("ascii")
        for match in re.findall(pattern, ddl, re.IGNORECASE)
    }


def _sqlite_objects(conn: sqlite3.Connection) -> dict[str, str]:
    return {
        str(name): str(kind)
        for kind, name in conn.execute(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
        )
    }


def _paragraph_with(text: str, terms: tuple[str, ...]) -> bool:
    folded_terms = tuple(term.casefold() for term in terms)
    return any(
        all(term in paragraph.casefold() for term in folded_terms)
        for paragraph in re.split(r"\n\s*\n", text)
    )


def _without_block(data: bytes, name: str) -> str:
    begin = _marker_pattern(name + "_BEGIN", consumes_newline=True).search(data)
    end = _marker_pattern(name + "_END", consumes_newline=False).search(data)
    if not begin or not end or begin.end() > end.start():
        return data.decode("utf-8")
    return (data[:begin.start()] + data[end.end():]).decode("utf-8")


def _table_body(text: str, table: str) -> str:
    match = re.search(
        rf"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{re.escape(table)}\s*\((.*?)\n\);",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    return match.group(1) if match else ""


def _validate_expectations(gate: Gate, value: dict[str, Any] | None) -> None:
    if value is None:
        return
    _same(gate, "R4 expectations: baseline_ref", value.get("baseline_ref"), BASELINE_REF)
    for table, expected in EXPECTED_COLUMNS.items():
        _same(gate, f"R4 expectations: {table} columns", value.get(table), expected)
    _same(
        gate,
        "R4 expectations: events FK",
        value.get("events_fk"),
        ["session_id -> sessions(id)"],
    )
    _same(
        gate,
        "R4 expectations: required baseline objects",
        set(value.get("required_baseline_objects", [])),
        EXPECTED_BASELINE_OBJECTS,
    )
    _same(
        gate,
        "R4 expectations: C0.1 auth tables",
        set(value.get("c01_auth_tables", [])),
        C01_AUTH_TABLES,
    )


def _validate_physical_map(gate: Gate, value: dict[str, Any] | None) -> None:
    if value is None:
        return
    _same(
        gate,
        "R4 map: top-level entries",
        set(value),
        {
            "baseline_ref", "physical_databases", "state.db", "collab.db",
            "cross_database_protocol", "unrelated_objects",
        },
    )
    _same(gate, "R4 map: baseline_ref", value.get("baseline_ref"), BASELINE_REF)
    _same(
        gate,
        "R4 map: physical databases",
        value.get("physical_databases"),
        {"state.db": GATEWAY_SCHEMA_PATH, "collab.db": COLLAB_MIGRATION_PATH},
    )

    state = value.get("state.db")
    gate.require("R4 map: state.db object", isinstance(state, dict), "state.db must be an object")
    if not isinstance(state, dict):
        state = {}
    _same(
        gate,
        "R4 map: state.db entries",
        set(state),
        {
            "sessions", "events", "tasks", "skill_queue", "tool_approvals",
            "new_additive_objects",
        },
    )
    _same(gate, "R4 map: sessions preserved", state.get("sessions"), {
        "target": "sessions", "key": "id", "action": "unchanged", "data": "preserve",
    })
    _same(gate, "R4 map: events preserved", state.get("events"), {
        "target": "events", "key": "seq", "fk": "session_id -> sessions(id)",
        "action": "unchanged", "data": "preserve",
    })
    _same(gate, "R4 map: tasks preserved", state.get("tasks"), {
        "target": "tasks", "key": "request_id", "action": "unchanged", "data": "preserve",
    })
    _same(gate, "R4 map: skill_queue no-touch", state.get("skill_queue"), {
        "target": "skill_queue", "action": "unchanged", "schema": "preserve",
        "data": "preserve", "runtime": "out of scope",
    })
    approvals = state.get("tool_approvals")
    gate.require(
        "R4 map: tool_approvals additive preservation",
        isinstance(approvals, dict)
        and approvals.get("target") == "tool_approvals"
        and approvals.get("action") == "extend additive"
        and approvals.get("preserve") == [
            "table", "rowid", "every original column", "every original row",
            "args_json", "status",
        ]
        and approvals.get("guarded_nullable_columns") == list(TOOL_APPROVAL_ADDITIONS)
        and approvals.get("canonical_approval_state") is True,
        "tool_approvals must be extended additively with exact row/value/rowid preservation and six nullable columns",
    )
    _same(
        gate,
        "R4 map: state.db additive objects",
        set(state.get("new_additive_objects", [])),
        STATE_ADDITIVE_OBJECTS,
    )
    gate.require(
        "R4 map: no gateway_approval_events reducer",
        "gateway_approval_events" not in state.get("new_additive_objects", []),
        "gateway_approval_events must not be a state/reducer sidecar",
    )

    collab = value.get("collab.db")
    gate.require("R4 map: collab.db object", isinstance(collab, dict), "collab.db must be an object")
    if not isinstance(collab, dict):
        collab = {}
    _same(
        gate,
        "R4 map: collab.db entries",
        set(collab),
        {"principals", "c01_auth", "new_additive_objects"},
    )
    _same(gate, "R4 map: principals preserved", collab.get("principals"), {
        "target": "principals", "action": "unchanged", "columns": "verbatim",
        "data": "preserve",
    })
    c01 = collab.get("c01_auth")
    gate.require(
        "R4 map: live C0.1 and collab.db preserved",
        isinstance(c01, dict)
        and set(c01.get("source", [])) == C01_AUTH_TABLES
        and c01.get("action") == "unchanged"
        and c01.get("live_names") == "preserved"
        and c01.get("data") == "preserve"
        and c01.get("flag_off") == "legacy path byte-identical",
        "C0.1 tables/live names/data and the flag-off legacy path must remain in collab.db",
    )
    _same(
        gate,
        "R4 map: collab.db additive objects",
        set(collab.get("new_additive_objects", [])),
        COLLAB_ADDITIVE_OBJECTS,
    )
    _same(
        gate,
        "R4 map: fail-closed cross-database protocol",
        value.get("cross_database_protocol"),
        {
            "unification": "forbidden",
            "grant_order": "collab identity commit then state authority activation",
            "revoke_order": "state deny or epoch commit then collab identity revocation",
            "failure_bias": "deny",
            "automatic_reverse_copy": "forbidden",
        },
    )
    _same(gate, "R4 map: unrelated objects preserved", value.get("unrelated_objects"), {
        "action": "unchanged", "schema": "preserve", "data": "preserve",
    })


def _extract_tool_approval_alters(text: str) -> list[dict[str, str]]:
    pattern = re.compile(
        r"ALTER\s+TABLE\s+tool_approvals\s+ADD\s+COLUMN\s+"
        r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+"
        r"(?P<type>TEXT|DATETIME)(?P<tail>[^`\r\n;]*)",
        re.IGNORECASE,
    )
    return [
        {
            "name": match.group("name"),
            "type": match.group("type").upper(),
            "tail": match.group("tail").strip(),
            "sql": match.group(0).strip(),
        }
        for match in pattern.finditer(text)
    ]


def _validate_migration_contract(
    gate: Gate,
    text: str,
    state_map: dict[str, Any] | None,
) -> list[dict[str, str]]:
    additions = _extract_tool_approval_alters(text)
    _same(
        gate,
        "R4 migration: exactly six ALTER columns in canonical order",
        [item["name"] for item in additions],
        list(TOOL_APPROVAL_ADDITIONS),
    )
    _same(
        gate,
        "R4 migration: exact nullable column types",
        {item["name"]: item["type"] for item in additions},
        TOOL_APPROVAL_ADDITION_TYPES,
    )
    gate.require(
        "R4 migration: additions have no constraints or defaults",
        len(additions) == len(TOOL_APPROVAL_ADDITIONS)
        and all(not item["tail"] for item in additions),
        "all six added columns must remain nullable (no NOT NULL/default/check/reference/unique tail)",
    )
    guard_names = re.findall(
        r"add\(\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\s*,\s*`ALTER\s+TABLE\s+"
        r"tool_approvals\s+ADD\s+COLUMN\s+[A-Za-z_][A-Za-z0-9_]*\s+(?:TEXT|DATETIME)`\s*\)",
        text,
        re.IGNORECASE,
    )
    _same(
        gate,
        "R4 migration: every ALTER uses the named guard",
        guard_names,
        list(TOOL_APPROVAL_ADDITIONS),
    )
    gate.require(
        "R4 migration: PRAGMA table_info guard",
        bool(re.search(r"PRAGMA\s+table_info\(tool_approvals\)", text, re.IGNORECASE))
        and bool(re.search(r"!\s*cols\.some\s*\(", text))
        and bool(re.search(r"db\.exec\(ddl\)", text)),
        "the six ALTERs need a per-column PRAGMA table_info absence guard",
    )

    before_s9 = text.split("## 9. Explicitly OUT OF SCOPE", 1)[0]
    map_text = _stable_repr(state_map or {})
    proposed = before_s9 + "\n" + map_text
    dangerous_patterns = {
        "table rebuild/rename": r"ALTER\s+TABLE\s+tool_approvals\s+RENAME|CREATE\s+TABLE\s+tool_approvals_v\w*",
        "table drop": r"DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?tool_approvals",
        "history copy/rewrite": r"INSERT\s+INTO\s+tool_approvals\b[\s\S]{0,300}\bSELECT\b|UPDATE\s+tool_approvals\s+SET\s+args_json",
        "legacy redaction sentinel": r"REDACTED_LEGACY_ARGS_V4",
    }
    found_dangerous = [
        name for name, pattern in dangerous_patterns.items()
        if re.search(pattern, proposed, re.IGNORECASE)
    ]
    gate.require(
        "R4 migration: no rebuild/sentinel/history rewrite",
        not found_dangerous,
        f"proposal-level destructive approval migration patterns: {found_dangerous}",
    )
    gate.require(
        "R4 migration: no gateway_approval_events table/reducer",
        not re.search(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?gateway_approval_events\b",
            text,
            re.IGNORECASE,
        ),
        "gateway_approval_events would be a second lifecycle reducer",
    )
    return additions


def _validate_sqlite_fixtures(
    gate: Gate,
    gateway_ddl: bytes,
    collab_ddl: bytes,
    expectations: dict[str, Any],
    additions: list[dict[str, str]],
) -> None:
    """Execute source-pinned DDL in two real, disposable SQLite files.

    The target ALTER model is applied only to the gateway fixture.  A seeded
    approval and skill draft make row/value/rowid preservation observable
    instead of merely asserted in prose.
    """
    try:
        with tempfile.TemporaryDirectory(prefix="torqclaw-prd004-r4-") as tmp:
            state_path = Path(tmp) / "state.db"
            collab_path = Path(tmp) / "collab.db"
            with sqlite3.connect(state_path) as state, sqlite3.connect(collab_path) as collab:
                state.executescript(gateway_ddl.decode("utf-8"))
                collab.executescript(collab_ddl.decode("utf-8"))

                state_objects = _sqlite_objects(state)
                collab_objects = _sqlite_objects(collab)
                gate.require(
                    "R4 SQLite state.db: required baseline objects",
                    STATE_BASELINE_OBJECTS <= set(state_objects),
                    f"missing={sorted(STATE_BASELINE_OBJECTS - set(state_objects))}",
                )
                gate.require(
                    "R4 SQLite collab.db: required baseline objects",
                    COLLAB_BASELINE_OBJECTS <= set(collab_objects),
                    f"missing={sorted(COLLAB_BASELINE_OBJECTS - set(collab_objects))}",
                )
                gate.require(
                    "R4 SQLite: physical database separation",
                    "principals" not in state_objects
                    and "sessions" not in collab_objects
                    and state_path != collab_path,
                    "collab principals or gateway sessions appeared in the wrong physical database",
                )

                for table in ("sessions", "tasks", "tool_approvals"):
                    _same(
                        gate,
                        f"R4 SQLite state.db columns: {table}",
                        _columns(state, table),
                        EXPECTED_COLUMNS[table],
                    )
                _same(
                    gate,
                    "R4 SQLite collab.db columns: principals",
                    _columns(collab, "principals"),
                    EXPECTED_COLUMNS["principals"],
                )
                event_fks = {
                    f"{row[3]} -> {row[2]}({row[4]})"
                    for row in state.execute('PRAGMA foreign_key_list("events")')
                }
                _same(
                    gate,
                    "R4 SQLite state.db FK: events",
                    event_fks,
                    set(expectations.get("events_fk", [])),
                )

                for database, ddl, conn, objects in (
                    ("state.db", gateway_ddl, state, state_objects),
                    ("collab.db", collab_ddl, collab, collab_objects),
                ):
                    declared_indexes = _declared_names(ddl, "index")
                    installed_indexes = {
                        name for name, kind in objects.items() if kind == "index"
                    }
                    gate.require(
                        f"R4 SQLite {database}: declared indexes installed",
                        declared_indexes <= installed_indexes,
                        f"missing={sorted(declared_indexes - installed_indexes)}",
                    )
                    declared_triggers = _declared_names(ddl, "trigger")
                    installed_triggers = {
                        name for name, kind in objects.items() if kind == "trigger"
                    }
                    _same(
                        gate,
                        f"R4 SQLite {database}: declared triggers installed",
                        installed_triggers,
                        declared_triggers,
                    )
                    _same(
                        gate,
                        f"R4 SQLite {database}: foreign_key_check",
                        list(conn.execute("PRAGMA foreign_key_check")),
                        [],
                    )

                migration_ready = (
                    [item["name"] for item in additions]
                    == list(TOOL_APPROVAL_ADDITIONS)
                    and all(not item["tail"] for item in additions)
                )
                if migration_ready:
                    approval = (
                        "approval-r4", "request-r4", "mcp__safe__write",
                        '{"canary":"keep-verbatim"}', "pending",
                        "2026-08-11T00:00:00Z", None,
                    )
                    skill = (
                        "skill-r4", "keep-name", "# keep markdown", "task-r4",
                        "pending", "2026-08-11T00:00:00Z", None,
                    )
                    state.execute(
                        "INSERT INTO tool_approvals "
                        "(approval_id,request_id,tool_name,args_json,status,created_at,decided_at) "
                        "VALUES (?,?,?,?,?,?,?)",
                        approval,
                    )
                    state.execute(
                        "INSERT INTO skill_queue "
                        "(queue_id,proposed_name,skill_markdown,source_task_id,status,created_at,decided_at) "
                        "VALUES (?,?,?,?,?,?,?)",
                        skill,
                    )
                    approval_before = state.execute(
                        "SELECT rowid,* FROM tool_approvals WHERE approval_id=?",
                        (approval[0],),
                    ).fetchone()
                    skill_before = state.execute(
                        "SELECT rowid,* FROM skill_queue WHERE queue_id=?",
                        (skill[0],),
                    ).fetchone()
                    for item in additions:
                        existing = set(_columns(state, "tool_approvals"))
                        if item["name"] not in existing:
                            state.execute(item["sql"])
                    first_manifest = list(state.execute('PRAGMA table_info("tool_approvals")'))
                    # A second guarded pass must be a complete no-op.
                    for item in additions:
                        existing = set(_columns(state, "tool_approvals"))
                        if item["name"] not in existing:
                            state.execute(item["sql"])
                    second_manifest = list(state.execute('PRAGMA table_info("tool_approvals")'))

                    approval_after = state.execute(
                        "SELECT rowid," + ",".join(EXPECTED_COLUMNS["tool_approvals"])
                        + " FROM tool_approvals WHERE approval_id=?",
                        (approval[0],),
                    ).fetchone()
                    skill_after = state.execute(
                        "SELECT rowid,* FROM skill_queue WHERE queue_id=?",
                        (skill[0],),
                    ).fetchone()
                    added_info = {
                        str(row[1]): row
                        for row in state.execute('PRAGMA table_info("tool_approvals")')
                        if str(row[1]) in TOOL_APPROVAL_ADDITIONS
                    }
                    added_values = state.execute(
                        "SELECT " + ",".join(TOOL_APPROVAL_ADDITIONS)
                        + " FROM tool_approvals WHERE approval_id=?",
                        (approval[0],),
                    ).fetchone()
                    _same(
                        gate,
                        "R4 SQLite migration model: original approval row/value/rowid preserved",
                        approval_after,
                        approval_before,
                    )
                    _same(
                        gate,
                        "R4 SQLite migration model: skill_queue row/value/rowid preserved",
                        skill_after,
                        skill_before,
                    )
                    gate.require(
                        "R4 SQLite migration model: six additions are physically nullable",
                        set(added_info) == set(TOOL_APPROVAL_ADDITIONS)
                        and all(row[3] == 0 and row[4] is None for row in added_info.values())
                        and added_values == (None,) * len(TOOL_APPROVAL_ADDITIONS),
                        "legacy row did not retain NULL in every constraint-free added column",
                    )
                    _same(
                        gate,
                        "R4 SQLite migration model: guarded repeat is no-op",
                        second_manifest,
                        first_manifest,
                    )
                else:
                    gate.require(
                        "R4 SQLite migration model: six guarded additive ALTERs execute",
                        False,
                        "skipped because the six exact constraint-free ALTERs were not present",
                    )
    except (OSError, UnicodeDecodeError, sqlite3.Error) as exc:
        gate.require("R4 SQLite: execute separate pinned baseline DDL", False, str(exc))
    else:
        gate.require("R4 SQLite: execute separate pinned baseline DDL", True, "")


def _validate_identity_and_authority(gate: Gate, text: str) -> None:
    surfaces = _table_body(text, "surfaces")
    credentials = _table_body(text, "surface_credentials")
    gate.require(
        "R4 identity: globally unique surface_id",
        bool(re.search(r"(?m)^\s*surface_id\s+TEXT\s+PRIMARY\s+KEY\b", surfaces, re.IGNORECASE))
        and _paragraph_with(text, ("global", "surface", "unique")),
        "surfaces.surface_id must be the global primary key and described as globally unique",
    )
    gate.require(
        "R4 identity: globally unique credential_id",
        bool(re.search(r"(?m)^\s*credential_id\s+TEXT\s+PRIMARY\s+KEY\b", credentials, re.IGNORECASE))
        and _paragraph_with(text, ("global", "credential", "unique")),
        "surface_credentials.credential_id must be the global primary key",
    )
    gate.require(
        "R4 identity: globally unique secret_hmac",
        bool(re.search(r"(?m)^\s*secret_hmac\s+\w+[^\n]*\bUNIQUE\b", credentials, re.IGNORECASE))
        and _paragraph_with(text, ("HMAC", "unique")),
        "surface credential HMAC must be globally unique in durable DDL",
    )
    gate.require(
        "R4 identity: credential references one surface",
        bool(re.search(
            r"(?m)^\s*surface_id\s+TEXT\s+NOT\s+NULL[^\n]*REFERENCES\s+surfaces\s*\(\s*surface_id\s*\)",
            credentials,
            re.IGNORECASE,
        ))
        or bool(re.search(
            r"FOREIGN\s+KEY\s*\(\s*surface_id\s*\)\s*REFERENCES\s+surfaces\s*\(\s*surface_id\s*\)",
            credentials,
            re.IGNORECASE,
        )),
        "surface_credentials.surface_id must reference the globally keyed surface",
    )
    gate.require(
        "R4 authority: state-owned effective capability/profile revision",
        any(
            all(term in paragraph.casefold() for term in (
                "state.db", "effective", "capability", "profile", "revision",
            ))
            for paragraph in re.split(r"\n\s*\n", text)
        ),
        "state.db must own the effective capability/profile revision used at decision/dispatch",
    )
    gate.require(
        "R4 authority: Origin independent of Authority",
        "Origin independent of Authority" in text
        or _paragraph_with(text, ("origin", "not", "decision authority")),
        "origin evidence must be explicitly independent from decision authority",
    )
    gate.require(
        "R4 authority: different-origin authorized operator positive path",
        _paragraph_with(text, ("different origin", "operator", "allowed"))
        or _paragraph_with(text, ("different-origin", "operator", "positive")),
        "must include an allowed different-origin independently authorized operator path",
    )
    gate.require(
        "R4 authority: live operator-kind approve plus resource authz",
        any(
            all(term in paragraph.casefold() for term in (
                "operator-kind", "live", "approve", "authz",
            ))
            and ("resource" in paragraph.casefold() or "task" in paragraph.casefold())
            for paragraph in re.split(r"\n\s*\n", text)
        ),
        "decision predicate needs operator-kind, a live approve row, and resource/task authz",
    )
    gate.require(
        "R4 authority: channel and automation decision path denied",
        any(
            "channel" in paragraph.casefold()
            and "automation" in paragraph.casefold()
            and ("denied" in paragraph.casefold() or "no " in paragraph.casefold())
            and "decid" in paragraph.casefold()
            for paragraph in re.split(r"\n\s*\n", text)
        ),
        "channel/automation surfaces must have no approval decision path",
    )


def _validate_approval_state(gate: Gate, text: str) -> None:
    gate.require(
        "R4 approval: canonical state and one centralized writer",
        _paragraph_with(text, ("tool_approvals", "canonical", "one centralized writer"))
        or _paragraph_with(text, ("tool_approvals", "canonical", "one gateway transition writer")),
        "tool_approvals.status must remain canonical under one centralized transition writer",
    )
    gate.require(
        "R4 approval: no sidecar status/transition authority",
        _paragraph_with(text, ("sidecar", "no", "approval state"))
        or _paragraph_with(text, ("sidecar", "cannot transition", "approval state")),
        "sidecars must not carry or reduce canonical approval state",
    )
    gate.require(
        "R4 approval: pending decider/context nullability",
        any(
            "pending" in paragraph.casefold()
            and "decided_*" in paragraph
            and "context_hash" in paragraph
            and "null" in paragraph.casefold()
            and ("no fabricated" in paragraph.casefold() or "remain null" in paragraph.casefold())
            for paragraph in re.split(r"\n\s*\n", text)
        ),
        "pending rows must not fabricate decided_* or context_hash evidence",
    )
    gate.require(
        "R4 approval: expiry uses canonical pending guard",
        bool(re.search(
            r"WHERE\s+status\s*=\s*['\"]pending['\"]\s+AND\s+expires_at\s*<=\s*now",
            text,
            re.IGNORECASE,
        )),
        "expiry needs UPDATE ... WHERE status='pending' AND expires_at<=now",
    )
    gate.require(
        "R4 approval: expiry/decision race first-writer-wins",
        any(
            "expir" in paragraph.casefold()
            and "decision" in paragraph.casefold()
            and "serializ" in paragraph.casefold()
            and ("wins" in paragraph.casefold() or "commits first" in paragraph.casefold())
            for paragraph in re.split(r"\n\s*\n", text)
        ),
        "expiry and decision must race through the same canonical serialization boundary",
    )
    gate.require(
        "R4 approval: exact grant consumed in dispatch interval",
        _paragraph_with(text, ("exact", "grant", "consum", "state.db", "dispatch")),
        "one exact grant must be consumed with the state.db dispatch admission check",
    )


def _validate_cross_database_protocol(gate: Gate, text: str) -> None:
    gate.require(
        "R4 cross-DB: no atomicity/unification claim",
        _paragraph_with(text, ("cross-database", "never", "transaction"))
        or _paragraph_with(text, ("cannot", "cross-database", "atomic")),
        "the design must not claim an atomic transaction across state.db and collab.db",
    )
    gate.require(
        "R4 cross-DB: grant-last",
        "grant-last" in text.casefold()
        and _paragraph_with(text, ("collab", "first", "gateway", "last")),
        "provisioning must commit collab identity first and gateway authority last",
    )
    gate.require(
        "R4 cross-DB: deny-first",
        "deny-first" in text.casefold()
        and _paragraph_with(text, ("gateway", "deny", "first", "collab")),
        "revocation must commit gateway deny/epoch first and collab history second",
    )


def _validate_ctxhash(gate: Gate, text: str) -> None:
    try:
        inputs = section(
            text,
            "3.4.1 Canonical `context_hash` input set (FROZEN, normative — clears C-2, closes OQ-4)",
            level=4,
        )
    except ValueError:
        inputs = ""
    numbered = [
        (int(number), label.strip())
        for number, label in re.findall(
            r"^\s*(\d+)\.\s+\*\*([^*]+)\*\*",
            inputs,
            re.MULTILINE,
        )
    ]
    _same(
        gate,
        "R4 CTXHASH_V1: exact ten fields and order",
        numbered,
        list(enumerate(CTXHASH_FIELDS, start=1)),
    )
    serializer_requirements = (
        '"CTXHASH_V1"', "U32BE(len(f1))", "U32BE(len(f10))", "UTF-8",
        "4-byte big-endian", "SHA-256", "lowercase hex",
    )
    missing = [item for item in serializer_requirements if item not in inputs]
    gate.require(
        "R4 CTXHASH_V1: pinned byte serializer",
        not missing,
        f"missing serializer elements: {missing}",
    )
    gate.require(
        "R4 CTXHASH_V1: active version tag pinned first",
        count(inputs, "CTXHASH_V1") >= 1
        and _paragraph_with(inputs, ("CTXHASH_V1", "first bytes", "future change")),
        "CTXHASH_V1 must be the first bytes and any future serializer change needs a new tag",
    )


def _validate_governed_skill_boundary(gate: Gate, text: str) -> None:
    folded = text.casefold()
    gate.require(
        "R4 GS sequencing: stale acceptance claim absent",
        "gs-accept remains externally unsatisfied" not in folded,
        "stale pre-GS-ROLLBACK sequencing claim is present",
    )
    gate.require(
        "R4 GS sequencing: F-1 closed and acceptance result current",
        _paragraph_with(text, ("GS-ROLLBACK", "closed", "GS-ACCEPT", "F-1"))
        and bool(re.search(r"9\s+passed\s*/\s*1\s+(?:expected\s+)?xfail(?:ed)?", text, re.IGNORECASE)),
        "must record GS-ROLLBACK closure and 9 passed / 1 expected xfailed",
    )
    gate.require(
        "R4 GS sequencing: soak then operator default-on",
        _paragraph_with(text, ("soak", "operator", "default-on")),
        "remaining external gate is soak followed by the operator default-on decision",
    )
    tools_paragraph = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "rollback_skill" in paragraph and "list_skill_versions" in paragraph
        ),
        "",
    )
    gate.require(
        "R4 governed tools: both are operator-surface only",
        bool(tools_paragraph)
        and "operator-surface only" in tools_paragraph.casefold()
        and "channel" in tools_paragraph.casefold()
        and "automation" in tools_paragraph.casefold()
        and "cross-channel" in tools_paragraph.casefold()
        and ("no " in tools_paragraph.casefold() or "never" in tools_paragraph.casefold()),
        "rollback_skill/list_skill_versions need an operator-only, no-channel/automation/cross-channel boundary",
    )
    gate.require(
        "R4 governed tools: no C2 or delegated path",
        bool(tools_paragraph)
        and "c2" in tools_paragraph.casefold()
        and "delegated" in tools_paragraph.casefold()
        and "no " in tools_paragraph.casefold(),
        "governed rollback/version tools must have no C2-card or delegated-approval path",
    )
    mapper_paragraph = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "governed_skills.map_activation_failure" in paragraph
        ),
        "",
    )
    gate.require(
        "R4 governed errors: shared mapper, never copied",
        bool(mapper_paragraph)
        and "skill_queue.decide()" in mapper_paragraph
        and any(term in mapper_paragraph.casefold() for term in ("not copied", "not reimplemented", "never copied")),
        "C2 must use governed_skills.map_activation_failure rather than copying error shapes",
    )
    codes = {
        "SKILL_ROLLBACK_TARGET_NEVER_ACTIVE",
        "SKILL_ROLLBACK_INVALID_TARGET",
        "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT",
        "SKILL_ACTIVATION_CACHE_UNPROVEN",
    }
    _same(
        gate,
        "R4 governed errors: exact four codes present",
        {code for code in codes if code in text},
        codes,
    )
    unproven = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT" in paragraph
            and "SKILL_ACTIVATION_CACHE_UNPROVEN" in paragraph
        ),
        "",
    )
    gate.require(
        "R4 governed errors: UNPROVEN non-retryable/no auto-retry",
        bool(unproven)
        and "non-retryable" in unproven.casefold()
        and bool(re.search(r"(?:must\s+not|never|no)\s+auto-?retry", unproven, re.IGNORECASE)),
        "both UNPROVEN codes are non-retryable and must never be auto-retried",
    )
    gate.require(
        "R4 governed tools: disable/unpublish nonexistent",
        _paragraph_with(text, ("disable", "unpublish", "does not exist"))
        and "disable_skill" not in text
        and "unpublish_skill" not in text
        and _paragraph_with(text, ("GS-DISABLE", "unscoped")),
        "governed disable/unpublish must remain nonexistent and GS-DISABLE unscoped",
    )
    gate.require(
        "R4 governed tools: rollback re-enables by design",
        _paragraph_with(text, ("rollback_skill", "re-enables", "disabled", "by design")),
        "must state that rollback_skill re-enables a disabled skill by design",
    )
    gate.require(
        "R4 governed flag: stays default-off",
        _paragraph_with(text, ("TORQCLAW_GOVERNED_SKILLS", "default-off", "operator")),
        "governed skills flag stays default-off pending operator decision",
    )


def _validate_evidence_honesty(gate: Gate, text: str, pregate: str) -> None:
    paragraphs = re.split(r"\n\s*\n", pregate)
    gate.require(
        "R4 evidence: observed never copied from expected",
        any(
            "observed" in paragraph.casefold()
            and "expected" in paragraph.casefold()
            and ("never" in paragraph.casefold() or "must not" in paragraph.casefold())
            and ("copy" in paragraph.casefold() or "derived" in paragraph.casefold())
            for paragraph in paragraphs
        ),
        "evidence rules must prohibit deriving observed values from expected constants",
    )
    gate.require(
        "R4 evidence: PASS only after zero and never from finally",
        any(
            "pass" in paragraph.casefold()
            and "zero" in paragraph.casefold()
            and "finally" in paragraph.casefold()
            and "never" in paragraph.casefold()
            for paragraph in paragraphs
        ),
        "PASS must be written only after a zero result, never from finally",
    )
    gate.require(
        "R4 evidence: failure report cannot be overwritten",
        _paragraph_with(pregate, ("never", "overwrite", "failure report")),
        "a later path must never overwrite failure evidence",
    )
    gate.require(
        "R4 evidence: future proof launches real hashed artifact",
        any(
            "real child process" in paragraph.casefold()
            and "hash" in paragraph.casefold()
            and "child output" in paragraph.casefold()
            and "disposable" in paragraph.casefold()
            for paragraph in paragraphs
        ),
        "managed proof must launch/hash the actual artifact and derive observations from child output/disposable state",
    )
    gate.require(
        "R4 evidence: design/model result not runtime proof",
        _paragraph_with(text, ("design", "model", "not", "built-artifact"))
        or _paragraph_with(text, ("design", "SQLite-model", "not runtime")),
        "the linter/SQLite model cannot be labeled built-artifact evidence",
    )
    fixture_free = _without_block(text.encode("utf-8"), "BASELINE_STATE_DB_AF52430")
    copied_assignment = bool(re.search(
        r"(?m)^\s*(?:(?:const|let|var)\s+)?observed\s*=\s*(?:dict\s*\()?expected\b",
        fixture_free,
        re.IGNORECASE,
    ))
    pass_in_finally = bool(re.search(
        r"finally\s*:\s*(?:\n[^\n]*){0,4}\b(?:print|write|append)[^\n]*\bPASS\b",
        fixture_free,
        re.IGNORECASE,
    ))
    gate.require(
        "R4 evidence: no hard-coded observed/PASS-finally code",
        not copied_assignment and not pass_in_finally,
        f"observed_equals_expected={copied_assignment} pass_in_finally={pass_in_finally}",
    )


def _run_revision_4_checks(
    gate: Gate,
    prd: Path,
    text: str,
    pregate: str,
    repo: Path,
) -> None:
    data = prd.read_bytes()
    headings = [
        int(number)
        for number in re.findall(r"^##\s+(\d+)\.", text, re.MULTILINE)
    ]
    _same(
        gate,
        "R4 structure: exactly sections 1-13",
        headings,
        list(range(1, 14)),
    )

    markers_ok, marker_detail = _validate_marker_nesting(data)
    gate.require("R4 markers: globally balanced and nested", markers_ok, marker_detail)
    blocks: dict[str, bytes] = {}
    for name in R4_BLOCKS:
        try:
            blocks[name] = _extract_block(data, name)
        except ValueError as exc:
            gate.require(f"R4 markers: {name}", False, str(exc))
        else:
            gate.require(f"R4 markers: {name}", True, "")

    expected_gateway: bytes | None = None
    expected_collab: bytes | None = None
    try:
        expected_gateway = _git_bytes(repo, GATEWAY_SCHEMA_PATH)
        expected_collab = _collab_ddl(_git_bytes(repo, COLLAB_MIGRATION_PATH))
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        gate.require("R4 baseline: raw git show af52430", False, str(exc))
    else:
        gate.require("R4 baseline: raw git show af52430", True, "")

    embedded_gateway = _worktree_text_to_git_bytes(
        blocks.get("BASELINE_GATEWAY_SCHEMA_AF52430", b"")
    )
    gateway_matches = (
        expected_gateway is not None and embedded_gateway == expected_gateway
    )
    gate.require(
        "R4 baseline bytes/SHA-256: gateway schema",
        gateway_matches,
        _byte_difference(embedded_gateway, expected_gateway or b""),
    )
    embedded_collab = _worktree_text_to_git_bytes(_remove_marker_separator(
        blocks.get("BASELINE_COLLAB_MIGRATION_DDL_AF52430", b"")
    ))
    collab_matches = expected_collab is not None and embedded_collab == expected_collab
    gate.require(
        "R4 baseline bytes/SHA-256: collaboration migration DDL",
        collab_matches,
        _byte_difference(embedded_collab, expected_collab or b""),
    )

    expectations = _json_block(gate, blocks, "BASELINE_OBJECT_EXPECTATIONS_V4")
    state_map = _json_block(gate, blocks, "STATE_DB_MAP_V4")
    _validate_expectations(gate, expectations)
    _validate_physical_map(gate, state_map)

    fixture_free_text = _without_block(data, "BASELINE_STATE_DB_AF52430")
    additions = _validate_migration_contract(gate, fixture_free_text, state_map)
    if gateway_matches and collab_matches and expectations is not None:
        _validate_sqlite_fixtures(
            gate,
            expected_gateway or b"",
            expected_collab or b"",
            expectations,
            additions,
        )
    else:
        gate.require(
            "R4 SQLite: execute separate pinned baseline DDL",
            False,
            "skipped because embedded provenance did not byte-match af52430",
        )

    _validate_identity_and_authority(gate, fixture_free_text)
    _validate_approval_state(gate, fixture_free_text)
    _validate_cross_database_protocol(gate, fixture_free_text)
    _validate_ctxhash(gate, fixture_free_text)
    _validate_governed_skill_boundary(gate, fixture_free_text)
    _validate_evidence_honesty(gate, fixture_free_text, pregate)


def run(prd: Path, repo: Path | None = None) -> tuple[Gate, str]:
    text = prd.read_text(encoding="utf-8")
    repo = (repo or Path(__file__).resolve().parents[1]).resolve()
    gate = Gate()

    out_of_scope = section(text, "9. Explicitly OUT OF SCOPE", level=2)
    gate_pregate = section(text, "10. Consistency pre-gate (SPECIFY, do not implement)", level=2)
    sot_matrix = section(text, "4. Source-of-truth matrix", level=2)
    props_section = section(text, "3.3 The twelve properties as testable contracts", level=3)
    adversarial = section(text, "7. Adversarial scenario matrix", level=2)
    tickets = section(text, "8. Ticket decomposition, acceptance, and FREEZE criteria", level=2)

    # ------------------------------------------------------------------
    # REQUIRED LITERALS PRESENT (missing any -> FAIL)
    # ------------------------------------------------------------------
    required = {
        # Four-layer model
        "four-layer: Principal": "Principal",
        "four-layer: Surface": "Surface",
        "four-layer: Credential": "Credential",
        "four-layer: Session": "Session",
        # Six surface kinds
        "surface kind: desktop": "desktop",
        "surface kind: mobile": "mobile",
        "surface kind: http": "http",
        "surface kind: telegram": "telegram",
        "surface kind: slack": "slack",
        "surface kind: automation": "automation",
        # C0 frozen symbols
        "C0 symbol: resolvePrincipalBinding": "resolvePrincipalBinding",
        "C0 symbol: assertResumeAllowed": "assertResumeAllowed",
        "C0 symbol: collabEnabled": "collabEnabled",
        "C0 symbol: SAFE_ID": "SAFE_ID",
        "C0 symbol: da688c0": "da688c0",
        # Credential reuse
        "credential reuse: tq1_": "tq1_",
        "credential reuse: HMAC-SHA-256": "HMAC-SHA-256",
        "credential reuse: existence-oblivious": "existence-oblivious",
        "credential reuse: credentials.ts": "credentials.ts",
        # Approval state set
        "approval state: pending": "pending",
        "approval state: approved": "approved",
        "approval state: rejected": "rejected",
        "approval state: expired": "expired",
        # Identity/capability/authority split
        "identity/capability/authority: identity": "identity",
        "identity/capability/authority: capability": "capability",
        "identity/capability/authority: authority": "authority",
        "AR-1 ruling cited": "AR-1",
        "execution profile: read_only": "read_only",
        "execution profile: workspace_write": "workspace_write",
        "execution profile: browser_research": "browser_research",
        "execution profile: terminal_power": "terminal_power",
        # CT-2 provisioning rule
        "CT-2 cross-channel forbidden": "cross-channel approval",
        # H-1 subordination
        "H-1 INTERSECTED": "INTERSECTED",
        "H-1 layering chain": "principal authority\n  → surface / session authority",
        # Separate authority store + operator-kind discriminator (FIX 2/3)
        "authority store: surface_authorities": "surface_authorities",
        "operator-kind discriminator: surface_role": "surface_role",
        # Context-hash byte serializer version (FIX 5)
        "context_hash serializer: CTXHASH_V1": "CTXHASH_V1",
        # Property-10 ruling + context_hash
        "property-10 wins over property 6": "property 10 WINS over property 6",
        "context_hash literal": "context_hash",
        "C2 synchronous apply": "synchronous",
        "server.ts apply-tick citation": "server.ts:185-202",
        "property-10 deferred to C3": "DEFERRED to C3",
        "property-6-vs-10 latent until C3": "latent-until-C3",
        # Projection precedent
        "projection: run_receipts": "run_receipts",
        "projection: receipts-rebuild.mjs": "receipts-rebuild.mjs",
        "approval_deliveries not truth": "approval_deliveries",
        # Three-proofs
        "three-proofs: reachability": "reachability",
        "three-proofs: built-artifact": "built-artifact",
        # Migration lesson
        "migration: PRAGMA table_info": "PRAGMA table_info",
        "migration: IF NOT EXISTS": "IF NOT EXISTS",
        "migration: ALTER TABLE": "ALTER TABLE",
    }
    for name, literal in required.items():
        gate.require(name, literal in text, f"missing required literal: {literal!r}")

    # CT-2: "approve" grantable only to operator-kind surfaces, never channel/automation
    gate.require(
        "CT-2 operator-kind-only grant",
        bool(re.search(r"grantable ONLY to operator-kind surfaces", text)),
        "missing CT-2 operator-kind-only grant phrasing",
    )
    gate.require(
        "CT-2 never channel/automation",
        bool(re.search(
            r"NEVER grantable to:\*\* any surface with `surface_role ∈ \('agent','automation'\)`",
            text,
        )),
        "missing CT-2 never-grantable-to-channel/automation phrasing",
    )

    # H-1: corrected layering chain, full pipeline (5 stages)
    layering_pattern = (
        r"principal authority\s*\n\s*→\s*surface / session authority.*?\n\s*→\s*"
        r"requested capability / authority token.*?\n\s*→\s*specific operation.*?\n\s*→\s*"
        r"specific resource / task"
    )
    gate.require(
        "H-1 full corrected layering",
        bool(re.search(layering_pattern, text, re.DOTALL)),
        "corrected layering chain (principal authority -> ... -> specific resource/task) not found intact",
    )

    # stale-dist / stale `dist` variant match
    gate.require(
        "three-proofs: stale-dist lesson",
        contains(text, "stale-dist") or contains(text, "stale `dist`") or ("stale-`dist`" in text) or ("stale `dist`" in text),
        "missing stale-dist / stale `dist` lesson literal",
    )

    # approval_deliveries declared NOT approval truth (near assertion)
    not_truth_positions = find_positions(text, "approval_deliveries")
    near_not_truth = False
    for pos in not_truth_positions:
        window = text[max(0, pos - 200): pos + 200]
        if re.search(r"NOT approval truth|not approval truth|NOT truth|never the only copy|projection.{0,40}NOT truth", window, re.IGNORECASE):
            near_not_truth = True
            break
    gate.require(
        "approval_deliveries declared NOT approval truth",
        near_not_truth,
        "no 'approval_deliveries' occurrence found near a NOT-approval-truth assertion",
    )

    # OQ-4 frozen input set: ten canonical context_hash inputs, profile + privacy present
    input_set_section = ""
    try:
        input_set_section = section(text, "3.4.1 Canonical `context_hash` input set (FROZEN, normative — clears C-2, closes OQ-4)", level=4)
    except ValueError:
        pass
    gate.require(
        "OQ-4 ten canonical inputs enumerated",
        bool(re.search(r"^\s*10\.\s+\*\*Relevant policy revision\*\*", input_set_section, re.MULTILINE)),
        "context_hash input list does not enumerate all ten items (1..10) under §3.4.1",
    )
    gate.require(
        "OQ-4 resolved execution profile present",
        "Resolved execution profile" in input_set_section,
        "context_hash input set missing 'Resolved execution profile'",
    )
    gate.require(
        "OQ-4 privacy context present",
        "Privacy / security context" in input_set_section,
        "context_hash input set missing 'Privacy / security context'",
    )

    # ------------------------------------------------------------------
    # FORBIDDEN LITERALS (present -> FAIL)
    # ------------------------------------------------------------------

    # §9 and §10/§11 boundaries, used below to exclude the legitimate
    # out-of-scope list (§9) and the pre-gate's own spec text (§10) — which
    # necessarily quotes each forbidden literal descriptively as an
    # instruction to future linters — from the forbidden-literal scans.
    s9_start = text.index("## 9. Explicitly OUT OF SCOPE")
    s10_start = text.index("## 10. Consistency pre-gate (SPECIFY, do not implement)")
    s11_start = text.index("## 11. Contradictions found between operator spec and shipped baseline")

    # "Allow for session" — CORRECTED rule (operator REVISE-PRD #2, fix #1).
    # The OLD rule forbade the literal string `Allow for session` anywhere in
    # this PRD (presence -> FAIL). That was a SPEC DEFECT: §3.3/§3.11/§8/OQ-3
    # legitimately contain the phrase precisely to DOCUMENT the prohibition,
    # so a literal-presence lint made the linter reject its own PRD. Per the
    # corrected §10, the forbidden literal is forbidden on the IMPLEMENTATION/
    # CONFIG surface (the eventual UI/config/grant-type enum) — NOT in the PRD
    # prose — and the PRD's job is to DOCUMENT that prohibition. This linter
    # therefore does the OPPOSITE of forbidding the string: it REQUIRES an
    # explicit, present prohibition statement. It PASSES on the corrected PRD
    # and still FAILS if that prohibition statement is removed. This keeps a
    # real check with teeth without the self-contradiction.
    prohibition_present = bool(re.search(
        r'"Allow for session" is PROHIBITED as a shippable grant option',
        text,
    ))
    gate.require(
        "Allow-for-session prohibition statement present",
        prohibition_present,
        "the PRD must contain the normative prohibition statement "
        "'\"Allow for session\" is PROHIBITED as a shippable grant option' "
        "(§3.11 / §10 corrected); it is missing",
    )

    # collab_session_bindings used AS the session store (affirmative sense)
    # vs. legitimately referenced to say it is NOT the session store / does
    # not replace / does not swap sessions. FAIL only on the affirmative
    # "used as the session store" sense. §10 is excluded from this scan
    # because it is the pre-gate's own SPEC TEXT, which necessarily quotes
    # the forbidden pattern ("e.g. `collab_session_bindings` used as the
    # session store") descriptively, as an instruction to future linters —
    # not as a claim made by the PRD's own architecture. Scanning §10
    # against its own forbidden-literal description would be a check bug,
    # not a real finding.
    csb_scan_text = text[:s10_start] + text[s11_start:]
    csb_positions = find_positions(csb_scan_text, "collab_session_bindings")
    offending_csb = []
    for pos in csb_positions:
        window = csb_scan_text[max(0, pos - 150): pos + 150]
        is_negated = bool(re.search(
            r"NOT replaced by|not replaced by|does not swap|does not replace|"
            r"NOT the session store|not used as the session|never the session store",
            window, re.IGNORECASE,
        ))
        if not is_negated:
            offending_csb.append(pos)
    gate.require(
        "forbidden: collab_session_bindings used as session store",
        len(offending_csb) == 0,
        f"'collab_session_bindings' appears without a nearby 'not replaced/does not swap' disclaimer at offsets {offending_csb}",
    )

    # C3 scope leak: collab_events, or channel commands, appearing IN-SCOPE.
    # These may legitimately appear in the §9 out-of-scope list, or in §10's
    # own spec text describing what to forbid — exclude both those sections
    # from the scan.
    scope_scan_text = text[:s9_start] + text[s11_start:]

    c3_leak_literals = [
        "collab_events", "channel_created", "member_added",
        "message_posted", "channel_archived",
    ]
    leaked = [lit for lit in c3_leak_literals if contains(scope_scan_text, lit)]
    gate.require(
        "forbidden: C3 scope leak (collab_events / channel commands in-scope)",
        len(leaked) == 0,
        f"C3-scoped literals found outside §9/§10: {leaked}",
    )

    # ------------------------------------------------------------------
    # STRUCTURAL PARITY CHECKS
    # ------------------------------------------------------------------

    # §4 source-of-truth matrix row coverage
    sot_required_rows = [
        "Surface", "SurfaceCredential", "surface capability",
        "approval origin", "approval authority", "approval delivery",
        "approval expiry", "decision evidence", "context binding",
    ]
    # The matrix uses close-but-not-identical row labels; map each required
    # concept to a substring known to appear in its matrix row.
    sot_row_markers = {
        "Surface": r"\|\s*\*\*Surface\*\*\s*\|",
        "SurfaceCredential": r"Surface credential \(HMAC\)",
        "surface capability": r"Surface capability",
        "approval origin": r"Approval origin",
        "approval authority": r"Approval authority \(who may decide\)",
        "approval delivery": r"Approval delivery",
        "approval expiry": r"Approval expiry",
        "decision evidence": r"Decision evidence",
        "context binding": r"Approval-context binding",
    }
    missing_sot_rows = [
        concept for concept, pat in sot_row_markers.items()
        if not re.search(pat, sot_matrix, re.IGNORECASE)
    ]
    gate.require(
        "§4 source-of-truth matrix row coverage",
        len(missing_sot_rows) == 0,
        f"missing §4 matrix rows for: {missing_sot_rows}",
    )

    # §3.3 all 12 properties numbered 1-12
    prop_numbers = set(re.findall(r"^\|\s*(\d{1,2})\s*\|", props_section, re.MULTILINE))
    gate.equal("§3.3 all 12 properties present", prop_numbers, {str(n) for n in range(1, 13)})

    # §7 all 12 adversarial rows A1-A12
    adv_ids = set(re.findall(r"^\|\s*(A\d{1,2})\s*\|", adversarial, re.MULTILINE))
    gate.equal("§7 all 12 adversarial rows present", adv_ids, {f"A{n}" for n in range(1, 13)})

    # §8 every ticket (C1-* and C2-*) has an acceptance-criterion line
    ticket_lines = re.findall(r"^-\s+\*\*(C[12]-\d+)\b[^\n]*", tickets, re.MULTILINE)
    tickets_without_ac = []
    for line in re.finditer(r"^-\s+\*\*(C[12]-\d+)\b.*$", tickets, re.MULTILINE):
        ticket_id = line.group(1)
        full_line = line.group(0)
        if "AC:" not in full_line:
            tickets_without_ac.append(ticket_id)
    gate.require(
        "§8 every ticket has an AC: line",
        len(ticket_lines) > 0 and len(tickets_without_ac) == 0,
        f"tickets found={len(ticket_lines)}; missing AC: {tickets_without_ac}",
    )
    expected_tickets = {f"C1-{n}" for n in range(1, 7)} | {f"C2-{n}" for n in range(1, 9)}
    gate.equal("§8 expected ticket set present", set(ticket_lines), expected_tickets)

    # Do not let the Revision-4 implementation accidentally trade away one of
    # the shipped gate's original checks.  This assertion is intentionally
    # taken before any R4 check is appended.
    legacy_total = len(gate.passed) + len(gate.findings)
    gate.require(
        "R4 compatibility: original 67 checks executed",
        legacy_total == LEGACY_CHECK_COUNT,
        f"expected {LEGACY_CHECK_COUNT} legacy checks, executed {legacy_total}",
    )
    _run_revision_4_checks(gate, prd, text, gate_pregate, repo)

    summary = (
        f"{'PASS' if not gate.findings else 'FAIL'}: "
        f"{len(gate.passed)} checks passed, {len(gate.findings)} failed"
    )
    return gate, summary


def render(prd: Path, gate: Gate, summary: str) -> str:
    lines = [
        "# PRD-TCLAW-COLLAB-GATEWAY-004 Consistency Report", "",
        f"- PRD: `{prd}`", f"- Result: `{summary}`", "",
        "## Passed checks", "",
        *(f"- {name}" for name in gate.passed),
        "", "## Findings", "",
    ]
    lines.extend(
        (f"- **{item.check}:** {item.detail}" for item in gate.findings)
        if gate.findings else ["- None."]
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "prd", nargs="?", type=Path,
        default=repo / "docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004.md",
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        gate, summary = run(args.prd.resolve())
    except (OSError, ValueError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2
    print(summary)
    for item in gate.findings:
        print(f"- {item.check}: {item.detail}")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(render(args.prd.resolve(), gate, summary), encoding="utf-8")
    return 1 if gate.findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
