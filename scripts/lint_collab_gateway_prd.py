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
import re
import sys

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


def run(prd: Path) -> tuple[Gate, str]:
    text = prd.read_text(encoding="utf-8")
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
