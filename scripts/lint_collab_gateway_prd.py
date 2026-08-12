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
import ast
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
from contextlib import closing

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

GOVERNED_SOURCE_PATHS = {
    "mapper": "engines/hermes_kernel/mcp_wrapper/governed_skills.py",
    "queue": "engines/hermes_kernel/mcp_wrapper/skill_queue.py",
    "rollback": "engines/hermes_kernel/mcp_wrapper/skill_rollback.py",
    "server": "engines/hermes_kernel/mcp_wrapper/server.py",
}
SHARED_MAPPER_CODES = {
    "SKILL_RUNTIME_BUSY",
    "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT",
    "SKILL_ACTIVATION_CACHE_UNPROVEN",
    "SKILL_ACTIVATION_FAILED",
}
UNPROVEN_CODES = {
    "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT",
    "SKILL_ACTIVATION_CACHE_UNPROVEN",
}
DIRECT_ROLLBACK_CODES = {
    "SKILL_ROLLBACK_TARGET_NEVER_ACTIVE",
    "SKILL_ROLLBACK_INVALID_TARGET",
}
GS_ACCEPT_RECEIPT_PATH = ".torq/artifacts/03_verifier/gs_accept_r1.md"
APPROVAL_EXPIRY_INDEX = "idx_tool_approvals_status_expires"
DELIVERY_INDEXES = {
    "idx_approval_deliveries_approval": ("approval_id",),
    "idx_approval_deliveries_target_state": (
        "target_surface_id",
        "delivery_state",
    ),
}

ACTIONHASH_VECTOR_FIELDS = (
    "11111111-1111-4111-8111-111111111111",
    "filesystem__write_file",
    '{"a":"é","z":1}',
)
ACTIONHASH_VECTOR_LENGTH = 99
ACTIONHASH_VECTOR_DIGEST = (
    "c3db5267496d68d9edea579e0bd43c1e397364026e281401e30fa0bc596af6bb"
)

CTXHASH_FRAMING_FIELDS = (
    "prn_operator_01",
    "srf_desktop_01",
    "11111111-1111-4111-8111-111111111111",
    "desktop",
    "workspace_write",
    "filesystem__write_file",
    '{"a":"é","z":1}',
    "privacy-v1:sensitive",
    "routing-v1:OLLAMA_LOCAL",
    "c" * 64,
)
CTXHASH_FRAMING_LENGTHS = (15, 14, 36, 7, 15, 22, 16, 20, 23, 64)
CTXHASH_FRAMING_TOTAL = 282
CTXHASH_FRAMING_DIGEST = (
    "96424e5e9f3bb595e74408a9e1fe07b1b7f981d3f04c427e1af1ac5fa3ff2c2a"
)
CTXHASH_SEMANTIC_OBJECTS = {
    "privacy": {
        "schemaVersion": "torqclaw.approval-privacy/v1",
        "containsSensitiveData": True,
        "redactionPolicyRevision": "torqclaw.redaction/v1",
    },
    "routing": {
        "schemaVersion": "torqclaw.approval-routing/v1",
        "executionMode": "AUTO",
        "selectedTier": "OLLAMA_LOCAL",
        "ruleId": "LOCAL_TOOL_INTENT",
        "routerPolicyRevision": "torqclaw.router/v1",
    },
    "security": {
        "schemaVersion": "torqclaw.approval-policy/v1",
        "effectiveProfile": {
            "schemaVersion": "torqclaw.effective-profile/v1",
            "profileId": "workspace_write",
            "profileVersion": 1,
            "toolRegistryVersion": "torqclaw.tools/v1",
            "effectiveProfilePolicyHash": (
                "e67951376789e1ae88b2388f22351fc8bc5a5c93dcbce7f1d412926f8bfc0b7e"
            ),
        },
        "capabilityRevision": 7,
        "profileDelegationRevision": 11,
        "registryEnforcementHash": "d" * 64,
    },
}
CTXHASH_SEMANTIC_HASHES = {
    "privacy": "b503e9e4eb94c4c3ef34481efced486596a270955036a961f8fd02682156ad16",
    "routing": "944af7d5cf70a7ba35a48d1eba0255e61dda8718e9b2b11017d4c0f70cce3e25",
    "security": "4ddc3aa9ad1d6a905fba67ca74183cf28cbf1141a340eee6aaf56a71c0157310",
}
CTXHASH_SEMANTIC_LENGTHS = (15, 14, 36, 7, 15, 22, 16, 64, 64, 64)
CTXHASH_SEMANTIC_TOTAL = 367
CTXHASH_SEMANTIC_DIGEST = (
    "d7bf709cf2ee293b854e77f7aa649cc18c3195e52870b2e8e01066e270556626"
)

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
    "gateway_approval_bindings", "gateway_action_grants",
    "gateway_task_origins", "gateway_profile_delegations",
    "approval_deliveries",
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


def _canonical_json_bytes(value: Any) -> bytes:
    """Independent canonicalizer for the frozen plain-JSON golden fixtures."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _framed_sha256(tag: str, fields: tuple[str, ...]) -> tuple[tuple[int, ...], int, str]:
    encoded = tuple(field.encode("utf-8") for field in fields)
    framed = tag.encode("ascii") + b"".join(
        len(field).to_bytes(4, "big") + field
        for field in encoded
    )
    return (
        tuple(len(field) for field in encoded),
        len(framed),
        hashlib.sha256(framed).hexdigest(),
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
    # Pin the SQL payload, not the TypeScript source indentation before the
    # closing backtick.  migration.ts formats that delimiter as ``    `);``;
    # those four bytes are outside the authored DDL boundary even though a
    # JavaScript template technically includes them as trailing whitespace.
    match = re.search(rb"db\.exec\(`(.*?)`\);", source, re.DOTALL)
    if not match:
        raise ValueError("collaboration migration db.exec template was not found")
    payload = match.group(1)
    if not payload.endswith(b"    "):
        raise ValueError(
            "collaboration migration closing template indentation changed; "
            "expected four spaces"
        )
    return payload[:-4]


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


def _sentence_start(text: str, pos: int) -> int:
    """Return the offset just after the nearest sentence-ending punctuation
    (`. ` / `; ` / `\n`) at or before `pos`, so a negation search can be
    scoped to the current sentence instead of bleeding into the previous one.
    """
    boundary = -1
    for m in re.finditer(r"[.;]\s+|\n", text[:pos]):
        boundary = m.end()
    return max(0, boundary)


def _paragraph_with_affirmed(
    text: str, terms: tuple[str, ...], affirmed: str,
) -> bool:
    """Like `_paragraph_with`, but additionally requires that at least one
    occurrence of `affirmed` inside a co-occurring paragraph is NOT preceded
    by a nearby negation word (see `near_negation`), scoped to the current
    sentence.

    `_paragraph_with` alone is negation-blind: it only checks that terms
    co-occur as substrings, so inverting a load-bearing word to its negated
    form (e.g. "the grant is consumed" -> "the grant is NOT consumed") still
    satisfies plain substring co-occurrence and leaves the check green. This
    wrapper closes that hole for the specific, named positive claim inside a
    paragraph, without weakening `_paragraph_with`'s existing co-occurrence
    semantics for every other, non-invertible use of it. The negation search
    is clipped to the current sentence (not just the current paragraph)
    because `near_negation`'s paragraph-wide window can otherwise pick up an
    unrelated negation from an earlier sentence in a dense normative
    paragraph.
    """
    folded_terms = tuple(term.casefold() for term in terms)
    for paragraph in re.split(r"\n\s*\n", text):
        folded_paragraph = paragraph.casefold()
        if not all(term in folded_paragraph for term in folded_terms):
            continue
        positions = [
            m.start()
            for m in re.finditer(re.escape(affirmed), paragraph, re.IGNORECASE)
        ]
        for pos in positions:
            sentence_start = _sentence_start(paragraph, pos)
            if not near_negation(paragraph[sentence_start:], pos - sentence_start):
                return True
    return False


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
        and approvals.get("new_index") == APPROVAL_EXPIRY_INDEX
        and approvals.get("canonical_approval_state") is True,
        "tool_approvals must preserve rows/values/rowids and declare six nullable columns plus the expiry index",
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
    gate.require(
        "R4 map: no durable session-auth snapshot",
        "gateway_session_auth" not in state.get("new_additive_objects", []),
        "ConnectionAuthContext is connection-scoped; it must not be snapshotted per durable session",
    )
    gate.require(
        "R4 map: protected payload store remains uncreated",
        "gateway_approval_payloads" not in state.get("new_additive_objects", []),
        "protected payload persistence is a reserved future option pending operator approval",
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
            "automatic_grant_completion": "forbidden",
            "recovery": "revoke-side-only",
            "cross_database_fk": "forbidden",
            "cross_database_atomicity_claim": "forbidden",
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
        bool(re.search(
            r"const\s+cols\s*=\s*db\.prepare\s*\(\s*`PRAGMA\s+"
            r"table_info\(tool_approvals\)`\s*\)\.all\s*\(\s*\)",
            text,
            re.IGNORECASE,
        ))
        and bool(re.search(
            r"const\s+add\s*=.*?if\s*\(\s*!\s*cols\.some\s*\(.*?"
            r"c\.name\s*===\s*name.*?\)\s*\)\s*db\.exec\(ddl\)",
            text,
            re.IGNORECASE | re.DOTALL,
        )),
        "the six ALTERs need a per-column PRAGMA table_info absence guard",
    )

    # Revision-4 scoping (§10.4 item 7): the destructive-migration scan must
    # cover proposal-level text everywhere a proposal could hide a destructive
    # statement, not just before §9. `text` here is already fixture-free (the
    # caller strips the §10.1 BASELINE_STATE_DB_AF52430 block before calling
    # this function), so scanning the whole document catches a destructive
    # statement placed in §11/§12/§13 that a `before_s9` truncation would miss
    # (proven by an adversarial `DROP TABLE tool_approvals` probe placed in
    # §12). §10's own spec prose never needs a separate exclusion here: it
    # documents the prohibition descriptively but does not itself contain any
    # of the dangerous SQL/sentinel patterns below (verified against the
    # canonical PRD).
    map_text = _stable_repr(state_map or {})
    proposed = text + "\n" + map_text
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
    # Explicit, separately-named regression lock for the specific scoping
    # hole an adversarial review found: `dangerous_patterns` above used to be
    # scanned only over `text.split("## 9. Explicitly OUT OF SCOPE", 1)[0]`,
    # so a destructive statement placed anywhere at or after §9 (including
    # §11/§12/§13) was invisible to the gate. `proposed` is now built from the
    # whole fixture-free document, so this check is redundant with the one
    # above on any correctly-scanned document — it exists as an explicit,
    # independently named assertion over just the post-§9 tail, so a future
    # regression that narrows the scan back to a `before_s9`-style prefix
    # fails here by name even if the primary check above were ever weakened
    # back down instead of removed.
    s9_tail = text[text.index("## 9. Explicitly OUT OF SCOPE"):] + "\n" + map_text
    tail_dangerous = [
        name for name, pattern in dangerous_patterns.items()
        if re.search(pattern, s9_tail, re.IGNORECASE)
    ]
    gate.require(
        "R4 migration: destructive scan covers §9 onward (§11-§13 regression lock)",
        not tail_dangerous,
        f"destructive patterns found at/after §9 (would previously have been invisible): {tail_dangerous}",
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
    gate.require(
        "R4 migration: no gateway_session_auth table",
        not re.search(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?gateway_session_auth\b",
            text,
            re.IGNORECASE,
        ),
        "a durable session-auth snapshot is invalid when one session has concurrent presenting surfaces",
    )
    gate.require(
        "R4 migration: no gateway_approval_payloads table",
        not re.search(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?gateway_approval_payloads\b",
            text,
            re.IGNORECASE,
        ),
        "protected payload persistence needs a future protection/retention decision and operator approval",
    )
    return additions


def _proposed_statement(text: str, pattern: str) -> str:
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return match.group(0) if match else ""


def _validate_delivery_and_expiry_ddl(
    gate: Gate,
    text: str,
    gateway_ddl: bytes | None,
    additions: list[dict[str, str]],
) -> None:
    delivery_table = _proposed_statement(
        text,
        r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+approval_deliveries\s*\(.*?\n\);",
    )
    expiry_index = _proposed_statement(
        text,
        rf"CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+{APPROVAL_EXPIRY_INDEX}\s*"
        r"ON\s+tool_approvals\s*\(\s*status\s*,\s*expires_at\s*\)\s*(?=;|`)",
    )
    delivery_indexes: dict[str, str] = {}
    for name, columns in DELIVERY_INDEXES.items():
        column_pattern = r"\s*,\s*".join(map(re.escape, columns))
        delivery_indexes[name] = _proposed_statement(
            text,
            rf"CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+{re.escape(name)}\s*"
            rf"ON\s+approval_deliveries\s*\(\s*{column_pattern}\s*\)\s*;",
        )
    body = _table_body(text, "approval_deliveries")
    delivery_shape = (
        bool(delivery_table)
        and bool(re.search(r"(?m)^\s*id\s+TEXT\s+PRIMARY\s+KEY", body, re.IGNORECASE))
        and bool(re.search(r"(?m)^\s*approval_id\s+TEXT\s+NOT\s+NULL", body, re.IGNORECASE))
        and bool(re.search(r"(?m)^\s*target_surface_id\s+TEXT\s+NOT\s+NULL", body, re.IGNORECASE))
        and bool(re.search(
            r"delivery_state\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+['\"]pending['\"]",
            body,
            re.IGNORECASE,
        ))
        and bool(re.search(
            r"FOREIGN\s+KEY\s*\(\s*approval_id\s*\)\s*REFERENCES\s+"
            r"tool_approvals\s*\(\s*approval_id\s*\)",
            body,
            re.IGNORECASE,
        ))
    )
    gate.require(
        "R4 additive DDL: approval delivery table/indexes are guarded",
        delivery_shape and all(delivery_indexes.values()),
        "approval_deliveries and both declared indexes need exact IF NOT EXISTS DDL",
    )
    gate.require(
        "R4 additive DDL: approval expiry index is guarded",
        bool(expiry_index),
        f"missing exact CREATE INDEX IF NOT EXISTS {APPROVAL_EXPIRY_INDEX}(status, expires_at)",
    )

    statements = [
        delivery_table,
        *delivery_indexes.values(),
        expiry_index,
    ]
    if gateway_ddl is None or not all(statements) or not delivery_shape:
        gate.require(
            "R4 SQLite: proposed delivery/expiry DDL executes and repeats",
            False,
            "skipped because source-pinned gateway DDL or exact proposal DDL was unavailable",
        )
        return
    try:
        with closing(sqlite3.connect(":memory:")) as state:
            state.executescript(gateway_ddl.decode("utf-8"))
            for item in additions:
                if item.get("name") not in _columns(state, "tool_approvals"):
                    state.execute(item["sql"])
            proposal = ";\n".join(
                statement.rstrip().rstrip(";")
                for statement in statements
            ) + ";"
            state.executescript(proposal)
            first = _sqlite_objects(state)
            state.executescript(proposal)
            second = _sqlite_objects(state)
            installed = {
                name: tuple(
                    str(row[2])
                    for row in state.execute(f'PRAGMA index_info("{name}")')
                )
                for name in set(DELIVERY_INDEXES) | {APPROVAL_EXPIRY_INDEX}
            }
            expected_indexes = {
                **DELIVERY_INDEXES,
                APPROVAL_EXPIRY_INDEX: ("status", "expires_at"),
            }
            delivery_fks = {
                f"{row[3]} -> {row[2]}({row[4]})"
                for row in state.execute(
                    'PRAGMA foreign_key_list("approval_deliveries")'
                )
            }
            condition = (
                first == second
                and first.get("approval_deliveries") == "table"
                and installed == expected_indexes
                and delivery_fks == {"approval_id -> tool_approvals(approval_id)"}
            )
            detail = (
                f"indexes={_stable_repr(installed)} "
                f"fks={_stable_repr(delivery_fks)} repeat_equal={first == second}"
            )
    except (UnicodeDecodeError, sqlite3.Error) as exc:
        condition = False
        detail = str(exc)
    gate.require(
        "R4 SQLite: proposed delivery/expiry DDL executes and repeats",
        condition,
        detail,
    )


def _validate_sqlite_fixtures(
    gate: Gate,
    gateway_ddl: bytes,
    collab_ddl: bytes,
    expectations: dict[str, Any],
    additions: list[dict[str, str]],
) -> None:
    """Execute source-pinned DDL in two separate, disposable SQLite databases.

    The target ALTER model is applied only to the gateway fixture.  A seeded
    approval and skill draft make row/value/rowid preservation observable
    instead of merely asserted in prose.
    """
    try:
        # Independent in-memory connections are distinct temporary SQLite
        # databases.  They avoid filesystem cleanup/locking affecting the
        # deterministic verdict while still proving the two schemas are never
        # concatenated into one connection.
        with (
            closing(sqlite3.connect(":memory:")) as state,
            closing(sqlite3.connect(":memory:")) as collab,
        ):
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
                    and state is not collab,
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
    surface_security = _table_body(text, "gateway_surface_security")
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
        "R4 identity: ConnectionAuthContext remains connection-scoped",
        _paragraph_with(text, ("ConnectionAuthContext", "server-derived", "connection-scoped"))
        and _paragraph_with(text, ("session", "multiple", "concurrent", "surfaces")),
        "the current presenting connection, not a durable session row, owns ConnectionAuthContext",
    )
    gate.require(
        "R4 identity: immutable request-keyed task origin",
        _paragraph_with(text, ("gateway_task_origins", "immutable", "request_id")),
        "gateway_task_origins must key the immutable ingress snapshot by request_id",
    )
    delegations = _table_body(text, "gateway_profile_delegations")
    gate.require(
        "R4 profile: live delegation keyed by surface and profile",
        bool(delegations)
        and bool(re.search(r"(?m)^\s*surface_id\s+TEXT\s+NOT\s+NULL", delegations, re.IGNORECASE))
        and bool(re.search(r"(?m)^\s*profile_id\s+TEXT\s+NOT\s+NULL", delegations, re.IGNORECASE))
        and bool(re.search(
            r"UNIQUE\s+INDEX[\s\S]{0,180}\(\s*surface_id\s*,\s*profile_id\s*\)[\s\S]{0,80}revoked_at\s+IS\s+NULL",
            text,
            re.IGNORECASE,
        ))
        and _paragraph_with(text, ("gateway_profile_delegations", "multiple", "profiles", "per surface")),
        "one profile per surface is invalid; live delegation uniqueness is (surface_id, profile_id)",
    )
    gate.require(
        "R4 profile: source-owned EffectiveProfile revisions rechecked",
        "EffectiveProfile.policyHash" in text
        and "toolRegistryVersion" in text
        and _paragraph_with(text, ("EffectiveProfile", "source-owned"))
        and any(
            "recheck" in paragraph.casefold()
            and "policy" in paragraph.casefold()
            and "registry" in paragraph.casefold()
            and "delegation" in paragraph.casefold()
            for paragraph in re.split(r"\n\s*\n", text)
        ),
        "source-owned EffectiveProfile policyHash/toolRegistryVersion and live delegation must be rechecked",
    )
    gate.require(
        "R4 authority: Origin independent of Authority",
        "Origin independent of Authority" in text,
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
    configured_role = bool(re.search(
        r"(?m)^\s*surface_role\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+['\"]agent['\"]"
        r"[\s\S]{0,160}CHECK\s*\(\s*surface_role\s+IN\s*"
        r"\(\s*['\"]operator['\"]\s*,\s*['\"]agent['\"]\s*,\s*"
        r"['\"]automation['\"]\s*\)\s*\)",
        surfaces,
        re.IGNORECASE,
    ))
    effective_role = bool(re.search(
        r"(?m)^\s*surface_role\s+TEXT\s+NOT\s+NULL\s*"
        r"[\s\S]{0,160}CHECK\s*\(\s*surface_role\s+IN\s*"
        r"\(\s*['\"]operator['\"]\s*,\s*['\"]agent['\"]\s*,\s*"
        r"['\"]automation['\"]\s*\)\s*\)",
        surface_security,
        re.IGNORECASE,
    ))
    gate.require(
        "R4 CT-2: configured and effective role columns pinned",
        configured_role and effective_role,
        "surfaces and gateway_surface_security need the exact three-role CT-2 discriminator",
    )
    try:
        ct2 = section(
            text,
            "3.14 CT-2 — `approve` authority provisioning rule (FROZEN, normative)",
            level=3,
        )
    except ValueError:
        ct2 = ""
    gate.require(
        "R4 CT-2: configured truth projects grant-last to state enforcement",
        _paragraph_with(ct2, (
            "surfaces.surface_role = 'operator'",
            "configured truth",
            "gateway_surface_security.surface_role",
            "grant-last",
            "epoch-current",
        )),
        "CT-2 must distinguish configured collab truth from epoch-current state enforcement",
    )
    gate.require(
        "R4 CT-2: decision is state-only and fail-closed on projection drift",
        _paragraph_with(ct2, (
            "reads only `state.db`",
            "gateway_surface_security.surface_role='operator'",
            "current live auth epoch/source revision",
            "holdsAuthority",
        ))
        and _paragraph_with(ct2, (
            "decision never performs a cross-WAL read",
            "missing",
            "stale",
            "revoked",
            "observed-divergent",
            "denies",
        )),
        "decision must use only live state projection and deny missing/stale/revoked/divergent evidence",
    )
    property_detail = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "3.5 (prop 1 detail)" in paragraph
        ),
        "",
    )
    gate.require(
        "R4 authority: same-origin authorized operator positive path",
        bool(property_detail)
        and "same-origin operator path" in property_detail.casefold()
        and "operator-role surface" in property_detail.casefold()
        and "live current-epoch `approve` grant" in property_detail
        and "MAY approve a task it originated" in property_detail
        and "resource/task authz" in property_detail.casefold(),
        "same-origin is allowed only for an operator-role surface with live authority and task authz",
    )
    gate.require(
        "R4 authority: channel self-approval structurally denied",
        bool(property_detail)
        and "self-approve" in property_detail.casefold()
        and "equals `origin_surface_id`" in property_detail
        and "channel/automation" in property_detail.casefold()
        and "refused" in property_detail.casefold()
        and "fail both the kind/role gate" in property_detail.casefold(),
        "a channel/automation deciding surface equal to origin_surface_id must be refused",
    )


def _validate_profile_registry_contract(gate: Gate, text: str) -> None:
    expected_columns = {
        "gateway_profile_delegations": "registry_enforcement_hash",
        "gateway_task_origins": "registry_enforcement_hash",
        "gateway_approval_bindings": "registered_registry_enforcement_hash",
        "gateway_action_grants": "registry_enforcement_hash",
    }
    missing_columns = []
    for table, column in expected_columns.items():
        body = _table_body(text, table)
        if not re.search(
            rf"(?m)^\s*{re.escape(column)}\s+TEXT\s+NOT\s+NULL\b",
            body,
            re.IGNORECASE,
        ):
            missing_columns.append(f"{table}.{column}")
    gate.require(
        "R4 profile: registry enforcement hash bound through all state stages",
        not missing_columns,
        f"missing={missing_columns}",
    )
    deprecated = sorted({
        token
        for token in (
            "effective_profile_hash",
            "path_policy_revision",
            "registered_path_policy_revision",
        )
        if re.search(rf"\b{re.escape(token)}\b", text)
    })
    gate.require(
        "R4 profile: duplicate/vague profile hashes absent",
        not deprecated,
        f"deprecated profile fields present: {deprecated}",
    )
    gate.require(
        "R4 profile: policy hash is byte-identical source copy",
        _paragraph_with(text, (
            "effective_profile_policy_hash",
            "byte-identical",
            "EffectiveProfile.policyHash",
            "never a second hash definition",
        )),
        "effective_profile_policy_hash must be copied byte-identically from EffectiveProfile.policyHash",
    )
    formula = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "registry_enforcement_hash :=" in paragraph
        ),
        "",
    )
    exact_entry_keys = (
        "name",
        "sourceServerId",
        "rawName",
        "inputSchema",
        "capability",
        "requiresApproval",
        "pathScope",
        "pathArgKeys",
    )
    gate.require(
        "R4 profile: registry enforcement formula and exact material pinned",
        bool(formula)
        and 'schemaVersion:"torqclaw.registry-enforcement/v1"' in formula
        and "pathPolicyVersion:PATH_POLICY_VERSION" in formula
        and "sorted by namespaced `name`" in formula
        and all(f"`{key}`" in formula for key in exact_entry_keys)
        and "resolved sorted explicit-or-fallback" in formula
        and "tool.pathScope === undefined ? null" in formula
        and "read: sortedNormalizedRead" in formula
        and "write: sortedNormalizedWrite" in formula
        and "deny: sortedNormalizedDeny" in formula
        and "null absent scope remains distinct" in formula
        and "present `{read:[],write:[],deny:[]}`" in formula
        and "No `undefined` reaches `canonicalJson`" in formula
        and "equates null with empty MUST change" in formula
        and "Descriptions are excluded" in formula
        and "PATH_POLICY_VERSION" in formula
        and "semantics change" in formula,
        "registry hash must pin version, sorted tool set, exact enforcement keys, path normalization, and exclusions",
    )
    gate.require(
        "R4 profile: delegations are immutable and revisioned on change",
        _paragraph_with(text, (
            "delegation row is immutable",
            "material change",
            "revokes",
            "new row",
            "profile_delegation_revision",
            "never updated in place",
        )),
        "effective/profile/registry changes must revoke and replace the delegation at a new revision",
    )
    gate.require(
        "R4 profile: security hash binds registry enforcement",
        "registryEnforcementHash: gateway_profile_delegations.registry_enforcement_hash" in text
        and _paragraph_with(text, (
            "registration",
            "decision",
            "pre-execution",
            "registry-enforcement hash",
        )),
        "security context and every admission stage must bind the registry enforcement hash",
    )


def _validate_approval_state(gate: Gate, text: str) -> None:
    gate.require(
        "R4 approval: canonical state and one centralized writer",
        _paragraph_with(text, ("tool_approvals", "canonical", "approval state"))
        and _paragraph_with(text, ("Single-writer requirement", "one centralized writer"))
        and _paragraph_with(text, ("No other module", "approval status")),
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
        _paragraph_with_affirmed(
            text,
            ("exact", "grant", "consum", "state.db", "dispatch"),
            "consumes the grant",
        ),
        "one exact grant must be consumed with the state.db dispatch admission check",
    )
    gate.require(
        "R4 approval: canonicalJson hash checked against regenerated actual args",
        any(
            "canonicaljson" in paragraph.casefold()
            and "hash" in paragraph.casefold()
            and "registration" in paragraph.casefold()
            and "regenerated" in paragraph.casefold()
            and "actual" in paragraph.casefold()
            and ("pre-execute" in paragraph.casefold() or "before execution" in paragraph.casefold())
            for paragraph in re.split(r"\n\s*\n", text)
        ),
        "register the canonicalJson hash and compare regenerated actual tool args at the pre-execute seam",
    )
    registration_args = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "new flag-on C2 registration" in paragraph
        ),
        "",
    )
    gate.require(
        "R4 action args: present plain object with explicit empty-object no-arg",
        bool(registration_args)
        and "requires a present acyclic plain JSON object" in registration_args
        and "a no-argument tool supplies `{}`" in registration_args
        and "root arrays/scalars" in registration_args
        and "canonicalJson(args)" in registration_args
        and "canonicalJson(args ?? null)" not in registration_args
        and "no null/falsey coercion" in registration_args,
        "new C2 args must be a present plain object; no-arg is {}, never null/falsey coercion",
    )
    action_formula = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "`ACTIONHASH_V1` is SHA-256" in paragraph
        ),
        "",
    )
    gate.require(
        "R4 ACTIONHASH_V1: exact formula and pre-execute comparison",
        bool(action_formula)
        and "ASCII version tag" in action_formula
        and "three required U32BE-length-prefixed UTF-8 fields in order" in action_formula
        and "exact stored `request_id`" in action_formula
        and "exact namespaced `tool_name`" in action_formula
        and "canonicalJson(args)" in action_formula
        and "no NULL encoding" in action_formula
        and "true pre-execute hook" in action_formula,
        "ACTIONHASH_V1 must frame source request, namespaced tool, and canonical object args",
    )
    action_vector = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "Frozen `ACTIONHASH_V1` vector" in paragraph
        ),
        "",
    )
    action_match = re.search(
        r"source request `([^`]+)`, canonical operation `([^`]+)`, and "
        r"canonical args `([^`]+)` produce a (\d+)-byte framed stream and "
        r"lowercase SHA-256 `([0-9a-f]{64})`",
        action_vector,
    )
    observed_action = _framed_sha256("ACTIONHASH_V1", ACTIONHASH_VECTOR_FIELDS)
    action_declared = (
        (*action_match.groups()[:3], int(action_match.group(4)), action_match.group(5))
        if action_match else None
    )
    action_expected = (
        *ACTIONHASH_VECTOR_FIELDS,
        ACTIONHASH_VECTOR_LENGTH,
        ACTIONHASH_VECTOR_DIGEST,
    )
    gate.require(
        "R4 ACTIONHASH_V1: independently reproduced golden vector",
        action_declared == action_expected
        and observed_action == (
            (36, 22, 16),
            ACTIONHASH_VECTOR_LENGTH,
            ACTIONHASH_VECTOR_DIGEST,
        ),
        f"declared={_stable_repr(action_declared)} observed={_stable_repr(observed_action)}",
    )
    gate.require(
        "R4 approval: payload persistence reserved for future approval",
        _paragraph_with(text, ("payload", "reserved", "future", "operator", "retention")),
        "no protected payload store ships until protection/retention receives operator approval",
    )
    for table in (
        "gateway_task_origins",
        "gateway_approval_bindings",
        "gateway_action_grants",
    ):
        body = _table_body(text, table)
        gate.require(
            f"R4 profile: {table} binds delegation id and revision",
            bool(body)
            and bool(re.search(r"(?m)^\s*\w*delegation_id\s+TEXT\s+NOT\s+NULL", body, re.IGNORECASE))
            and bool(re.search(r"(?m)^\s*\w*delegation_revision\s+INTEGER\s+NOT\s+NULL", body, re.IGNORECASE)),
            f"{table} must carry the exact task-selected delegation id and revision",
        )
    grants = _table_body(text, "gateway_action_grants")
    gate.require(
        "R4 grant: dispatch task is FK-backed and unique",
        bool(re.search(
            r"(?m)^\s*dispatch_request_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b",
            grants,
            re.IGNORECASE,
        ))
        and bool(re.search(
            r"FOREIGN\s+KEY\s*\(\s*dispatch_request_id\s*\)\s*"
            r"REFERENCES\s+tasks\s*\(\s*request_id\s*\)",
            grants,
            re.IGNORECASE,
        )),
        "gateway_action_grants.dispatch_request_id must uniquely reference tasks(request_id)",
    )
    lifecycle = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", text)
            if "dispatch_request_id is not a free-standing nonce" in paragraph
            or "`dispatch_request_id` is not a free-standing nonce" in paragraph
        ),
        "",
    )
    gate.require(
        "R4 grant: re-mint task, decision, and grant share one transaction",
        bool(lifecycle)
        and "winning `state.db` decision transaction" in lifecycle
        and "creates the corresponding re-minted `tasks` row" in lifecycle
        and "grant that references both source and dispatch tasks" in lifecycle
        and "whole transaction rolls back" in lifecycle,
        "the dispatch task must be created atomically with canonical decision evidence and grant",
    )
    gate.require(
        "R4 grant: committed crash residue never auto-dispatches",
        bool(lifecycle)
        and "process crashes before admission" in lifecycle
        and "recovery revokes the grant" in lifecycle
        and "never creates a second re-mint or dispatches automatically" in lifecycle
        and _paragraph_with(text, (
            "crash after approval/grant",
            "never automatically dispatches",
            "revokes the inert grant",
            "requires reissue",
        )),
        "post-commit/pre-admission crash recovery is revoke-and-reissue only",
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
    state_tables = STATE_ADDITIVE_OBJECTS
    collab_names = COLLAB_BASELINE_OBJECTS | COLLAB_ADDITIVE_OBJECTS
    state_cross_refs: dict[str, list[str]] = {}
    for table in sorted(state_tables):
        body = _table_body(text, table)
        refs = {
            name
            for name in re.findall(
                r"REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)",
                body,
                re.IGNORECASE,
            )
            if name in collab_names
        }
        if refs:
            state_cross_refs[table] = sorted(refs)
    state_names = STATE_BASELINE_OBJECTS | STATE_ADDITIVE_OBJECTS
    collab_cross_refs: dict[str, list[str]] = {}
    for table in sorted(COLLAB_ADDITIVE_OBJECTS):
        body = _table_body(text, table)
        refs = {
            name
            for name in re.findall(
                r"REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)",
                body,
                re.IGNORECASE,
            )
            if name in state_names
        }
        if refs:
            collab_cross_refs[table] = sorted(refs)
    gate.require(
        "R4 cross-DB: no cross-database foreign keys",
        not state_cross_refs
        and not collab_cross_refs
        and (
            _paragraph_with(text, ("no", "cross-database", "foreign key"))
            or _paragraph_with(text, ("cannot", "cross-database", "foreign key"))
            or bool(re.search(
                r'"cross_database_fk"\s*:\s*"forbidden"',
                text,
                re.IGNORECASE,
            ))
        ),
        f"state_to_collab={_stable_repr(state_cross_refs)} collab_to_state={_stable_repr(collab_cross_refs)}",
    )


def _validate_matrix_and_c2_c3_scope(gate: Gate, text: str) -> None:
    try:
        matrix = section(text, "4. Source-of-truth matrix", level=2)
    except ValueError:
        matrix = ""
    rows: dict[str, str] = {}
    for line in matrix.splitlines():
        if not line.startswith("|"):
            continue
        cells = [re.sub(r"[*`]", "", cell).strip() for cell in line.strip("|").split("|")]
        if len(cells) >= 2:
            rows[cells[0]] = cells[1]
    expected_owners = {
        "Surface": "collab.db.surfaces",
        "Configured surface capability": "collab.db.surfaces.capability_json",
        "Effective surface capability": "state.db.gateway_surface_security",
        "Effective profile delegation": "state.db.gateway_profile_delegations",
        "Session (execution/replay)": "state.db.sessions",
        "Connection/task origin evidence": "state.db.gateway_task_origins",
        "Approval authority (who may decide)": "state.db.surface_authorities",
        "Approval state / display audit": "state.db.tool_approvals",
        "Immutable registration binding": "state.db.gateway_approval_bindings",
        "Decision evidence": "tool_approvals.decided_",
        "Action grant (one-shot consumption, §1.4)": "state.db.gateway_action_grants",
        "Approval expiry": "tool_approvals.status='expired'",
        "Approval delivery": "approval_deliveries",
    }
    ownership_mismatches = {
        concept: {"expected": owner, "actual": rows.get(concept)}
        for concept, owner in expected_owners.items()
        if owner not in rows.get(concept, "")
    }
    gate.require(
        "R4 matrix: authoritative owners pinned",
        not ownership_mismatches,
        _stable_repr(ownership_mismatches),
    )

    try:
        c2 = section(
            text,
            "3.4.2 C2 behavior — registration may wait; decision→dispatch stays SYNCHRONOUS",
            level=4,
        )
    except ValueError:
        c2 = ""
    gate.require(
        "R4 scope: C2 synchronous registration/decision/admission semantics",
        "in C2 there is no asynchronous decision-delivery→apply gap" in c2
        and "request/registration→decision wait" in c2
        and "guarded decision transaction atomically creates" in c2
        and "synchronous admission fence" in c2
        and "C2 still MUST NOT invent an asynchronous/offline apply seam" in c2,
        "C2 section must own pending-context comparison and synchronous pre-tool admission only",
    )
    try:
        c3 = section(
            text,
            "3.4.3 Property 10 deferred to C3 — the real decide≠apply seam (property-6-vs-10 collision is latent-until-C3)",
            level=4,
        )
    except ValueError:
        c3 = ""
    gate.require(
        "R4 scope: C3 asynchronous apply semantics remain deferred",
        "decision-delivery→apply seam" in c3
        and "DEFERRED to C3" in c3
        and "property 10 WINS over property 6" in c3
        and "LATENT-UNTIL-C3" in c3
        and "a **C3** invariant" in c3,
        "only C3 may own future asynchronous decision-delivery/apply revalidation",
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
    framing = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", inputs)
            if "Frozen serializer vector (framing-only)" in paragraph
        ),
        "",
    )
    framing_match = re.search(
        r"UTF-8 byte lengths are `([0-9,]+)`, total framed input length is "
        r"`(\d+)`, and the SHA-256 is `([0-9a-f]{64})`",
        framing,
    )
    framing_declared = (
        (
            tuple(int(item) for item in framing_match.group(1).split(",")),
            int(framing_match.group(2)),
            framing_match.group(3),
        )
        if framing_match else None
    )
    framing_observed = _framed_sha256("CTXHASH_V1", CTXHASH_FRAMING_FIELDS)
    gate.require(
        "R4 CTXHASH_V1: framing-only golden vector retained",
        framing_declared
        == (CTXHASH_FRAMING_LENGTHS, CTXHASH_FRAMING_TOTAL, CTXHASH_FRAMING_DIGEST)
        and framing_observed == framing_declared
        and all(f"`{field}`" in framing for field in CTXHASH_FRAMING_FIELDS[:9])
        and "64 lowercase `c` characters" in framing
        and "do **not** satisfy the semantic inner-digest contract" in framing,
        f"declared={_stable_repr(framing_declared)} observed={_stable_repr(framing_observed)}",
    )

    semantic = next(
        (
            paragraph for paragraph in re.split(r"\n\s*\n", inputs)
            if "Frozen end-to-end semantic vector" in paragraph
        ),
        "",
    )
    # The fixture block is its own Markdown paragraph immediately after the
    # semantic-vector introduction, so search the section rather than only
    # the introductory paragraph.
    # `inputs` comes from raw bytes decoded WITHOUT newline translation (see
    # _without_block), so on a core.autocrlf=true checkout — the configuration
    # this repo's own _worktree_text_to_git_bytes docstring records — each
    # fixture line ends "\r\n" and a bare `$` after `}` never matches. `\r?$`
    # keeps the gate's verdict identical between LF and CRLF materializations
    # of the same blob without weakening the check: an absent or wrong fixture
    # object still fails here and at the digest comparisons below.
    semantic_objects: dict[str, Any] = {}
    for name in ("privacy", "routing", "security"):
        match = re.search(rf"(?m)^{name}\s*=\s*(\{{.*\}})\r?$", inputs)
        if not match:
            continue
        try:
            semantic_objects[name] = json.loads(match.group(1))
        except json.JSONDecodeError:
            semantic_objects[name] = "<invalid-json>"
    gate.require(
        "R4 CTXHASH_V1: semantic fixture objects pinned",
        bool(semantic) and semantic_objects == CTXHASH_SEMANTIC_OBJECTS,
        f"observed={_stable_repr(semantic_objects)}",
    )
    semantic_hashes = {
        name: hashlib.sha256(_canonical_json_bytes(value)).hexdigest()
        for name, value in semantic_objects.items()
        if isinstance(value, dict)
    }
    hash_match = re.search(
        r"required lowercase hashes are f8 `([0-9a-f]{64})`, f9 "
        r"`([0-9a-f]{64})`, and f10 `([0-9a-f]{64})`",
        inputs,
    )
    declared_hashes = (
        dict(zip(("privacy", "routing", "security"), hash_match.groups(), strict=True))
        if hash_match else None
    )
    gate.require(
        "R4 CTXHASH_V1: semantic inner hashes independently reproduced",
        semantic_hashes == CTXHASH_SEMANTIC_HASHES
        and declared_hashes == CTXHASH_SEMANTIC_HASHES,
        f"declared={_stable_repr(declared_hashes)} observed={_stable_repr(semantic_hashes)}",
    )
    final_match = re.search(
        r"final field lengths are `([0-9,]+)`, total framed length is `([0-9]+)`, "
        r"and `CTXHASH_V1` is `([0-9a-f]{64})`",
        inputs,
    )
    final_declared = (
        (
            tuple(int(item) for item in final_match.group(1).split(",")),
            int(final_match.group(2)),
            final_match.group(3),
        )
        if final_match else None
    )
    semantic_fields = (
        *CTXHASH_FRAMING_FIELDS[:7],
        *(semantic_hashes.get(name, "") for name in ("privacy", "routing", "security")),
    )
    final_observed = _framed_sha256("CTXHASH_V1", semantic_fields)
    gate.require(
        "R4 CTXHASH_V1: end-to-end semantic vector independently reproduced",
        final_declared
        == (CTXHASH_SEMANTIC_LENGTHS, CTXHASH_SEMANTIC_TOTAL, CTXHASH_SEMANTIC_DIGEST)
        and final_observed == final_declared,
        f"declared={_stable_repr(final_declared)} observed={_stable_repr(final_observed)}",
    )


def _qualified_python_name(node: ast.AST) -> str:
    """Return a stable dotted name for the simple call forms used here."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _qualified_python_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def _top_level_function(
    tree: ast.Module | None,
    name: str,
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    if tree is None:
        return None
    matches = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    ]
    return matches[0] if len(matches) == 1 else None


def _python_calls(node: ast.AST | None) -> set[str]:
    if node is None:
        return set()
    return {
        name
        for item in ast.walk(node)
        if isinstance(item, ast.Call)
        if (name := _qualified_python_name(item.func))
    }


def _python_decorators(
    node: ast.FunctionDef | ast.AsyncFunctionDef | None,
) -> set[str]:
    if node is None:
        return set()
    names: set[str] = set()
    for decorator in node.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        name = _qualified_python_name(target)
        if name:
            names.add(name)
    return names


def _literal_error_shapes(node: ast.AST | None) -> list[dict[str, Any]]:
    """Collect literal fields from dicts without requiring every value literal."""
    if node is None:
        return []
    shapes: list[dict[str, Any]] = []
    for item in ast.walk(node):
        if not isinstance(item, ast.Dict):
            continue
        fields: dict[str, Any] = {}
        for key, value in zip(item.keys, item.values, strict=True):
            if (
                isinstance(key, ast.Constant)
                and isinstance(key.value, str)
                and isinstance(value, ast.Constant)
            ):
                fields[key.value] = value.value
        if isinstance(fields.get("code"), str):
            shapes.append(fields)
    return shapes


def _code_retryability_assignments(node: ast.AST | None) -> dict[str, bool]:
    """Read the mapper's explicit ``code, retryable = <literal>, <bool>`` arms."""
    if node is None:
        return {}
    assignments: dict[str, bool] = {}
    for item in ast.walk(node):
        if not isinstance(item, ast.Assign) or len(item.targets) != 1:
            continue
        target = item.targets[0]
        value = item.value
        if not (
            isinstance(target, (ast.Tuple, ast.List))
            and isinstance(value, (ast.Tuple, ast.List))
            and len(target.elts) == len(value.elts) == 2
            and all(isinstance(part, ast.Name) for part in target.elts)
            and [part.id for part in target.elts] == ["code", "retryable"]
            and isinstance(value.elts[0], ast.Constant)
            and isinstance(value.elts[0].value, str)
            and isinstance(value.elts[1], ast.Constant)
            and isinstance(value.elts[1].value, bool)
        ):
            continue
        assignments[value.elts[0].value] = value.elts[1].value
    return assignments


def _validate_governed_skill_source(gate: Gate, repo: Path) -> None:
    """Bind §10.4 to shipped kernel source without claiming gateway reachability."""
    trees: dict[str, ast.Module] = {}
    source_errors: dict[str, str] = {}
    for key, relative in GOVERNED_SOURCE_PATHS.items():
        path = repo / relative
        try:
            trees[key] = ast.parse(path.read_text(encoding="utf-8"), filename=relative)
        except (OSError, SyntaxError, UnicodeError) as exc:
            source_errors[key] = f"{type(exc).__name__}: {exc}"
    gate.require(
        "R4 source: governed kernel files parse",
        not source_errors and set(trees) == set(GOVERNED_SOURCE_PATHS),
        _stable_repr(source_errors or {"missing": sorted(set(GOVERNED_SOURCE_PATHS) - set(trees))}),
    )

    mapper = _top_level_function(trees.get("mapper"), "map_activation_failure")
    decide = _top_level_function(trees.get("queue"), "decide")
    rollback = _top_level_function(trees.get("rollback"), "rollback")
    rollback_tool = _top_level_function(trees.get("server"), "rollback_skill")
    versions_tool = _top_level_function(trees.get("server"), "list_skill_versions")

    mapper_call = "governed_skills.map_activation_failure"
    call_sites = {
        "skill_queue.decide": mapper_call in _python_calls(decide),
        "skill_rollback.rollback": mapper_call in _python_calls(rollback),
    }
    gate.require(
        "R4 source: shared activation-failure mapper call sites",
        all(call_sites.values()),
        _stable_repr(call_sites),
    )

    mapper_literals = {
        item.value
        for item in ast.walk(mapper)
        if isinstance(item, ast.Constant)
        and isinstance(item.value, str)
        and item.value.startswith("SKILL_")
    } if mapper is not None else set()
    copied_shapes = {
        source: sorted(
            shape["code"]
            for shape in _literal_error_shapes(node)
            if shape["code"] in SHARED_MAPPER_CODES
        )
        for source, node in {
            "skill_queue.decide": decide,
            "skill_rollback.rollback": rollback,
        }.items()
    }
    copied_literals = {
        source: sorted({
            item.value
            for item in ast.walk(node)
            if isinstance(item, ast.Constant)
            and isinstance(item.value, str)
            and item.value in SHARED_MAPPER_CODES
        }) if node is not None else []
        for source, node in {
            "skill_queue.decide": decide,
            "skill_rollback.rollback": rollback,
        }.items()
    }
    gate.require(
        "R4 source: mapper owns mapped error dictionaries",
        mapper_literals == SHARED_MAPPER_CODES
        and all(not codes for codes in copied_shapes.values())
        and all(not codes for codes in copied_literals.values()),
        f"mapper_codes={_stable_repr(mapper_literals)} "
        f"copied_shapes={_stable_repr(copied_shapes)} "
        f"copied_literals={_stable_repr(copied_literals)}",
    )

    retryability = _code_retryability_assignments(mapper)
    unproven_retryability = {
        code: retryability.get(code)
        for code in sorted(UNPROVEN_CODES)
    }
    gate.require(
        "R4 source: UNPROVEN codes are non-retryable",
        unproven_retryability == {code: False for code in sorted(UNPROVEN_CODES)},
        _stable_repr(unproven_retryability),
    )

    rollback_shapes = _literal_error_shapes(rollback)
    direct_shapes = {
        str(shape["code"]): shape.get("retryable")
        for shape in rollback_shapes
        if shape["code"] in DIRECT_ROLLBACK_CODES
    }
    gate.require(
        "R4 source: rollback owns direct validation codes",
        direct_shapes == {code: False for code in DIRECT_ROLLBACK_CODES},
        _stable_repr(direct_shapes),
    )

    registrations = {
        "rollback_skill": (
            "mcp.tool" in _python_decorators(rollback_tool)
            and "skill_rollback.rollback" in _python_calls(rollback_tool)
        ),
        "list_skill_versions": (
            "mcp.tool" in _python_decorators(versions_tool)
            and "skill_rollback.list_versions" in _python_calls(versions_tool)
        ),
    }
    gate.require(
        "R4 source: governed MCP tools registered",
        all(registrations.values()),
        _stable_repr(registrations),
    )


def _validate_gs_accept_receipt(gate: Gate, repo: Path, text: str) -> None:
    receipt_path = repo / GS_ACCEPT_RECEIPT_PATH
    try:
        receipt = receipt_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        gate.require(
            "R4 GS receipt: immutable source result read",
            False,
            f"{type(exc).__name__}: {exc}",
        )
        receipt = ""
    receipt_result = re.search(
        r"Result:\s*\*\*(\d+) passed, (\d+) xfailed\*\*",
        receipt,
    )
    receipt_commit = re.search(r"against merged master \(`([0-9a-f]{7,40})`\)", receipt)
    observed = (
        int(receipt_result.group(1)),
        int(receipt_result.group(2)),
        receipt_commit.group(1) if receipt_commit else None,
    ) if receipt_result else None
    gate.require(
        "R4 GS receipt: immutable source result read",
        observed == (8, 2, "83690f3"),
        f"path={GS_ACCEPT_RECEIPT_PATH} observed={_stable_repr(observed)}",
    )
    handoff_report = bool(re.search(
        r"(?:lane\s+)?handoff\s+(?:reports|reported)[^.\n]{0,180}"
        r"9\s+passed\s*/\s*1\s+xfail(?:ed)?",
        text,
        re.IGNORECASE,
    ))
    false_repository_record = bool(re.search(
        r"repository\s+(?:record|receipt)[^.\n]{0,180}"
        r"9\s+passed\s*/\s*1\s+xfail(?:ed)?",
        text,
        re.IGNORECASE,
    ))
    receipt_claim = bool(re.search(
        rf"{re.escape(GS_ACCEPT_RECEIPT_PATH)}[^.\n]{{0,180}}"
        r"8\s+passed\s*/\s*2\s+xfail(?:ed)?[^.\n]{0,100}`?83690f3`?",
        text,
        re.IGNORECASE,
    )) or bool(re.search(
        rf"{re.escape(GS_ACCEPT_RECEIPT_PATH)}[^\n]{{0,240}}"
        r"8\s+passed\s*/\s*2\s+xfail(?:ed)?",
        text,
        re.IGNORECASE,
    ))
    gate.require(
        "R4 GS receipt: handoff and repository evidence distinguished",
        handoff_report and receipt_claim and not false_repository_record,
        f"handoff={handoff_report} receipt={receipt_claim} false_record={false_repository_record}",
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
        and "skill_queue.decide()" in text
        and bool(re.search(
            r"(?:never|must\s+not|not)\s+cop(?:y|ied)|not\s+reimplement",
            mapper_paragraph,
            re.IGNORECASE,
        )),
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
            if "UNPROVEN" in paragraph
            and "non-retryable" in paragraph.casefold()
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
        _paragraph_with_affirmed(
            text, ("rollback_skill", "re-enables", "disabled", "by design"), "re-enables",
        ),
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
            and any(term in paragraph.casefold() for term in ("never", "must not", "reject"))
            and ("copi" in paragraph.casefold() or "derived" in paragraph.casefold())
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
        any(
            "failure report" in paragraph.casefold()
            and (
                "preserve" in paragraph.casefold()
                or (
                    "never" in paragraph.casefold()
                    and "overwrite" in paragraph.casefold()
                )
            )
            for paragraph in paragraphs
        ),
        "a later path must never overwrite failure evidence",
    )
    gate.require(
        "R4 evidence: future proof launches real hashed artifact",
        any(
            "launch" in paragraph.casefold()
            and "real artifact" in paragraph.casefold()
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
        or any(
            "design" in paragraph.casefold()
            and "sqlite-model" in paragraph.casefold()
            and "only" in paragraph.casefold()
            and "runtime-success" in paragraph.casefold()
            for paragraph in re.split(r"\n\s*\n", text)
        ),
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


def _validate_final_review_closeouts(gate: Gate, text: str) -> None:
    gate.require(
        "R4 CT-2 provisioning: authority insert is state-only",
        _paragraph_with(
            text,
            (
                "grantAuthority(surfaceId, authority)",
                "no cross-WAL read",
                "same `state.db` transaction",
                "current live projected kind/role/auth epoch/source revision",
            ),
        ),
        "grantAuthority must validate the already-activated projection in one state.db transaction without a cross-WAL read",
    )
    gate.require(
        "R4 grant: finite TTL has an exact source and admission writer",
        _paragraph_with(
            text,
            (
                "Grant expiry is distinct",
                "canonical_now + GRANT_TTL_SECONDS",
                "never copies the approval row's deadline",
                "finite",
                "expires_at<=canonical_now",
                "revoked",
                "expires_at>canonical_now",
            ),
        ),
        "the one-shot grant needs its own finite TTL formula plus lazy expiry/revocation at admission",
    )
    gate.require(
        "R4 delivery: revoked targets excluded without changing approval truth",
        _paragraph_with(
            text,
            (
                "Rebuild/reconnect excludes revoked",
                "no eligible operator surface exists",
                "remains canonically `pending`",
                "delivery-failed",
                "no card is offered to the revoked target",
                "no delivery failure changes approval state",
            ),
        ),
        "delivery rebuild must exclude revoked targets and leave canonical approval state unchanged",
    )

    questions = section(text, "12. Open questions for the operator (not guessed)", level=2)
    missing_metadata: list[str] = []
    for number in (1, 2, 3, 5, 6, 8):
        match = re.search(
            rf"(?m)^- \*\*OQ-{number}\b([^\n]*)\*\*",
            questions,
        )
        heading = match.group(1).casefold() if match else ""
        if "owner:" not in heading or "deadline:" not in heading:
            missing_metadata.append(f"OQ-{number}")
    gate.require(
        "R4 open questions: named owners and gate-relative deadlines",
        not missing_metadata,
        "missing owner/deadline metadata: " + ", ".join(missing_metadata),
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
    _validate_delivery_and_expiry_ddl(
        gate,
        fixture_free_text,
        expected_gateway if gateway_matches else None,
        additions,
    )
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
    _validate_profile_registry_contract(gate, fixture_free_text)
    _validate_approval_state(gate, fixture_free_text)
    _validate_cross_database_protocol(gate, fixture_free_text)
    _validate_matrix_and_c2_c3_scope(gate, fixture_free_text)
    _validate_ctxhash(gate, fixture_free_text)
    _validate_governed_skill_boundary(gate, fixture_free_text)
    _validate_governed_skill_source(gate, repo)
    _validate_gs_accept_receipt(gate, repo, fixture_free_text)
    _validate_evidence_honesty(gate, fixture_free_text, pregate)
    _validate_final_review_closeouts(gate, fixture_free_text)


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

    # §4 source-of-truth matrix row coverage. The nine required concepts
    # (Surface, SurfaceCredential, surface capability, approval origin,
    # approval authority, approval delivery, approval expiry, decision
    # evidence, context binding) are exactly the key set of
    # `sot_row_markers` below — there is deliberately no separate
    # `sot_required_rows` list: the matrix uses close-but-not-identical row
    # labels, so each required concept is mapped directly to a regex marker
    # known to appear in its matrix row, and the marker dict's keys ARE the
    # required-concept list. A prior revision kept a `sot_required_rows`
    # list alongside this dict; it was never read (the loop below iterates
    # `sot_row_markers.items()`, not the list) and duplicated the dict's
    # keys, so it was deleted rather than wired in.
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


def _report_prd_path(prd: Path, repo: Path) -> str:
    try:
        return prd.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        # Mutant/test inputs live outside the checkout.  A basename is stable
        # across machines and cannot leak a workstation-specific temp path.
        return prd.name


def render(
    prd: Path,
    gate: Gate,
    summary: str,
    repo: Path | None = None,
) -> str:
    display_path = _report_prd_path(
        prd,
        repo or Path(__file__).resolve().parents[1],
    )
    lines = [
        "# PRD-TCLAW-COLLAB-GATEWAY-004 Consistency Report", "",
        f"- PRD: `{display_path}`", f"- Result: `{summary}`", "",
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
        args.report.write_text(
            render(args.prd.resolve(), gate, summary, repo),
            encoding="utf-8",
        )
    return 1 if gate.findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
