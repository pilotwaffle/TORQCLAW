#!/usr/bin/env python3
"""Deterministic consistency gate for the TORQCLAW collaboration PRD."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

EXPECTED_COMMANDS = {
    "CREATE_AGENT", "CREATE_PRINCIPAL_CREDENTIAL", "SUSPEND_AGENT", "RESTORE_AGENT", "REVOKE_AGENT",
    "ROTATE_PRINCIPAL_CREDENTIAL", "REVOKE_PRINCIPAL_CREDENTIAL",
    "CREATE_CHANNEL", "ADD_CHANNEL_MEMBER", "REMOVE_CHANNEL_MEMBER",
    "ARCHIVE_CHANNEL", "UNARCHIVE_CHANNEL", "LIST_CHANNELS",
    "POST_CHANNEL_MESSAGE", "GET_CHANNEL_TIMELINE", "ACK_CHANNEL_CURSOR",
    "SUBSCRIBE_CHANNEL", "UNSUBSCRIBE_CHANNEL",
}
EXPECTED_EVENTS = {
    "channel_created", "member_added", "member_removed", "message_posted",
    "channel_archived", "channel_unarchived",
}
EXPECTED_ERRORS = {
    "AUTH_FAILED", "ROLE_PRINCIPAL_MISMATCH", "SESSION_INVALID",
    "COLLAB_NOT_FOUND", "COLLAB_NOT_PERMITTED", "PRINCIPAL_NOT_FOUND",
    "CREDENTIAL_NOT_FOUND", "INVALID_PRINCIPAL_STATE", "CHANNEL_ARCHIVED",
    "CHANNEL_NAME_CONFLICT", "CURSOR_OUT_OF_RANGE", "LAST_OPERATOR_CREDENTIAL",
    "INVALID_PRINCIPAL_TRANSITION", "IDEMPOTENCY_CONFLICT", "SLOW_CONSUMER",
    "INVALID_FRAME", "INVALID_REQUEST", "UNSUPPORTED_PROTOCOL",
}
EXPECTED_CLOSE_REASONS = {
    "credential_revoked", "principal_suspended", "principal_restored",
    "principal_revoked", "operator_revoked", "slow_consumer", "socket_closed",
    "recovery",
}
EXPECTED_SUBSCRIPTION_CLOSE_REASONS = {
    "unsubscribed", "authorization_lost", "channel_archived",
    "channel_unarchived", "slow_consumer", "session_closed", "socket_closed",
}
EXPECTED_IDEMPOTENCY = {
    "keyed": {
        "CREATE_AGENT", "CREATE_PRINCIPAL_CREDENTIAL", "SUSPEND_AGENT", "RESTORE_AGENT", "REVOKE_AGENT",
        "ROTATE_PRINCIPAL_CREDENTIAL", "REVOKE_PRINCIPAL_CREDENTIAL",
        "CREATE_CHANNEL", "ADD_CHANNEL_MEMBER", "REMOVE_CHANNEL_MEMBER",
        "ARCHIVE_CHANNEL", "UNARCHIVE_CHANNEL", "POST_CHANNEL_MESSAGE",
    },
    "natural": {"ACK_CHANNEL_CURSOR", "UNSUBSCRIBE_CHANNEL"},
    "none": {"LIST_CHANNELS", "GET_CHANNEL_TIMELINE", "SUBSCRIBE_CHANNEL"},
}


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


def section(text: str, heading: str, level: int = 3) -> str:
    marker = "#" * level + " " + heading
    start = text.find(marker)
    if start < 0:
        raise ValueError(f"missing section: {marker}")
    body_start = text.find("\n", start) + 1
    match = re.search(rf"^#{{1,{level}}}\s+", text[body_start:], re.MULTILINE)
    end = body_start + match.start() if match else len(text)
    return text[body_start:end]


def ticks(value: str) -> set[str]:
    return set(re.findall(r"`([^`]+)`", value))


def ddl_table(text: str, table: str) -> str:
    match = re.search(
        rf"CREATE TABLE {re.escape(table)}\s*\((.*?)\n\);",
        text,
        re.DOTALL,
    )
    if not match:
        raise ValueError(f"missing DDL table: {table}")
    return match.group(1)


def check_values(table_ddl: str, column: str) -> set[str]:
    match = re.search(
        rf"{re.escape(column)}\s+TEXT.*?CHECK\s*"
        rf"\(\s*{re.escape(column)}(?:\s+IS\s+NULL\s+OR\s+{re.escape(column)})?"
        rf"\s+IN\s*\((.*?)\)\s*\)",
        table_ddl,
        re.DOTALL,
    )
    return set(re.findall(r"'([^']+)'", match.group(1))) if match else set()


def registry(text: str, prefix: str, pattern: str) -> set[str]:
    line = next((item for item in text.splitlines() if item.startswith(prefix)), "")
    return {item for item in ticks(line) if re.fullmatch(pattern, item)}


def idempotency_classes(text: str) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for key, label in (
        ("keyed", "Idempotency-keyed"),
        ("natural", "Naturally idempotent"),
        ("none", "No idempotency key"),
    ):
        line = next(
            (item for item in text.splitlines() if item.startswith(f"| {label} |")),
            "",
        )
        result[key] = {item for item in ticks(line) if item in EXPECTED_COMMANDS}
    return result


def run(prd: Path) -> tuple[Gate, str]:
    text = prd.read_text(encoding="utf-8")
    gate = Gate()
    commands_text = section(text, "7.4 Exhaustive commands")
    events_text = section(text, "7.5 Exhaustive collaboration events")
    errors_text = section(text, "7.6 Error precedence")
    sessions_text = section(text, "8.1 Session binding")

    commands = set(re.findall(r"^- `([A-Z][A-Z0-9_]+)", commands_text, re.MULTILINE))
    events = set(re.findall(r"^- `([a-z][a-z0-9_]+)", events_text, re.MULTILINE))
    errors = registry(errors_text, "The exhaustive domain error codes", r"[A-Z][A-Z0-9_]+")
    errors |= registry(errors_text, "Framing codes are", r"[A-Z][A-Z0-9_]+")
    close_reasons = registry(
        sessions_text, "The exhaustive session close reasons", r"[a-z][a-z0-9_]+"
    )
    subscription_close_reasons = registry(
        sessions_text, "The exhaustive subscription close reasons", r"[a-z][a-z0-9_]+"
    )
    ddl_events = check_values(ddl_table(text, "collab_events"), "kind")
    ddl_close_reasons = check_values(
        ddl_table(text, "collab_session_bindings"), "close_reason"
    )
    classes = idempotency_classes(commands_text)

    gate.equal("command allowlist", commands, EXPECTED_COMMANDS)
    gate.equal("event allowlist", events, EXPECTED_EVENTS)
    gate.equal("collab_events CHECK parity", ddl_events, EXPECTED_EVENTS)
    gate.equal("error registry", errors, EXPECTED_ERRORS)
    gate.equal("close-reason registry", close_reasons, EXPECTED_CLOSE_REASONS)
    gate.equal(
        "subscription close-reason registry",
        subscription_close_reasons,
        EXPECTED_SUBSCRIPTION_CLOSE_REASONS,
    )
    gate.equal("close-reason DDL parity", ddl_close_reasons, EXPECTED_CLOSE_REASONS)
    for name, expected in EXPECTED_IDEMPOTENCY.items():
        gate.equal(f"idempotency class: {name}", classes.get(name, set()), expected)
    gate.equal("idempotency coverage", set().union(*classes.values()), EXPECTED_COMMANDS)

    required = {
        "message limit": "1-16,384 UTF-8 bytes",
        "encoded message bound":
            "encoded JSON string form (excluding the surrounding quotes but including all escapes) MUST be at most **16,384 bytes**",
        "largest legal message pin":
            "largest legal message is therefore exactly 16,384 unescaped UTF-8 bytes",
        "boundary fixture pins":
            "16,384 unescaped ASCII bytes accepted, 16,385 rejected",
        "control-character ban":
            "MUST NOT contain C0 or C1 control characters other than TAB",
        "name character-class ban": "bidirectional control characters",
        "paginated cut rule": "A paginated result page ends at its limit",
        "timeline page bound": "A timeline page ends at **100 events**",
        "timeline frame acceptance":
            "the 100-event page bound and the 64 KiB result-frame bound",
        "per-channel cursor": "channel_seq",
        "cursor never global": "never exposed in any frame, result, or error",
        "high-water scope":
            "greatest committed `channel_seq` visible to the caller in that channel",
        "per-write read lock":
            "acquired and released per socket write",
        "serialization not contention":
            "unique-key contention on `collab_mutation_results` cannot occur",
        "cursor retention":
            "retained unchanged across membership removal and re-add",
        "passphrase revocation": "--passphrase-stdin",
        "revocation latency bound":
            "revocation-commit-to-last-write-boundary",
        "audit index": "collab_audit_kind_created",
        "caller-scoped owner predicate":
            "the current principal is the operator principal connected with role `operator`",
        "owner invoker storage validation":
            "verify the invoking principal equals the channel's `owner_principal_id`",
        "membership interval": "rejoined_seq",
        "replay floor": "max(afterCursor, rejoined_seq)",
        "lock classes":
            "authorization mutations acquire the authorization write lock instead of the read lock",
        "no lock upgrade": "no upgrade path exists",
        "nfc ordering":
            "NFC normalization first, then trimming, then all length",
        "cursor lookup index": "collab_cursors_principal_channel",
        "timeline event object": "A timeline event object is",
        "next-cursor convention": "cursor of the last element returned",
        "decoy hmac": "fixed decoy HMAC",
        "flag nesting": "strictly nested and validated at startup",
        "caller-own cursor": "calling principal's own acknowledged cursor",
        "sequential slices": "cumulative and sequentially gated",
        "not-permitted scope":
            "reserved for `OPERATOR_GLOBAL` commands",
        "rejoined capture point":
            "immediately before the `member_added` event is inserted",
        "caller-visible ack bound":
            "visible to the calling principal in that channel",
        "no-op archive": "no-ops that return the current",
        "sql-computed ack max":
            "computes and stores `max(existing,submitted)` in SQL",
        "writer preference": "writer-preferring",
        "six flag configurations": "six valid flag configurations",
        "qualified writer claim":
            "only writer to these tables while listeners are open",
        "metadata visibility rule": "accepted v1 behavior",
        "post-lock close delivery": "post-lock delivery step",
        "channel-enumerable predicate": "CHANNEL_ENUMERABLE",
        "benchmark load phases":
            "25 concurrent readers continuously subscribing and reading plus one held slow consumer",
        "loopback lockout exemption":
            "Loopback source addresses are exempt from the address-level counter",
        "credential shape rule":
            "present if and only if `credentialAvailable` is true",
        "archived-error precedence":
            "only a caller that passes its Section 4.2 predicate can observe the state error",
        "orphan binding remediation":
            "Startup closes any binding with a null `closed_at`",
        "fixture determinism harness": "determinism harness",
        "injected fixture clock": "injected monotonic clock",
        "seeded fixture uuids": "deterministic UUID generator seeded per fixture",
        "revocation boundary definition":
            "starts at the SQLite commit return of the authorization mutation",
        "revocation observation floor":
            "the revocation phase requires at least 1,000 observations",
        "next-channel token rule": "`nextChannelId` is the `channelId` of the last element returned",
        "secrets verify command": "torqclaw collab secrets verify",
        "verify decrypts": "Verification decrypts the kit with the supplied passphrase",
        "duplicate-key parser note": "raw-text position-aware parser",
        "frame byte basis": "raw UTF-8 bytes of the complete frame",
        "node version pin": "pinned at 22.11.0",
        "predicate state purity":
            "No predicate in this table constrains channel state",
        "re-add truncation": "Re-add permanently truncates access",
        "ack upsert": "a missing cursor row is treated as `acknowledged_seq` 0",
        "rotation last-credential guard":
            "`ROTATE_PRINCIPAL_CREDENTIAL` returns `LAST_OPERATOR_CREDENTIAL` without mutation",
        "vendored fold table": "vendored `CaseFolding.txt`",
        "rotation shape rule":
            "additionally includes `replacedCredentialId` in both shapes",
        "harness covers revokedAt": "and `revokedAt`",
        "argon2 dependency": "@node-rs/argon2",
        "step-3 syntactic scope":
            "channel-state-independent syntactic validation",
        "name-key algorithm": "Unicode Default Case Folding",
        "name-key index": "collab_channels_active_name_key",
        "archive delivery contract":
            "Archive closes every live subscription on that channel",
        "slow-consumer bytes": "1 MiB",
        "slow-consumer age": "10 seconds",
        "credential rate": "5 failures per normalized credential ID per 5 minutes",
        "address rate": "20 failures per normalized remote address per 5 minutes",
        "timeline benchmark": "p95 <= 100 ms",
        "commit benchmark": "p95 <= 75 ms",
        "fan-out benchmark": "p95 <= 150 ms",
        "principal pepper check": "principal_pepper_check",
        "recovery pepper check": "recovery_pepper_check",
        "member lookup index": "collab_members_principal_state_channel",
        "credential lookup index": "principal_credentials_principal_state",
        "display-name validator":
            "Agent display names are NFC-normalized, trimmed, and 1-80 Unicode scalar values.",
        "failed mutation persistence":
            "Failed mutations never write `collab_mutation_results`",
        "rate-limit privacy":
            "Rate-limit lockout is reported as `AUTH_FAILED`",
        "operator target behavior":
            "return `INVALID_REQUEST` when `principalId` names the operator",
        "mutation size observability":
            "`collab_mutation_results` row count and encoded result bytes",
        "authorization before idempotency":
            "current command predicate and hidden-resource authorization",
        "credential result redaction":
            "persist only `principalId`, `credentialId`, and `credentialAvailable:false`",
        "atomic keyed protocol":
            "every keyed command executes this atomic protocol",
        "storage authority validation":
            "The `CollaborationStore` is the only writer to these tables",
        "safe rollback":
            "Normal rollback is non-destructive",
        "per-row membership epoch":
            "per-membership-row counter on `collab_members`",
        "no channel-level membership counter":
            "There is no channel-level membership counter",
        "own-row epoch snapshot":
            "the epoch of the subscribing principal's own `collab_members` row",
        "authorization-lost epoch binding":
            "`authorization_lost` when the caller's own membership row is no longer active",
        "restore close reason":
            "session close reason `principal_restored`",
        "restore zero-session fixture": "closes exactly zero sessions",
        "fresh-key same-state rule": "with a fresh idempotency key",
        "non-authorization lock class exact":
            "Non-authorization mutations (`CREATE_AGENT`, `CREATE_PRINCIPAL_CREDENTIAL`, "
            "`CREATE_CHANNEL`, `POST_CHANNEL_MESSAGE`)",
        "authorization lock class exact":
            "Authorization mutations (`SUSPEND_AGENT`, `RESTORE_AGENT`, `REVOKE_AGENT`, "
            "`ROTATE_PRINCIPAL_CREDENTIAL`, `REVOKE_PRINCIPAL_CREDENTIAL`, `ADD_CHANNEL_MEMBER`, "
            "`REMOVE_CHANNEL_MEMBER`, `ARCHIVE_CHANNEL`, `UNARCHIVE_CHANNEL`)",
        "subscription-survival fixture": "(subscription survival)",
        "inline two-branch cursor bound":
            "otherwise the bound is the member's `rejoined_seq`",
        "re-added-at-head fixture": "(re-added-at-head boundary)",
        "unmapped-scalar fold rule": "any unmapped scalar maps to itself",
        "no post-fold normalization":
            "No second NFC normalization pass follows folding",
        "list-channels hasmore definition":
            "has a channel ID greater than `nextChannelId`",
        "frame-cut timeline pin":
            "the page returns exactly three events with `hasMore` true",
        "hundred-event fixture content": "whose text is the single byte `a`",
        "discovery capacity pin":
            "provisions exactly 100 channels whose names are exactly 80 ASCII characters",
        "revocation apportionment suspend":
            "at least 450 `SUSPEND_AGENT`/`RESTORE_AGENT` pair observations",
        "revocation apportionment archive":
            "at least 450 `ARCHIVE_CHANNEL`/`UNARCHIVE_CHANNEL` pair observations",
        "terminal revoke sample":
            "exactly 100 terminal `REVOKE_AGENT` observations",
        "delegation deadline": "Delegation decision deadline",
    }
    for name, literal in required.items():
        gate.require(name, literal in text, f"missing requirement: {literal}")

    forbidden = {
        "legacy message limit": "32,000",
        "legacy timeline limit": "limit:1..500",
        "legacy slow-consumer code": "COLLAB_SLOW_CONSUMER",
        "legacy slow-consumer bytes": "4 MiB",
        "legacy timeline page bytes": "512 KiB",
        "legacy name index": "collab_channels_active_name_ci",
        "unenforceable name fold": "lower(name)",
        "removed credential expiry": "expires_at",
        "removed expired state": "'expired'",
        "removed contention branch": "unique-key contention, roll back",
        "removed credential-stdin flag": "--credential-stdin",
        "channel-property owner predicate": "plus operator owns target channel",
        "non-sequential slice wording": "independently gated",
        "removed mutex vagueness": "sequencer mutex where required",
        "removed count-non-disclosure claim": "never discloses committed counts",
        "removed unsatisfiable oracle test": "cannot learn committed counts",
        "removed uniform observation floor": "10,000 observations per phase",
        "removed state-bearing writable predicate": "plus active channel |",
        "removed dead cursor floor": "max(acknowledged_seq, rejoined_seq)",
        "removed row-bound cursor predicate": "cursor principal is current principal",
        "removed pepper-rotation clause": "predates a pepper rotation",
        "removed quote-inclusive bound": "including surrounding quotes and all escapes",
        "removed five-config gate": "five valid cumulative flag configurations",
        "stale section reference": "every D.2 event",
        "removed tombstone event": "message_tombstoned",
        "removed stored-status effectiveness clause":
            "even if their stored status is active",
        "removed disjunctive discovery fixture":
            "stays within the frame bound or paginates",
        "removed by-reference cursor validation":
            "(the Section 7.4 caller-visible bound)",
        "removed read-lock member-add classification":
            "`RESTORE_AGENT`, `CREATE_CHANNEL`",
        "removed restore-less authorization class":
            "`SUSPEND_AGENT`, `REVOKE_AGENT`",
    }
    for name, literal in forbidden.items():
        # Boundary-aware: "4 MiB" must not match inside "64 MiB".
        pattern = r"(?<![\w])" + re.escape(literal) + r"(?![\w])"
        gate.require(
            name,
            re.search(pattern, text) is None,
            f"legacy literal remains: {literal}",
        )

    frame_match = re.search(r"maximum (\d+) KiB", text)
    frame_kib = int(frame_match.group(1)) if frame_match else 0
    encoded_bounds = [
        int(value.replace(",", ""))
        for value in re.findall(r"(\d[\d,]*)\s*KiB encoded", text)
    ]
    gate.require(
        "frame bound defined",
        frame_kib > 0,
        "no 'maximum N KiB' frame bound found",
    )
    gate.require(
        "cross-constraint: encoded bounds fit frame",
        all(bound <= frame_kib for bound in encoded_bounds),
        f"encoded byte bound exceeds {frame_kib} KiB frame limit: {encoded_bounds}",
    )

    # Feasibility: the declared encoded-message bound plus a generous envelope
    # allowance must fit one frame, so a single legal event is always deliverable.
    encoded_msg = re.search(
        r"encoded JSON string form.*?at most \*\*(\d[\d,]*) bytes\*\*", text
    )
    msg_bound = int(encoded_msg.group(1).replace(",", "")) if encoded_msg else None
    gate.require(
        "cross-constraint: encoded message fits frame with envelope",
        msg_bound is not None and msg_bound + 2048 <= frame_kib * 1024,
        f"encoded message bound {msg_bound} + 2 KiB envelope exceeds frame",
    )

    # The raw and encoded message bounds must be equal so the largest-legal
    # pin is unambiguous (encoded form excludes quotes, so unescaped text has
    # raw length == encoded length).
    raw_match = re.search(r"1-(\d[\d,]*) UTF-8 bytes", text)
    raw_bound = int(raw_match.group(1).replace(",", "")) if raw_match else None
    gate.require(
        "cross-constraint: raw and encoded message bounds equal",
        raw_bound is not None and raw_bound == msg_bound,
        f"raw bound {raw_bound} != encoded bound {msg_bound}",
    )

    summary = (
        f"{'PASS' if not gate.findings else 'FAIL'}: "
        f"{len(gate.passed)} checks passed, {len(gate.findings)} failed"
    )
    return gate, summary


def render(prd: Path, gate: Gate, summary: str) -> str:
    lines = [
        "# TORQCLAW Collaboration PRD Consistency Report", "",
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
        default=repo / "docs/prd-reviews/PRD-TCLAW-COLLABORATION-SUBSTRATE-001-v0.5.md",
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
