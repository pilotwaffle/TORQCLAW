# PRD-1 — TypeScript/LOCAL_EDGE Profile Conformance Suite

Status: **implementation candidate exists; final governed verification incomplete**

Source note: this repository-local PRD was transcribed on 2026-08-14 from the operator's session prompt so the next team has a durable specification. The operator-signed copy, exact AUTH-005 merge SHA, and formal disposition/sign-off block still need to be attached or recorded.

## 1. Objective

Build a conformance suite that independently proves:

- the four built-in profile declarations match the operator-signed contract;
- the TypeScript/LOCAL_EDGE control plane exposes only operations admitted by the runtime classifier and profile predicate;
- the TypeScript/LOCAL_EDGE execution plane re-checks the effective profile and rejects stale policy;
- path, tier, and policy-hash behavior is tested as implemented, without inventing guarantees for unenforced fields.

Success is a reproducible evidence packet at a pinned build SHA with no new full-suite failures, named acceptance tests, mutation receipts, and a clean approval-unit worktree/archive.

## 2. Scope

### In scope

- `packages/contracts/src/profile.ts`
- `packages/bridge/src/profilePolicy.ts`
- `packages/bridge/src/capability.ts`
- `packages/bridge/src/toolFilter.ts`
- `packages/bridge/src/registry.ts`
- `packages/bridge/src/pathScope.ts`
- `packages/gateway/src/profileResolver.ts`
- C2 policy-hash binding at existing broker/writer seams
- TypeScript/LOCAL_EDGE tool resolution and execution only

### Non-goals

- FRONTIER/Hermes conformance.
- Network enforcement unless F-W3-1 separately authorizes a production defect fix.
- Changing empty-allowlist behavior without a separate ruling.
- Making `effectiveProfile` mandatory unless AC-10B is separately approved.
- Admitting `send` to any built-in profile.
- Changing the current hybrid `policyHash` composition.
- End-to-end approval issuance, expiry, override, wrong-tool/profile rejection, or approval-context validation. Phase 0 covers declaration and C2 policy-hash binding only.
- Pinning an absolute test count.

No production behavior may change without a separately approved ruling.

## 3. Build and evidence pins

Factual review pin:

```text
c2850f5ac755444d42b930034de536938f31ae22
```

Session build base used by the candidate:

```text
9324cbc6e195807ff6849c6b2d646e745e66fa0d
```

Required before completion:

- exact merged AUTH-005 PR/SHA;
- confirmed build base SHA;
- canonical full-suite command;
- pre-change baseline receipt.

The historical 1741/1742 total is not a completion criterion.

## 4. Declared contract

The suite compares `BUILT_IN_PROFILE_DEFINITIONS` to a checked-in machine-readable golden manifest. Markdown is presentation, not source of truth.

| Profile | Namespaces | Capabilities | Side effects | Tiers | Path | Network | Approval write/exec/send |
|---|---|---|---|---|---|---|---|
| `read_only` | `*` | read | none | LOCAL_EDGE | none | none | false/false/false |
| `workspace_write` | filesystem | read, write | none, filesystem_write | LOCAL_EDGE, FRONTIER | workspace | none | true/false/false |
| `browser_research` | browser, playwright, websearch | read | none | LOCAL_EDGE, FRONTIER | none | browser | false/false/false |
| `terminal_power` | desktop_commander, sandbox, shell, terminal | read, write, exec | none, process | LOCAL_EDGE, FRONTIER | configured | configured | true/true/false |

## 5. Runtime model

Declaration and observed enforcement are separate claims.

- Classifier results are `read`, `write`, `exec`, or `send`; unknowns fail closed to `write`.
- Side effects derive as:
  - read → none
  - exec → process
  - send → network_send
  - filesystem write → filesystem_write
  - browser/playwright write → browser_mutation
  - other write → process
- Profile resolution requires namespace, capability, and side-effect gates conjunctively.
- Task-prefix filtering intersects with profile admission.
- Out-of-tier requests may rewrite to LOCAL_EDGE; tool filtering may return an empty list.
- The resolver produces `allowedOperationIds` and operation maps.
- `assertOperationAllowed` re-resolves current policy and rechecks operation membership.
- Path behavior depends on extracted paths, profile path mode, and registered `pathScope`.
- `scopes.network` is policy/hash material but is not consulted by the reviewed TypeScript pre-execution paths.
- Profile approval metadata participates in resolved policy/execution recheck/hash, while LOCAL_EDGE pausing is separately driven by registered-tool `requiresApproval`.
- The existing hybrid `policyHash` binds current material to delegation/approval checks.
- Omitting `effectiveProfile` from `executeTool` skips profile admission and profile path checks; AC-10A audits callers, while AC-10B is a separate production change.

Reachable classifier outcomes:

| Capability | Namespace class | Side effect |
|---|---|---|
| read | any | none |
| exec | any | process |
| send | any | network_send |
| write | filesystem | filesystem_write |
| write | browser/playwright | browser_mutation |
| write | other | process |

The suite uses a concrete fixture inventory, not an unconstrained Cartesian product.

## 6. Operator dispositions requiring an explicit record

These decisions must be recorded before Definition of Done. Recommended Phase 0 defaults from the operator prompt are shown but must not be silently promoted into signed decisions.

- F-W3-1 network scope: recommended **ACKNOWLEDGED**, test/document only; open a named future ticket.
- F-W3-2 path layers:
  - extracted path + `path:none` denies: recommended accept current fail-closed behavior;
  - extracted path + non-none mode + missing registered `pathScope` denies: recommended accept;
  - empty allowlist allows unless denylist matches: record finding/separate decision;
  - no extractable path/nonstandard key without hint skips checks: record finding/separate decision.
- F-W3-3 approval metadata/pause seam: recommended **ACKNOWLEDGED**, Phase 0 declaration/hash only.
- R1 send: recommended intent confirmed—classifier-reachable but built-in-admission-unreachable.
- R3 tier semantics: recommended intent confirmed—LOCAL_EDGE rewrite plus possibly empty tool list, not a hard request failure/privacy guarantee.
- R4 wildcard read namespaces: recommended intent confirmed at trusted registration boundary.
- R5 workspace network: declaration-only under F-W3-1 acknowledgment.
- Hybrid hash: recommended **KEEP CURRENT HYBRID** for Phase 0.
- Missing `effectiveProfile`: recommended AC-10A caller audit only; AC-10B requires separate authorization.

## 7. Acceptance criteria

### AC-1 — Declared manifest

- A checked-in golden manifest equals every field of `BUILT_IN_PROFILE_DEFINITIONS`.
- The GFM table is generated from or checked against that manifest.
- P1a, a raw `read_only.allowedCapabilities` edit, fails even if runtime behavior/hash does not move.

### AC-2 — Classifier integrity

- Named cases cover every branch in the reachable-outcomes table.
- Browser and Playwright provenance are both covered.
- Fixtures never hand-author impossible capability/side-effect pairs.

### AC-3 — Three-gate predicate

- Permanent tests use built-ins and synthetic `RegisteredTool` snapshots.
- Namespace denial is shown where built-ins make it observable.
- Capability and side-effect sensitivity are proven by named P2 mutations that temporarily change a built-in definition in an expendable worktree.
- Each conjunct-removal mutant kills its named test; equivalent mutants are recorded rather than falsely required to alter admission.

### AC-4 — Built-in control-plane conformance

Every built-in profile has explicit positive/negative exposure cases. Registry reordering must preserve resolved policy/hash. Minimum inventory:

| Raw tool ID | Classifier input | Output | Fixture mode | Side effect | Purpose |
|---|---|---|---|---|---|
| `filesystem__read_file` | `readOnlyHint=true` | read | classified snapshot | none | read/filesystem |
| `browser__read_page` | `readOnlyHint=true` | read | classified snapshot | none | browser read |
| `websearch__search` | explicit config `send` | send | classified snapshot | network_send | dormant send denial |
| `filesystem__write_file` | live fallback | write | classified snapshot | filesystem_write | workspace write |
| `browser__click` | live fallback | write | classified snapshot | browser_mutation | reachable/not admitted |
| `playwright__click` | live fallback | write | classified snapshot | browser_mutation | second provenance |
| `shell__write_file` | live fallback | write | classified snapshot | process | terminal fallthrough |
| `shell__exec` | live fallback | exec | classified snapshot | process | terminal exec |
| `unreviewed__read` | declared read | N/A | pre-classified double | none | wildcard vs explicit namespace |

### AC-5 — Execution-plane conformance

- An admitted operation passes `assertOperationAllowed` and reaches the MCP client boundary.
- Without a client, the accepted positive boundary is the expected `No MCP client connected` error after policy/path checks.
- Direct execution rejects absent operations before the client boundary.
- Current policy is re-resolved before execution.
- Broader approval enforcement is not claimed.

### AC-6 — Tier semantics

- `read_only` out-of-tier handling asserts LOCAL_EDGE rewrite, safety lock, and non-overridable reason.
- Disallowed-tier filtering asserts an empty list.
- Tests do not call this a hard FRONTIER request error.

### AC-7 — Path semantics

Named tests cover:

- extracted path + `path:none` → deny;
- extracted path + non-none mode + missing `pathScope` → deny;
- empty allowlist → allow unless denylist matches;
- denylist precedence;
- no path-like key → checks skipped;
- nonstandard key without `pathArgKeys` → missed;
- nonstandard key with `pathArgKeys` → checked.

No path test may claim arbitrary shell/process containment.

### AC-8 — Current hybrid policy hash and C2

Normative formula:

```text
policyHash = SHA-256(canonicalizePolicy(policyMaterial))
```

`resolveEffectiveProfile` normalizes set-like inputs and sorts registry-derived arrays. `canonicalizePolicy` sorts object keys but preserves array order; `hashPolicyMaterial` is array-order-sensitive.

Material buckets:

- copied: `profileVersion`, `allowedTiers`, `scopes`, `approvalRequirements`;
- derived: allowed IDs, capability/side-effect classes, operation maps;
- filter-only: namespace/capability/side-effect filters affect hash only when they change derived material.

Required tests:

- AC-C2-0: one live-module golden preimage/hash vector.
- AC-C2-1: material has exactly expected keys and excludes raw filter lists.
- AC-C2-2: object-key reorder preserves hash; direct array shuffle changes it.
- AC-C2-3: registry reorder preserves resolved profile/hash.
- AC-C2-4: copied security-field change moves hash without necessarily changing admission.
- AC-C2-5: hasher-unit label mutation moves hash; P3a separately proves real classifier label.
- AC-C2-6: add/drop operation ID moves hash.
- AC-C2-7A: `assertCurrentPolicy` rejects stale hash.
- AC-C2-7B: approval/delegation mismatch rejects as `profile-delegation-stale`.

Use public `canonicalizePolicy`, `hashPolicyMaterial`, and `assertCurrentPolicy`; add no production export solely for tests.

### AC-9 — Runtime boundary

All suite claims are explicitly TypeScript/LOCAL_EDGE only. FRONTIER/Hermes receives no inferred guarantee.

### AC-10A — Pinned caller audit

At the build SHA, enumerate every non-test `executeTool` caller and gateway `assertResolvedProfile` ingress. Assert the production caller forwards a resolved profile. This proves only the pinned caller set.

### AC-10B — Fail closed on missing profile

Only if separately approved, make missing `effectiveProfile` fail at execution and update callers/tests. AC-10A does not authorize this production change.

### AC-11 — Network truthfulness

Tests confirm declaration/hash material only. Under the acknowledged ruling, no test or product copy may represent network scope as enforced containment.

## 8. Mutation plan

Mutations run serially in isolated retained worktrees. Each receipt includes exact mutant diff, named failing test, nonzero exit, restoration, `git diff --exit-code`, and `git status --porcelain`. Never use in-place edit/restore plus MD5 as the cleanup guarantee.

| Probe | Mutation | Required RED surface |
|---|---|---|
| P1a | add raw write to `read_only.allowedCapabilities` only | manifest; runtime/hash intentionally unchanged |
| P1b | add write plus reachable matching side effect | exposure and direct execution |
| P2-namespace | remove namespace conjunct with decisive fixture | named namespace-only cell |
| P2-capability | make side effect pass, leave capability denied, remove capability conjunct | capability-only cell |
| P2-side-effect | make capability pass, leave side effect denied, remove side-effect conjunct | side-effect-only cell |
| P3a | fallthrough process → none | classifier label/hash; authorization may remain unchanged |
| P3b | fallthrough process → network_send | terminal exposure/direct execution |
| P4 | alter signed manifest or definition | declared-contract comparison |

## 9. Required evidence packet

- repository and full build SHA;
- dependency/tool versions;
- exact full-suite command/exit code;
- same-SHA pre/post full-suite receipts proving no new failures;
- named acceptance-test results;
- all mutation receipts;
- one live-module C2 golden vector;
- clean approval-unit evidence;
- unresolved findings/ticket IDs.

The suite is test-only under recommended rulings. Rollback is removal/revert of the test PR. Any production fix requires its own design, verification, rollout, and rollback plan.

## 10. Definition of done

- All operator dispositions are explicitly selected.
- Exact AUTH-005 and build-base SHAs are supplied.
- AC-1 through AC-11 pass, excluding AC-10B unless separately authorized.
- AC-C2-0 through AC-C2-7B pass.
- Every required mutation fails its named test and restoration is proven.
- Canonical package suite has no new failures versus same-SHA baseline.
- Evidence packet is attached.
- No production behavior changed without a separate ruling.
- Final independent verifier returns ready.
- Fresh final implementation auditor approves the final source state.

## 11. Sign-off

```text
Operator: __________________________
Date: ______________________________
Build base SHA: 9324cbc6e195807ff6849c6b2d646e745e66fa0d
AUTH-005 merge SHA: ________________

Test-contract verdict:
[ ] APPROVED FOR BUILD
[ ] REVISE
[ ] REJECT

Product rulings recorded:
F-W3-1 [ ] | F-W3-2 layers [ ] | F-W3-3 [ ] | R1 [ ] | R3 [ ]
R4 [ ] | R5 [ ] | hash [ ] | AC-10B [ ]
```

