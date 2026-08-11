from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/lint_collab_gateway_prd.py"
PRD = ROOT / "docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004.md"

SPEC = importlib.util.spec_from_file_location("lint_collab_gateway_prd", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
LINTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = LINTER
SPEC.loader.exec_module(LINTER)


def _findings(path: Path) -> set[str]:
    gate, _ = LINTER.run(path, ROOT)
    return {finding.check for finding in gate.findings}


def _write_mutation(tmp_path: Path, mutate: Callable[[str], str]) -> Path:
    original = PRD.read_text(encoding="utf-8")
    changed = mutate(original)
    assert changed != original, "mutation did not change the PRD"
    result = tmp_path / PRD.name
    result.write_text(changed, encoding="utf-8", newline="")
    return result


def _copy_governed_sources(tmp_path: Path) -> Path:
    repo = tmp_path / "source-repo"
    for relative in LINTER.GOVERNED_SOURCE_PATHS.values():
        source = ROOT / relative
        destination = repo / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
    return repo


def _mutate_governed_source(
    repo: Path,
    source: str,
    old: str,
    new: str,
) -> None:
    path = repo / LINTER.GOVERNED_SOURCE_PATHS[source]
    original = path.read_text(encoding="utf-8")
    assert original.count(old) >= 1, old
    path.write_text(original.replace(old, new), encoding="utf-8", newline="")


def _governed_source_findings(repo: Path) -> set[str]:
    gate = LINTER.Gate()
    LINTER._validate_governed_skill_source(gate, repo)
    return {finding.check for finding in gate.findings}


def _replace_once(old: str, new: str) -> Callable[[str], str]:
    def mutate(text: str) -> str:
        assert text.count(old) >= 1, old
        return text.replace(old, new, 1)

    return mutate


def _regex_once(pattern: str, replacement: str) -> Callable[[str], str]:
    def mutate(text: str) -> str:
        changed, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
        assert count == 1, pattern
        return changed

    return mutate


def _mutate_block(name: str, mutate: Callable[[str], str]) -> Callable[[str], str]:
    begin = f"{name}_BEGIN"
    end = f"{name}_END"

    def apply(text: str) -> str:
        start = text.index(begin) + len(begin)
        finish = text.index(end, start)
        body = text[start:finish]
        changed = mutate(body)
        assert changed != body, f"{name} mutation did not change its block"
        return text[:start] + changed + text[finish:]

    return apply


def _mutate_table(
    table: str,
    mutate: Callable[[str], str],
) -> Callable[[str], str]:
    pattern = re.compile(
        rf"(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{re.escape(table)}\s*\()"
        r"(.*?)"
        r"(\n\);)",
        re.IGNORECASE | re.DOTALL,
    )

    def apply(text: str) -> str:
        match = pattern.search(text)
        assert match is not None, table
        body = match.group(2)
        changed = mutate(body)
        assert changed != body, f"{table} mutation did not change its DDL"
        return text[:match.start()] + match.group(1) + changed + match.group(3) + text[match.end():]

    return apply


def test_canonical_revision_4_prd_passes_full_gate() -> None:
    gate, summary = LINTER.run(PRD, ROOT)
    assert not gate.findings, summary + "\n" + "\n".join(
        f"{finding.check}: {finding.detail}" for finding in gate.findings
    )
    assert "R4 compatibility: original 67 checks executed" in gate.passed
    assert LINTER.LEGACY_CHECK_COUNT == 67


def test_collab_template_pin_excludes_only_closing_indent() -> None:
    source = b"before db.exec(`\nCREATE TABLE x(a);\n    `); after"
    assert LINTER._collab_ddl(source) == b"\nCREATE TABLE x(a);\n"
    with pytest.raises(ValueError, match="four spaces"):
        LINTER._collab_ddl(b"db.exec(`\nCREATE TABLE x(a);\n  `);")


@pytest.mark.parametrize(
    ("mutation", "expected_finding"),
    [
        (
            _mutate_block(
                "BASELINE_GATEWAY_SCHEMA_AF52430",
                _replace_once("PRAGMA journal_mode = WAL;", "PRAGMA journal_mode = DELETE;"),
            ),
            "R4 baseline bytes/SHA-256: gateway schema",
        ),
        (
            _mutate_block(
                "BASELINE_COLLAB_MIGRATION_DDL_AF52430",
                _replace_once("principals_single_operator", "principals_single_operators"),
            ),
            "R4 baseline bytes/SHA-256: collaboration migration DDL",
        ),
        (
            _replace_once("## 13. Definition of done", "## 14. Definition of done"),
            "R4 structure: exactly sections 1-13",
        ),
    ],
    ids=("gateway-byte-pin", "collab-byte-pin", "sections-1-through-13"),
)
def test_baseline_and_structure_mutations_are_killed(
    tmp_path: Path,
    mutation: Callable[[str], str],
    expected_finding: str,
) -> None:
    assert expected_finding in _findings(_write_mutation(tmp_path, mutation))


@pytest.mark.parametrize(
    ("old", "new", "expected_finding"),
    [
        (
            '"state.db":"packages/gateway/db/schema.sql"',
            '"state.db":"packages/collab/src/migration.ts"',
            "R4 map: physical databases",
        ),
        (
            '"action":"extend additive"',
            '"action":"rebuild compatible"',
            "R4 map: tool_approvals additive preservation",
        ),
        (
            '"new_index":"idx_tool_approvals_status_expires"',
            '"new_index":"idx_tool_approvals_status_only"',
            "R4 map: tool_approvals additive preservation",
        ),
        (
            '"runtime":"out of scope"',
            '"runtime":"in scope"',
            "R4 map: skill_queue no-touch",
        ),
        (
            '"live_names":"preserved"',
            '"live_names":"removed"',
            "R4 map: live C0.1 and collab.db preserved",
        ),
        (
            '"grant_order":"collab identity commit then state authority activation"',
            '"grant_order":"state authority activation then collab identity commit"',
            "R4 map: fail-closed cross-database protocol",
        ),
        (
            '"automatic_grant_completion":"forbidden"',
            '"automatic_grant_completion":"allowed"',
            "R4 map: fail-closed cross-database protocol",
        ),
        (
            '"recovery":"revoke-side-only"',
            '"recovery":"grant-or-revoke"',
            "R4 map: fail-closed cross-database protocol",
        ),
        (
            '"gateway_task_origins",',
            "",
            "R4 map: state.db additive objects",
        ),
        (
            '"gateway_profile_delegations",',
            "",
            "R4 map: state.db additive objects",
        ),
    ],
    ids=(
        "physical-db-swap",
        "approval-rebuild",
        "approval-expiry-index-map",
        "skill-queue-touch",
        "c01-removal",
        "grant-order-reversal",
        "automatic-grant-completion",
        "grant-side-recovery",
        "task-origin-map-omission",
        "profile-delegation-map-omission",
    ),
)
def test_physical_map_mutations_are_killed(
    tmp_path: Path,
    old: str,
    new: str,
    expected_finding: str,
) -> None:
    mutation = _mutate_block("STATE_DB_MAP_V4", _replace_once(old, new))
    assert expected_finding in _findings(_write_mutation(tmp_path, mutation))


def test_second_approval_event_reducer_is_killed(tmp_path: Path) -> None:
    mutation = _mutate_block(
        "STATE_DB_MAP_V4",
        _replace_once(
            '"approval_deliveries"',
            '"approval_deliveries","gateway_approval_events"',
        ),
    )
    findings = _findings(_write_mutation(tmp_path, mutation))
    assert "R4 map: no gateway_approval_events reducer" in findings
    assert "R4 map: state.db additive objects" in findings


def test_unapproved_payload_store_is_killed(tmp_path: Path) -> None:
    mutation = _mutate_block(
        "STATE_DB_MAP_V4",
        _replace_once(
            '"approval_deliveries"',
            '"approval_deliveries","gateway_approval_payloads"',
        ),
    )
    findings = _findings(_write_mutation(tmp_path, mutation))
    assert "R4 map: protected payload store remains uncreated" in findings
    assert "R4 map: state.db additive objects" in findings


@pytest.mark.parametrize(
    ("mutation", "expected_finding"),
    [
        (
            lambda text: text.replace(
                "ON gateway_profile_delegations(surface_id, profile_id)",
                "ON gateway_profile_delegations(surface_id)",
            ),
            "R4 profile: live delegation keyed by surface and profile",
        ),
        (
            lambda text: text.replace("toolRegistryVersion", "toolCatalogVersion"),
            "R4 profile: source-owned EffectiveProfile revisions rechecked",
        ),
    ],
    ids=("one-profile-per-surface", "source-profile-version"),
)
def test_effective_profile_mutations_are_killed(
    tmp_path: Path,
    mutation: Callable[[str], str],
    expected_finding: str,
) -> None:
    assert expected_finding in _findings(_write_mutation(tmp_path, mutation))


@pytest.mark.parametrize(
    ("table", "old", "new"),
    [
        ("gateway_task_origins", "delegation_id", "unbound_id"),
        (
            "gateway_task_origins",
            "profile_delegation_revision",
            "unbound_revision",
        ),
        ("gateway_approval_bindings", "delegation_id", "unbound_id"),
        (
            "gateway_approval_bindings",
            "profile_delegation_revision",
            "unbound_revision",
        ),
        ("gateway_action_grants", "delegation_id", "unbound_id"),
        (
            "gateway_action_grants",
            "profile_delegation_revision",
            "unbound_revision",
        ),
    ],
)
def test_delegation_binding_mutations_are_killed(
    tmp_path: Path,
    table: str,
    old: str,
    new: str,
) -> None:
    mutation = _mutate_table(table, _replace_once(old, new))
    assert f"R4 profile: {table} binds delegation id and revision" in _findings(
        _write_mutation(tmp_path, mutation)
    )


def test_cross_database_foreign_key_is_killed(tmp_path: Path) -> None:
    mutation = _mutate_table(
        "gateway_surface_security",
        lambda body: body.rstrip().rstrip(",")
        + ",\n    FOREIGN KEY (principal_id) REFERENCES principals(id)",
    )
    assert "R4 cross-DB: no cross-database foreign keys" in _findings(
        _write_mutation(tmp_path, mutation)
    )


@pytest.mark.parametrize(
    ("mutation", "expected_finding"),
    [
        (
            _regex_once(
                r"ALTER TABLE tool_approvals ADD COLUMN context_hash\s+TEXT",
                "ALTER TABLE tool_approvals ADD COLUMN context_hash TEXT NOT NULL",
            ),
            "R4 migration: additions have no constraints or defaults",
        ),
        (
            lambda text: text.replace(
                "`PRAGMA table_info(tool_approvals)`",
                "`PRAGMA table_info(tasks)`",
            ),
            "R4 migration: PRAGMA table_info guard",
        ),
        (
            lambda text: text.replace(
                "## 9. Explicitly OUT OF SCOPE",
                "REDACTED_LEGACY_ARGS_V4\n\n## 9. Explicitly OUT OF SCOPE",
                1,
            ),
            "R4 migration: no rebuild/sentinel/history rewrite",
        ),
        (
            lambda text: text.replace(
                "## 9. Explicitly OUT OF SCOPE",
                "CREATE TABLE gateway_approval_events (seq INTEGER);\n\n"
                "## 9. Explicitly OUT OF SCOPE",
                1,
            ),
            "R4 migration: no gateway_approval_events table/reducer",
        ),
        (
            lambda text: text.replace(
                "## 9. Explicitly OUT OF SCOPE",
                "CREATE TABLE gateway_session_auth (session_id TEXT);\n\n"
                "## 9. Explicitly OUT OF SCOPE",
                1,
            ),
            "R4 migration: no gateway_session_auth table",
        ),
        (
            lambda text: text.replace(
                "## 9. Explicitly OUT OF SCOPE",
                "CREATE TABLE gateway_approval_payloads (approval_id TEXT);\n\n"
                "## 9. Explicitly OUT OF SCOPE",
                1,
            ),
            "R4 migration: no gateway_approval_payloads table",
        ),
    ],
    ids=(
        "nullable-column",
        "guard",
        "history-sentinel",
        "second-event-table",
        "durable-session-auth-table",
        "unapproved-payload-table",
    ),
)
def test_additive_migration_mutations_are_killed(
    tmp_path: Path,
    mutation: Callable[[str], str],
    expected_finding: str,
) -> None:
    assert expected_finding in _findings(_write_mutation(tmp_path, mutation))


@pytest.mark.parametrize(
    ("mutation", "expected_finding"),
    [
        (
            _regex_once(r"surface_id\s+TEXT PRIMARY KEY", "surface_id TEXT"),
            "R4 identity: globally unique surface_id",
        ),
        (
            _regex_once(r"credential_id\s+TEXT PRIMARY KEY", "credential_id TEXT"),
            "R4 identity: globally unique credential_id",
        ),
        (
            _regex_once(r"secret_hmac\s+BLOB NOT NULL UNIQUE", "secret_hmac BLOB NOT NULL"),
            "R4 identity: globally unique secret_hmac",
        ),
        (
            lambda text: text.replace(
                "Origin independent of Authority",
                "Origin coupled to Authority",
            ),
            "R4 authority: Origin independent of Authority",
        ),
        (
            lambda text: text.replace("connection-scoped", "session-scoped"),
            "R4 identity: ConnectionAuthContext remains connection-scoped",
        ),
        (
            lambda text: text.replace("gateway_task_origins", "gateway_session_origins"),
            "R4 identity: immutable request-keyed task origin",
        ),
        (
            _replace_once("one centralized writer", "two independent writers"),
            "R4 approval: canonical state and one centralized writer",
        ),
        (
            lambda text: text.replace(
                "status='pending' AND expires_at<=now",
                "status='pending'",
            ),
            "R4 approval: expiry uses canonical pending guard",
        ),
    ],
    ids=(
        "surface-global-key",
        "credential-global-key",
        "hmac-unique",
        "origin-authority-separation",
        "connection-scoped-auth",
        "request-keyed-task-origin",
        "single-writer",
        "expiry-guard",
    ),
)
def test_identity_and_approval_mutations_are_killed(
    tmp_path: Path,
    mutation: Callable[[str], str],
    expected_finding: str,
) -> None:
    assert expected_finding in _findings(_write_mutation(tmp_path, mutation))


@pytest.mark.parametrize(
    ("mutation", "expected_finding"),
    [
        (
            _replace_once("reads only `state.db`", "reads collab.db and state.db"),
            "R4 CT-2: decision is state-only and fail-closed on projection drift",
        ),
        (
            _replace_once(
                "MAY approve a task it originated",
                "MAY NOT approve a task it originated",
            ),
            "R4 authority: same-origin authorized operator positive path",
        ),
        (
            _replace_once(
                "tool.pathScope === undefined ? null",
                "tool.pathScope ?? {read:[],write:[],deny:[]}",
            ),
            "R4 profile: registry enforcement formula and exact material pinned",
        ),
        (
            _replace_once(
                "c3db5267496d68d9edea579e0bd43c1e397364026e281401e30fa0bc596af6bb",
                "0" * 64,
            ),
            "R4 ACTIONHASH_V1: independently reproduced golden vector",
        ),
        (
            _replace_once("exact stored `request_id`", "exact `dispatch_request_id`"),
            "R4 ACTIONHASH_V1: exact formula and pre-execute comparison",
        ),
        (
            _mutate_table(
                "gateway_action_grants",
                _replace_once(
                    "FOREIGN KEY (dispatch_request_id) REFERENCES tasks(request_id)",
                    "FOREIGN KEY (dispatch_request_id) REFERENCES sessions(id)",
                ),
            ),
            "R4 grant: dispatch task is FK-backed and unique",
        ),
        (
            _replace_once("no null/falsey coercion", "null/falsey coercion allowed"),
            "R4 action args: present plain object with explicit empty-object no-arg",
        ),
        (
            _replace_once(
                "d7bf709cf2ee293b854e77f7aa649cc18c3195e52870b2e8e01066e270556626",
                "f" * 64,
            ),
            "R4 CTXHASH_V1: end-to-end semantic vector independently reproduced",
        ),
        (
            _mutate_table(
                "gateway_approval_bindings",
                _replace_once(
                    "registered_registry_enforcement_hash",
                    "registered_path_policy_revision",
                ),
            ),
            "R4 profile: registry enforcement hash bound through all state stages",
        ),
        (
            _replace_once("lane handoff reports", "repository record reports"),
            "R4 GS receipt: handoff and repository evidence distinguished",
        ),
        (
            _replace_once(
                "C2 still MUST NOT invent an asynchronous/offline apply seam",
                "C2 may invent an asynchronous/offline apply seam",
            ),
            "R4 scope: C2 synchronous registration/decision/admission semantics",
        ),
        (
            _replace_once(
                "**Property-10 live re-validation across that future seam is DEFERRED to C3.**",
                "**Property-10 live re-validation across that future seam is implemented in C2.**",
            ),
            "R4 scope: C3 asynchronous apply semantics remain deferred",
        ),
        (
            _replace_once(
                "performs **no cross-WAL read**",
                "performs **a cross-WAL read**",
            ),
            "R4 CT-2 provisioning: authority insert is state-only",
        ),
        (
            _replace_once(
                "canonical_now + GRANT_TTL_SECONDS",
                "tool_approvals.expires_at",
            ),
            "R4 grant: finite TTL has an exact source and admission writer",
        ),
        (
            _replace_once(
                "Rebuild/reconnect excludes revoked",
                "Rebuild/reconnect includes revoked",
            ),
            "R4 delivery: revoked targets excluded without changing approval truth",
        ),
        (
            _replace_once(
                "OQ-2 (surface transfer; owner: operator; deadline: before any transfer ticket/API is authorized)",
                "OQ-2 (surface transfer)",
            ),
            "R4 open questions: named owners and gate-relative deadlines",
        ),
    ],
    ids=(
        "cross-wal-decision",
        "same-origin-operator-denied",
        "pathscope-null-collapsed",
        "actionhash-golden",
        "actionhash-dispatch-id",
        "dispatch-task-fk",
        "args-null-coercion",
        "ctxhash-semantic-golden",
        "registry-binding-removed",
        "gs-receipt-overclaim",
        "c2-invents-async-apply",
        "c3-deferral-removed",
        "ct2-cross-wal-provisioning",
        "grant-expiry-copied-from-approval",
        "delivery-includes-revoked-target",
        "open-question-missing-owner-deadline",
    ),
)
def test_revision_4_advanced_contract_mutations_are_killed(
    tmp_path: Path,
    mutation: Callable[[str], str],
    expected_finding: str,
) -> None:
    assert expected_finding in _findings(_write_mutation(tmp_path, mutation))


@pytest.mark.parametrize(
    ("old", "new", "expected_finding"),
    [
        (
            "Resolved execution profile",
            "Unresolved execution profile",
            "R4 CTXHASH_V1: exact ten fields and order",
        ),
        (
            '"CTXHASH_V1"',
            '"CTXHASH_V0"',
            "R4 CTXHASH_V1: pinned byte serializer",
        ),
        (
            "U32BE(len(f10))",
            "U16BE(len(f10))",
            "R4 CTXHASH_V1: pinned byte serializer",
        ),
    ],
    ids=("field-list", "version-tag", "length-framing"),
)
def test_ctxhash_mutations_are_killed(
    tmp_path: Path,
    old: str,
    new: str,
    expected_finding: str,
) -> None:
    assert expected_finding in _findings(_write_mutation(tmp_path, _replace_once(old, new)))


@pytest.mark.parametrize(
    ("mutation", "expected_finding"),
    [
        (
            _replace_once("operator-surface only", "all-surface access"),
            "R4 governed tools: both are operator-surface only",
        ),
        (
            _replace_once("never copy/re-create", "may copy/re-create"),
            "R4 governed errors: shared mapper, never copied",
        ),
        (
            _replace_once(
                "SKILL_ROLLBACK_INVALID_TARGET",
                "SKILL_ROLLBACK_UNKNOWN_TARGET",
            ),
            "R4 governed errors: exact four codes present",
        ),
        (
            _replace_once("must not auto-retry", "may auto-retry"),
            "R4 governed errors: UNPROVEN non-retryable/no auto-retry",
        ),
        (
            lambda text: text + "\nA new disable_skill command is available.\n",
            "R4 governed tools: disable/unpublish nonexistent",
        ),
    ],
    ids=("operator-only", "shared-mapper", "error-code", "unproven-retry", "disable-invention"),
)
def test_governed_boundary_mutations_are_killed(
    tmp_path: Path,
    mutation: Callable[[str], str],
    expected_finding: str,
) -> None:
    assert expected_finding in _findings(_write_mutation(tmp_path, mutation))


def test_governed_kernel_source_contract_passes() -> None:
    assert not _governed_source_findings(ROOT)


@pytest.mark.parametrize(
    ("source", "old", "new", "expected_finding"),
    [
        (
            "queue",
            "governed_skills.map_activation_failure(\n"
            "                    exc, queue_status=\"pending\"\n"
            "                )",
            "{\"ok\": False, \"code\": \"SKILL_RUNTIME_BUSY\", "
            "\"retryable\": True}",
            "R4 source: mapper owns mapped error dictionaries",
        ),
        (
            "rollback",
            "governed_skills.map_activation_failure(exc, queue_status=None)",
            "local_activation_failure(exc, queue_status=None)",
            "R4 source: shared activation-failure mapper call sites",
        ),
        (
            "mapper",
            'code, retryable = "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT", False',
            'code, retryable = "SKILL_PROJECTION_UNPROVEN_AFTER_REVERT", True',
            "R4 source: UNPROVEN codes are non-retryable",
        ),
        (
            "rollback",
            '"code": "SKILL_ROLLBACK_INVALID_TARGET"',
            '"code": "SKILL_ROLLBACK_UNKNOWN_TARGET"',
            "R4 source: rollback owns direct validation codes",
        ),
        (
            "server",
            "@mcp.tool()\nasync def rollback_skill",
            "async def rollback_skill",
            "R4 source: governed MCP tools registered",
        ),
        (
            "server",
            "@mcp.tool()\nasync def list_skill_versions",
            "async def list_skill_versions",
            "R4 source: governed MCP tools registered",
        ),
    ],
    ids=(
        "recopied-mapper-dict",
        "rollback-bypasses-mapper",
        "unproven-made-retryable",
        "direct-code-moved",
        "rollback-tool-unregistered",
        "versions-tool-unregistered",
    ),
)
def test_governed_kernel_source_mutations_are_killed(
    tmp_path: Path,
    source: str,
    old: str,
    new: str,
    expected_finding: str,
) -> None:
    repo = _copy_governed_sources(tmp_path)
    _mutate_governed_source(repo, source, old, new)
    assert expected_finding in _governed_source_findings(repo)


@pytest.mark.parametrize(
    ("suffix", "expected_finding"),
    [
        (
            "\n```python\nobserved = expected\n```\n",
            "R4 evidence: no hard-coded observed/PASS-finally code",
        ),
        (
            "\n```python\nfinally:\n    report.write('PASS')\n```\n",
            "R4 evidence: no hard-coded observed/PASS-finally code",
        ),
    ],
    ids=("observed-from-expected", "pass-from-finally"),
)
def test_evidence_fabrication_code_is_killed(
    tmp_path: Path,
    suffix: str,
    expected_finding: str,
) -> None:
    assert expected_finding in _findings(
        _write_mutation(tmp_path, lambda text: text + suffix)
    )


def test_cli_failure_report_is_deterministic(tmp_path: Path) -> None:
    broken = _write_mutation(
        tmp_path,
        _replace_once("STATE_DB_MAP_V4_END", "STATE_DB_MAP_V4_BROKEN"),
    )
    report = tmp_path / "report.md"
    command = [sys.executable, str(SCRIPT), str(broken), "--report", str(report)]
    first = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    first_report = report.read_bytes()
    second = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert first.returncode == second.returncode == 1
    assert first.stdout == second.stdout
    assert first.stderr == second.stderr
    assert report.read_bytes() == first_report
    assert b"R4 markers: STATE_DB_MAP_V4" in first_report


def test_canonical_prd_passes_gate_on_a_crlf_checkout(tmp_path: Path) -> None:
    """The repo checks out with core.autocrlf=true on Windows (recorded in the
    linter's own _worktree_text_to_git_bytes docstring), so the gate must reach
    the same verdict on a CRLF materialization of the canonical PRD as on the
    LF blob git stores. Regression for the CTXHASH_V1 semantic-fixture regex,
    whose bare $ anchor missed fixture lines ending CRLF and turned three
    checks falsely red on every Windows checkout while the identical commit
    passed 224/224 on LF checkouts. The mutation harness cannot catch this
    class itself: _write_mutation round-trips through read_text (normalizing
    to LF), so every mutant it writes is LF regardless of the checkout.
    """
    crlf = tmp_path / PRD.name
    crlf.write_bytes(
        PRD.read_text(encoding="utf-8").replace("\n", "\r\n").encode("utf-8")
    )
    assert _findings(crlf) == set()
