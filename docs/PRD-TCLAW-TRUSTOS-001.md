# PRD — TORQCLAW TrustOS v1 (rev 1.2)

## Governed Self-Improving Agent Control Plane

**Project:** TORQCLAW
**PRD ID:** TCLAW-TRUSTOS-001
**Owner:** King Flowers
**Status:** Draft for implementation planning
**Revision:** 1.2 — rev 1.1 revised against a full repo audit (2026-07-08; baseline claims verified with file:line evidence, see Appendix A). Rev 1.2 addresses G1R review: Epic 0 ticketized (TCLAW-0A–0F), channel task ownership model, fail-closed capability default, staged CI (v0/v1/v2), rebuildable receipt projection, learning-reflection privacy/cost constraints, Phase 0 / Epic 10 boundary, explicit marketplace deferral (§9.6.5), cross-reference fixes.
**Target:** Total implementation of TORQCLAW's positive competitive improvements
**Primary positioning:** The trust layer for self-improving agents

---

# 1. Executive Summary

TORQCLAW will become a governed, self-improving, local/cloud hybrid AI agent platform that combines the best parts of Hermes and OpenClaw while engineering out their weaknesses.

Hermes contributes the self-improving learning loop and flexible execution engine. OpenClaw contributes broad gateway/channel thinking and extensible tool/skill ecosystem patterns. TORQCLAW's competitive advantage is adding what both still lack at product-grade depth:

* visible trust
* cost control
* approval before action
* explainable routing
* auditable learning
* skill provenance
* safe channel expansion
* governed tool/skill ecosystem
* replayable receipts
* zero-trust security posture

The goal is not to become "another agent." The goal is to become the control plane users trust to run agents safely.

---

# 2. Product Thesis

TORQCLAW wins by owning this lane:

```text
Local when private.
Cloud when needed.
Approval before action.
Budget before spend.
Receipts after every run.
Learning that is measurable, governed, and reversible.
```

Current agent platforms compete on breadth, autonomy, and tool count. TORQCLAW will compete on **trusted autonomy**.

Users should feel:

```text
I know what it did.
I know what it cost.
I know what it touched.
I know why it routed that way.
I know what it learned.
I know who approved it.
I know how to undo it.
```

---

# 3. Problem Statement

Existing self-hosted and always-on agent platforms expose users to five major pain points:

1. **Runaway cost risk**
   Autonomous cloud agents can burn credits without clear caps, warnings, or receipts.

2. **Opaque routing**
   Users do not know why a task ran locally, in the cloud, with what model, or with which tools.

3. **Unsafe tool execution**
   Write-capable tools, local MCP tools, shell actions, file writes, and external sends can create accidental or malicious side effects.

4. **Unverifiable self-improvement**
   "The agent learns" is attractive, but users need proof, provenance, metrics, rollback, and approval.

5. **Channel/tool ecosystem risk**
   Broad integrations and community skills are powerful but expand the attack surface.

TORQCLAW already has most of the architectural foundation to solve these — but the audit (§6, Appendix A) shows the foundation itself has three load-bearing gaps that must close before any trust feature ships on top of it: **no CI exists**, **connection roles are not enforced as authorization**, and **the skill-generation half of the learning loop is not wired**. This PRD turns the verified foundation into a complete product system, and repairs those gaps first.

---

# 4. Goals

## 4.1 User Love Goals

TORQCLAW should feel:

* safer than OpenClaw-style agent ecosystems
* more transparent than Hermes-style self-improvement
* easier to trust than generic agent runners
* powerful without feeling dangerous
* autonomous without feeling out of control
* local/private by default when needed
* cloud-capable when useful
* understandable after every run

## 4.2 Business / Competitive Goals

TORQCLAW should become:

* the governed alternative to fast-moving insecure agent stacks
* the safest self-improving personal/enterprise agent control plane
* the best hybrid local/cloud routing system for agent workflows
* the platform where skill ecosystems become trustworthy
* the control plane for high-stakes personal, business, and developer agents

## 4.3 Engineering Goals

* Preserve current TORQCLAW invariants (§15).
* Add governance without killing autonomy.
* Keep approvals, receipts, budgets, and routing reasons first-class.
* Keep TS contracts as protocol source of truth.
* Keep Hermes wrapped, not rewritten.
* Keep local/private and cloud/frontier behavior clearly separated.
* Avoid any hidden side effects.
* **Every claim this PRD makes about "current capability" is backed by code evidence (Appendix A) — no aspirational baselines.**

---

# 5. Non-Goals

This PRD does not aim to:

* replace the Hermes engine entirely
* clone OpenClaw's full ecosystem blindly
* build a public/community skill marketplace at all within this PRD — marketplace distribution is explicitly deferred behind the Epic 6 exit criteria (§9.6.5) and requires its own PRD once skill safety is proven in production
* permit silent write actions
* allow cloud routing of private/local-only tasks
* auto-deploy generated skills
* introduce production cloud dependencies without approval
* weaken local-first privacy guarantees
* make every user configure complex policies on day one
* add a third compute tier (the two-tier LOCAL_EDGE / FRONTIER model stays; "cheaper retry" means a cheaper FRONTIER provider/model, not a new tier)

---

# 6. Verified Baseline (Repo Audit, 2026-07-08)

This section replaces the aspirational baseline of rev 1.0. Status legend: ✅ exists and verified · 🟡 partial · ❌ missing. Evidence is in Appendix A.

## 6.1 What exists and works

1. ✅ **Per-task cost circuit breaker.** Provider-reported spend (Nous credits → account-usage delta → `null`) polled every 2s; breach cancels the engine task and fails with `BUDGET:` + retry chip and a suggested doubled budget. No pricing tables anywhere — enforcement truth is provider-reported spend only. Spend heartbeat every 30s. When spend is unreportable, a single honest SYSTEM message says so and the iteration cap is the guard.
2. ✅ **Hybrid routing with an ordered rule hierarchy.** Privacy override → LOCAL_ONLY → local intent → local-tool intent → low classifier confidence → tool-count overflow → cold-start latency → heuristic score (with `TORQCLAW_PREFER_CLOUD` threshold drop). Every decision already emits a `RouterDiagnostics {score, reason, tier}` object on the `TIER_SELECTED` event.
3. ✅ **Write gates on both tiers.** LOCAL_EDGE throws `ToolApprovalRequired` before executing a gated tool; FRONTIER blocks via the Hermes `pre_tool_call` hook. Approvals are server-owned: the `APPROVE_TOOL` command carries only `approvalId` + decision; the granted tool name is read from the DB row; client-supplied `grantedTools` is stripped at enrichment. Grants are single-use by construction (guarded `UPDATE … WHERE status='pending'`, one re-mint per decision). Deny ends cleanly; blocked attempts never write RESULT or memory.
4. ✅ **Approval persistence.** `tool_approvals` table (approval_id, request_id, tool_name, args_json, status, created_at, decided_at) — rows are never deleted. Args are stored for display/audit only and never replayed.
5. ✅ **Cross-language contracts.** Zod 4 schemas dual-emit JSON Schema (Draft 2020-12) into `packages/contracts/generated/` and the Python wrapper's `schemas/` dir at build time. Python validates every inbound `GatewayRequest` with `Draft202012Validator`.
6. ✅ **Honest receipts, durably persisted.** `buildReceipt()` uses real telemetry only; absent fields are omitted, never invented. Receipts ride a terminal `SYSTEM "Done"` event that is persisted to the `events` table; final telemetry also lands in `tasks.telemetry_json`. Monotonic `events.seq` is the replay cursor; sessions resume via `lastSeenSeq`.
7. ✅ **Memory hygiene.** Cancelled, blocked, and failed tasks never reach `storeEpisode`; FTS5 recall cannot surface aborted attempts.
8. ✅ **Honest headless channel.** channel-http maps PENDING_APPROVAL → HTTP 202 (it cannot click a card and says so), RESULT → 200, ERROR → 502.
9. ✅ **Skill no-auto-deploy gate.** Queued skills sit in `skill_queue` (pending → approved / approved_edited / rejected); only approval writes `SKILL.md`. Console has an approve/deny/edit-and-approve card with line diff.

## 6.2 Verified gaps that change this PRD's plan

1. ❌ **No CI exists.** There is no `.github/` in the repo. Unit tests (vitest) and six stub-mode e2e scripts (`ops/e2e*.mjs`, including a budget-breaker e2e) run manually only. Epic 10's "fail CI on drift" has no CI to fail — CI bootstrap is now a Phase 0 deliverable.
2. ❌ **Connection roles are not authorization.** The `ConnectFrame` role (`operator|channel|node`) is recorded but never enforced — a `channel` seat has the same command surface as an operator, including `APPROVE_TOOL` and `APPROVE_SKILL`. A compromised or misconfigured channel adapter could approve write tools. This is the single most important security fix in the PRD (Epic 0).
3. ❌ **The learning loop's generation half is not wired.** `draft_and_queue_skill` has zero callers; the vendored Hermes runs with `skip_memory=True` and no reflection hook. The "self-improving skill loop" is today an approval surface with nothing feeding it. Epic 5 must first wire generation, then govern it.
4. 🟡 **Write-risk classification is name-regex only, and path scope inherits the same weakness.** A tool is write-gated iff its raw name matches `/write|delete|push|create|update|send|exec/i` (or per-server `approvalPatterns`). Worse: path-scope enforcement checks **write** scope only for tools flagged by that same name match — a write-capable tool with an innocent name is checked against the *read* scope. Epic 3's risk classifier must fix both.
5. 🟡 **Route explanation exists but is thin.** `RouterDiagnostics` is `{score, reason: string, tier}` — the reason is a prefixed string, not the structured object (rule fired, blocked alternatives, safety locks, overrides) Epic 2 needs. Extend it; don't duplicate it.
6. 🟡 **Contracts validation is asymmetric.** Python validates `GatewayRequest` only; `GatewayEvent`/`ClientCommand` schemas are copied but unused, and `ConnectFrame` is not emitted to JSON Schema at all. No `schemaVersion`, no golden fixtures, no drift check, **no Python test suite of any kind**.
7. ❌ **No session-level or daily caps.** Budget is strictly per-task (`maxCost` → `TORQCLAW_DEFAULT_MAX_COST` → unlimited-with-warning).
8. ❌ **No protected-path defaults.** Path deny lists are entirely per-server config in `~/.torqclaw/servers.json`; a fresh install has no `.env`/`.ssh`/credentials protection.
9. ❌ **No grant TTL.** Grants are single-use (which is stronger than a TTL for "allow once"), but the PRD's broader scopes ("allow for this task") require expiry semantics that don't exist yet.
10. ❌ **No rate limiting anywhere** (gateway or channel-http), and channel-http's upstream gateway token defaults to the literal string `'dev'`.
11. 🟡 **Cost attribution breaks under concurrency.** The account-usage-delta fallback attributes the whole account's spend delta to whichever task is polling — explicitly noted in code as "acceptable for single-operator v1." Session/daily caps and channel expansion make concurrent tasks likely; this becomes a real correctness risk (see Risk 6).
12. 🟡 **Approval history exists in the DB but has no query API and no UI.** The console reconstructs decisions from the live event stream only.

---

# 7. Target Users

## 7.1 Primary Users

**Solo power user / operator** — wants an always-on agent but no surprise spend, accidental file writes, or hidden cloud leakage.

**Developer / builder** — wants local/cloud automation, coding help, repo workflows, tool execution, and replayable receipts.

**Business operator** — wants agents for research, workflows, summaries, channel responses, and internal automation with approval gates.

**Security-conscious user** — wants self-hosting, local privacy, explicit capability scopes, and proof of what happened.

## 7.2 Future Users

**Small team** — multiple agent roles, permission boundaries, shared audit history.

**Enterprise / regulated user** — zero-trust defaults, policy evidence, compliance exports, audit trails.

---

# 8. Core Product Principles

1. **User intent beats model confidence.** If the user marks a task private or local-only, it stays local.
2. **No spend without a budget story.** Every cloud task must show budget state: capped, default-capped, or uncapped with warning.
3. **No write without permission.** Write-capable tools must pause for approval unless covered by a clearly scoped grant.
4. **No learning without provenance.** Every generated/refined skill or memory entry must explain where it came from.
5. **No claims without evidence.** Receipts must be built from real telemetry, tool events, diffs, logs, tests, and approvals.
6. **No hidden widening of authority.** Client requests cannot inject grants, scopes, or internal authorization — and a connection's *role* bounds its command surface.
7. **Progressive disclosure.** Simple users see simple controls. Power users can drill into policies, receipts, and audit trails.
8. **Capability is judged by behavior, not by name.** Risk classification and scope enforcement must not rest solely on a tool's name string.

---

# 9. Feature Epics

## Epic 0 — Foundation Repair *(new in rev 1.1)*

### 9.0.1 Objective

Close the audited gaps that everything else in this PRD stands on. Nothing in Epics 1–10 ships before these.

### 9.0.2 Ticket breakdown

Epic 0 ships as six tickets, TCLAW-0A through TCLAW-0F. Dependencies are explicit; TCLAW-0A (stage v0) is the first implementation ticket of the entire PRD.

#### TCLAW-0A — CI pipeline (staged v0 → v1 → v2)

CI lands in three stages so a green pipeline exists from day one and hardens incrementally instead of blocking on the full matrix:

* **CI v0 — TypeScript core (no new product code required):** `.github/workflows/ci.yml` on push/PR — pnpm install (frozen lockfile), `@torqclaw/contracts` build, `pnpm typecheck`, `vitest run`. Must be green on current `master` before merging.
* **CI v1 — integration + drift:** adds `pnpm contracts:check` (drift gate; script delivered by TCLAW-10A — see the Phase 0 / Epic 10 boundary note in §12) and the six stub-mode e2e scripts (`e2e`, `e2e-approval`, `e2e-approval-cloud`, `e2e-cancel`, `e2e-budget`, `e2e-channel`) with the Python engine in stub mode (`uv sync`, no provider keys, no network).
* **CI v2 — cross-language:** adds the Python pytest job (depends on TCLAW-0E) and golden-fixture validation (TS-emitted fixtures validated by the Python validators; fixtures delivered by TCLAW-10A).

Also: add `test` to the turbo pipeline (v0).

Acceptance: each stage fails the build on its own class of regression; v0 green before v1 starts; v1 green before v2 starts.

#### TCLAW-0B — Role-based command authorization + channel task ownership

* Enforce the `ConnectFrame` role at command dispatch:
  * `operator` — full surface.
  * `channel` — `SUBMIT_PROMPT`, `CANCEL_TASK` (owned tasks only, per the ownership model below), `MEMORY SHOW` at most; **never** `APPROVE_TOOL`, `APPROVE_SKILL`, `MEMORY FORGET_SESSION`.
  * `node` — deny-all until the seat is first specified.
* **Task ownership model (for `CANCEL_TASK` and channel receipts):**
  * At submit time the gateway stamps every task with its authenticated originating seat: `owner_session_id`, `owner_role`, and `owner_channel`. Channel identity is derived from the authenticated connection (the seat that presented the token), **never** from the request body — the payload's `sourceChannel` string remains display metadata only.
  * Authorization rule: an `operator` seat may cancel any task; a `channel` seat may cancel a task iff the task's `owner_channel` equals that seat's authenticated channel identity.
  * Ownership is server-recorded, immutable for the task's lifetime, and inherited by re-minted (post-approval) descendant tasks — a grant re-run keeps the original owner.
* Unauthorized command → typed `ERROR` event, socket stays open, attempt logged (feeds the role-authorization-denial metric, §13.2).
* Contract tests: a `channel` seat sending `APPROVE_TOOL` is rejected; a `channel` seat cancelling another channel's task is rejected; a re-minted task retains its original owner.

#### TCLAW-0C — Behavior-based capability classification, fail-closed default, path-scope fix

* Introduce an explicit per-tool `capability` (read / write / exec / send) resolved in priority order: server-config annotation → MCP tool annotations (if provided) → name-pattern fallback.
* **Fail closed on unknown:** a tool whose capability cannot be resolved by any source is treated as write-class — approval-gated and write-scope-checked. Unknown never means read. Migration note: previously silent, oddly named read-only tools may start prompting; the remedy is an explicit `capability: read` annotation in server config, never a relaxation of the default.
* Decouple path-scope mode from the approval flag: the write-scope check applies to any write-class tool regardless of whether it is approval-gated.
* Regression tests: an innocent-named write tool is write-scope-checked; an unannotated unknown tool is gated and write-scope-checked.

#### TCLAW-0D — Cost-breaker unit tests

* Unit tests for `resolveBudget` precedence, `CircuitBreakerError` on breach, heartbeat cadence, and the unreportable-spend path (breaker skipped, honest message emitted). The e2e budget script stays as the integration layer; unit coverage is the CI-fast layer (runs in CI v0).

#### TCLAW-0E — Python test suite bootstrap

* pytest suite over `mcp_wrapper`: task_store, skill_queue, contracts validation (GatewayRequest fixtures), approval hook, spend resolution via the stub env seams (`HERMES_STUB_COST_USD`, `HERMES_STUB_COST_UNAVAILABLE`). Prerequisite for CI v2.

#### TCLAW-0F — Token hygiene

* Remove the literal `'dev'` default for the channel adapter's upstream gateway token; unset means unset, with the existing loopback-dev-mode warning path.

### 9.0.3 Acceptance Criteria

* CI v0 runs on every push/PR and fails on any unit-test, typecheck, or contracts-build failure; v1 adds drift + e2e; v2 adds Python.
* A `channel` seat cannot approve tools or skills, and cannot cancel tasks it does not own (test-proven).
* Task ownership is stamped server-side at submit and survives re-mint (test-proven).
* An unknown-capability tool is treated as write-class: gated and write-scope-checked (test-proven).
* A write-capable tool with an innocent name is write-scope-checked; approval policy can catch it via capability annotation.
* Breaker behavior is unit-tested in CI.

---

## Epic 1 — Cost Control Center

### 9.1.1 Objective

Make cost safety visible, enforceable, and lovable.

### 9.1.2 Verified current capability

Per-task `maxCost`, env fallback (`TORQCLAW_DEFAULT_MAX_COST`), provider-reported spend chain, 30s spend heartbeats, 2s breaker polling, cancel-on-breach with retry chip and suggested doubled budget, honest "budget unenforceable" messaging, LOCAL_EDGE runs are cost-free by construction (no cost telemetry exists on that tier — the receipt says "free"). **No session or daily caps. No dedicated cost event type (cost rides SYSTEM/RESULT/receipt). Cost attribution is unreliable under concurrent FRONTIER tasks (account-delta fallback).**

### 9.1.3 User story

As a user, I want to know what a task may cost before and during execution so I can safely use cloud models without credit anxiety.

### 9.1.4 Requirements

#### Functional

* Visible budget selector in the composer *(exists: default/free/$0.25/$1/$5/custom — keep, surface the resolved budget source)*.
* Every run carries an explicit cost state: `free-local` / `capped` / `default-capped` / `uncapped-warned` / `unenforceable`.
* Live spend heartbeat during FRONTIER execution *(exists — surface in UI, don't rebuild)*.
* Warning when provider cannot report cost *(exists — surface in Cost Control Center)*.
* Recovery options on budget breach: retry local, retry cheaper (cheaper FRONTIER provider/model via the existing per-task provider override mechanism), retry with raised budget *(suggested budget already computed)*, cancel.
* **Session-level cap and daily cap** (new): enforced gateway-side by summing provider-reported per-task spend; a new task whose session/day total already exceeds the cap is refused before dispatch with a clear message. Because per-task attribution can over-count under concurrency, session/daily enforcement must treat totals as conservative (over-counting blocks sooner, never later) and say so.
* Per-provider spend summary.
* Cost receipt after every cloud task *(exists in receipt — add enforcement status field)*.
* Budget breach event in timeline *(exists as ERROR with `BUDGET:` prefix — give it a distinct `metadata.kind`)*.
* `BudgetPolicy` contract in `packages/contracts` (per-task, session, daily, per-channel fields; all optional).

#### Non-functional

* Do not use static pricing tables as enforcement truth. *(Invariant — currently true; keep it true.)*
* Provider-reported spend remains the source of truth.
* If provider spend is unavailable, say so clearly *(exists)*.
* Budget defaults must be explicit and visible.
* Concurrency caveat: until per-task attribution is solved (Risk 6), the UI must not present concurrent-task cost splits as exact.

### 9.1.5 UI — Cost Control Center panel

* current session spend · daily spend · budget cap · cloud task count · breaker firings · provider spend availability · top expensive runs · retry recommendations

### 9.1.6 Acceptance Criteria

* A user can set a per-task budget before submit. *(exists — regression-covered)*
* A FRONTIER task shows live spend if available.
* If spend crosses budget, the task is cancelled. *(exists — now unit-tested via Epic 0)*
* If spend is unavailable, user sees "budget unenforceable; iteration cap only." *(exists)*
* Receipt shows budget limit, actual cost, and enforcement status.
* Session/daily caps refuse new cloud tasks once breached.
* No private/local-only task is routed cloud because of budget settings.

---

## Epic 2 — Explainable Hybrid Router

### 9.2.1 Objective

Make every routing decision understandable and adjustable without compromising safety.

### 9.2.2 Verified current capability

Ordered rule hierarchy (privacy → LOCAL_ONLY → LOCAL_INTENT → LOCAL_TOOL_INTENT → low-confidence → tool-count → cold-start → heuristic + PREFER_CLOUD). `RouterDiagnostics {score, reason, tier}` already exists in contracts and is emitted as `TIER_SELECTED` metadata on every task. ~24 router unit tests cover the hierarchy. **The reason is a single prefixed string; there is no structured rule-ID, no blocked-alternatives list, no override tracking, no route preview.**

### 9.2.3 User story

As a user, I want TORQCLAW to explain why a task ran locally or in the cloud so I can trust the routing decision.

### 9.2.4 Requirements

#### Functional

* **Extend `RouterDiagnostics` — do not create a parallel object.** Add optional fields (additive, non-breaking for the Python consumer):
  * `ruleId` (machine-readable: `PRIVACY_OVERRIDE`, `USER_LOCAL_ONLY`, `LOCAL_INTENT`, `LOCAL_TOOL_INTENT`, `LOW_CLASSIFIER_CONFIDENCE`, `TOOL_COUNT_OVERFLOW`, `LATENCY_CRITICAL`, `HEURISTIC_EVAL` — these prefixes already exist in the reason strings; promote them)
  * `humanReason`
  * `blockedAlternatives[]` (tier + why it was excluded)
  * `overridable: boolean` + `safetyLock?: string`
  * `profile` (which routing profile was active)
* Route preview before task starts (run `evaluateRequest` at compose time — the router is a pure function over the enriched request; preview must state that enrichment may change on submit).
* "Why this route?" panel.
* Routing profiles: Privacy-first / Cheapest / Fastest / Most capable / Local-only / Balanced. Profiles adjust heuristic thresholds and PREFER_CLOUD semantics only — they can never touch rules 1–1b'.
* Route simulation mode (dry-run: full diagnostics, no dispatch).
* Track user overrides; stats: auto-accepted, overridden, forced local, forced cloud, privacy-override count, low-confidence cloud-bounce count.
* Route replay in receipt *(the diagnostics object is already persisted with the TIER_SELECTED event and `tasks.router_reason` — surface it)*.

#### Safety locks (never overridable by any profile)

* `containsSensitiveData` *(user-controlled; automation must never clear it — existing invariant)*
* `LOCAL_ONLY`
* local-only tool intent (bridge-only tools exist only on LOCAL_EDGE — routing such a task to FRONTIER is not merely unsafe, it is non-functional)
* denied policy
* workspace path deny
* missing required provider credential

### 9.2.5 UI

Composer route preview badge · hover/click explanation · "Run local anyway" when allowed · "Cloud allowed" when allowed · "Private/local lock" when not overrideable · route reason in final receipt.

### 9.2.6 Acceptance Criteria

* Every task has a structured route explanation (ruleId + humanReason at minimum).
* User can preview routing before submit.
* Privacy and local-only overrides always win *(existing tests stay green)*.
* User overrides are stored in stats.
* No route explanation is fabricated after the fact — the receipt shows the same diagnostics object emitted at dispatch time.
* Python continues to validate GatewayRequest after the additive schema change (drift check from Epic 10 proves it).

---

## Epic 3 — Permission Command Center

### 9.3.1 Objective

Make approval-gated write actions easy to understand, safe to approve, and auditable.

### 9.3.2 Verified current capability

Both tiers pause on gated writes; approvals are server-owned and single-use; `tool_approvals` persists every decision with timestamps; args are display-only, never replayed; deny ends cleanly with recovery chips; blocked attempts don't poison memory; the console approval card already shows tool name, args JSON, and one-time scope honestly. **Gaps: name-regex-only risk detection (fixed in Epic 0), no risk categories, no protected-path defaults, no approval-history API/UI, no scoped grants beyond allow-once, no TTL semantics, no diff-before-write for tools (a line-diff exists but only for skill edits).**

### 9.3.3 User story

As a user, I want to see exactly what an agent is about to do before I allow a tool write.

### 9.3.4 Requirements

#### Functional

* Approval card v2: tool name *(exists)* · server namespace *(exists via `server__tool` naming)* · action category (new — from the Epic 0 capability classifier) · arguments *(exists)* · target paths/resources (new — reuse the bridge's existing `extractPaths`) · risk reason · policy match · expected side effect · deny/allow actions *(exists)*.
* Approval scopes:
  * deny *(exists)*
  * allow once *(exists — single-use by construction, stronger than TTL; keep)*
  * allow for this task (new — grant persists across re-mints descended from the same original request; requires a grant table keyed by lineage, with expiry on task terminal state)
  * allow read-only (new)
  * require diff first (new)
* Approval history table **API + UI** — the `tool_approvals` table already holds the data; add a query endpoint and console surface. Extend the table per §10.2 rather than creating a parallel `approval_history` table.
* Approval replay in receipt.
* Tool risk classifier categories: read-only · file write · delete/move · shell/exec · network send · external publish · credential-sensitive · production-sensitive. Built on the Epic 0 capability model; category feeds the card and the history. Unknown-capability tools fail closed (TCLAW-0C): until classified, they carry the highest applicable write-class category on the approval card, never "read-only."
* Global protected patterns, **on by default** in a new global scope layer above per-server config: `.env`, `.ssh`, `.aws`, credentials, tokens, signing files, private config, local state DBs (including `~/.torqclaw/state.db` and `hermes_tasks.db` themselves). Per-server `deny` rules continue to win; global protected patterns require explicit elevated operator confirmation to override, per approval.
* Diff-before-write option for filesystem tools (generate the diff in the bridge before execution, render with the existing console `lineDiff`).
* "Why blocked" explanations *(path denials already emit tool error + SYSTEM event — make the message state the matching rule)*.

#### Non-functional

* Client cannot widen approval *(exists — command carries no tool name; keep the contract test)*.
* Approval row remains server-owned *(exists)*.
* Denied tool creates a clean terminal result *(exists)*.
* Blocked attempts do not write result memory *(exists)*.
* Grants expire: allow-once by construction *(exists)*; task-scoped grants expire on task terminal state; no grant survives a gateway restart.

### 9.3.5 Acceptance Criteria

* Approval card shows exact tool, args, category, and targets.
* Approval cannot be spoofed by client payload *(existing test)*.
* Allow once grants only the intended tool *(exists)*.
* Deny emits clean recovery *(exists)*.
* Approval history is visible in the console with filters.
* Protected paths cannot be approved without explicit elevated operator confirmation.
* A `channel`-role seat can never decide an approval (Epic 0).

---

## Epic 4 — Run Receipts & Replay Dashboard

### 9.4.1 Objective

Make every run replayable, explainable, and exportable.

### 9.4.2 Verified current capability

Receipts are real-telemetry-only, ride the terminal `SYSTEM "Done"` event, and are **already durably persisted** — every event lands in the `events` table (monotonic `seq`) and final telemetry in `tasks.telemetry_json`. Session resume replays by `seq` cursor. The console renders a receipt card. **Gaps: no queryable receipt model (data is spread across events/tasks), no replay page, no export, `toolsUsed` is reconstructed client-side rather than recorded in the receipt.**

### 9.4.3 Requirements

#### Functional

Each run receipt must include: task ID · session ID · prompt summary · selected route + `RouterDiagnostics` · model/tier · cost + enforcement status · elapsed time · iterations · tools called (**move from client-side reconstruction into the server-built receipt**, aggregated from persisted TOOL_CALL events) · approvals requested/granted/denied (join on `tool_approvals`) · cancellation state · final result/error · memory used · context chars · retry options · side-effect note · source channel · evidence links (event seq ranges).

**Receipt materialization:** implement `run_receipts` (§10.1) as a materialization over the existing `events` + `tasks` + `tool_approvals` tables at task-terminal time — not a second write path that could drift from the event log. The event log remains the source of truth; the receipt row is a queryable projection of it.

**The projection must be rebuildable and idempotent:**

* The projector is a pure function of persisted rows (`events` + `tasks` + `tool_approvals`) — it reads no in-memory state, so a receipt can be regenerated at any time after the fact.
* `run_receipts.task_id` is UNIQUE; materialization is an upsert keyed on it. Projecting the same task twice yields byte-identical rows; a crash between task-terminal and projection is healed by re-projecting, never by hand-editing.
* A `receipts:rebuild` admin operation re-projects one task, one session, or the full table. Given an unchanged event log, drop-and-rebuild reproduces the table exactly.
* Each row carries a `projection_version`; when the projector logic changes, bumping the version and rebuilding migrates old receipts without touching the event log.

Replay page: timeline of events in `seq` order *(the data and cursor semantics already exist)* — system events, tool calls, approval pauses, result/error, receipt footer.

Export: copy diagnostic *(a COPY_DIAGNOSTIC recovery chip already exists — extend)* · safe redacted receipt (Bearer-token sanitization already exists in dispatch; extend redaction to provider-key shapes using the console's existing secret-shape regexes, applied server-side) · full local receipt · JSON · Markdown.

### 9.4.4 Acceptance Criteria

* Every terminal state has a receipt *(exists — one terminal event per task is an invariant)*.
* Receipts use only real telemetry/events *(exists — keep the "absent fields omitted, never invented" rule)*.
* User can replay task events in order.
* `receipts:rebuild` over an unchanged event log reproduces the `run_receipts` table exactly (idempotency test-proven).
* User can export safe diagnostics; redaction is server-side and test-covered against known secret shapes.
* Failed runs say what did and did not happen.
* Cancelled/budget-broken runs do not poison memory *(exists — regression-covered)*.

---

## Epic 5 — Governed Learning Loop

### 9.5.1 Objective

Turn Hermes-style self-improvement into an auditable, measurable, reversible product feature.

### 9.5.2 Verified current capability — read this first

The approval half exists end-to-end (queue table, decide/get-draft MCP tools, gateway commands, console card with edit-and-approve + diff, no-auto-deploy gate). **The generation half does not exist: `draft_and_queue_skill` has no caller anywhere in the repo, and the vendored agent runs with memory/reflection disabled. Provenance is a single `source_task_id` column. There is no versioning, no rollback, no metrics.** Epic 5 therefore starts with wiring generation — governance features have nothing to govern until then.

### 9.5.3 Requirements

#### 5.0 Wire skill generation (prerequisite)

* Add a post-task reflection step in the wrapper (not in vendored Hermes internals) that, under learning policy, evaluates a completed FRONTIER task for skill-worthiness and calls `draft_and_queue_skill`.
* Generation triggers only on successful, non-private, non-cancelled tasks (aligns with the existing memory-hygiene rules).
* Every draft carries the full provenance record below from day one.

**Privacy constraints on reflection:**

* Reflection never runs on tasks from private (`containsSensitiveData`), `LOCAL_ONLY`, or learning-excluded sessions — enforced at the trigger with the same predicate that guards memory writes, and by construction: reflection input is limited to the task's own episode record and receipt, never raw session context or cross-session memory.
* Reflection output (the skill draft) must not embed prompt or result content from any task other than its declared source tasks; provenance lists exactly what it read.

**Cost constraints on reflection:**

* Reflection runs on LOCAL_EDGE by default. Cloud reflection is opt-in per learning policy and carries its own explicit `maxCost` — reflection can never incur uncapped cloud spend.
* Reflection spend is recorded in the `spend_ledger` (§10.7) tagged `learning`, counts toward session/daily caps, and is surfaced in the Cost Control Center as learning overhead.
* A global learning-off policy switch disables the reflection trigger entirely at zero cost.

#### Skill provenance

Every generated or refined skill must include: skill ID · proposed name · source task IDs · source session IDs · trigger reason · evidence summary · expected benefit · risk class · required capabilities · approval state · confidence score (evidence-based: derived from source-task outcomes, never model-asserted) · version · rollback pointer · test results · last used · success/failure metrics.

#### Skill lifecycle

Statuses: proposed · pending approval · approved · active · disabled · rejected · superseded · rolled back.
Migration note: the existing `skill_queue` statuses (`pending`, `approved`, `approved_edited`, `rejected`) map into this lifecycle; `approved_edited` becomes `approved` + a `humanEdited` provenance flag. `skills_registry` (§10.3) supersedes `skill_queue`; migrate, don't run both.

Rollback requires tracking what activation wrote: the registry must record the `SKILL.md` path and version hash so disable/rollback can remove or restore the exact artifact (today the file write is fire-and-forget).

#### Learning policies

auto-propose only · require approval for all skills · auto-approve low-risk private skills · **never learn from private sessions** · never learn from failed tasks · domain allowlist/denylist · tool capability allowlist · retention limits.

#### Metrics

skill usage count · success rate · failure rate · human edits · rollback count · time-saved estimate · repeated-task improvement · confidence drift · last verification. All evidence-backed raw counts (Risk 2).

### 9.5.4 UI — Learning Dashboard

"What TORQCLAW learned" · proposed skills · active skills · disabled skills · skill confidence · skill evidence · approve/edit/reject *(card exists — extend)* · rollback · learning policy settings · monthly improvement report.

### 9.5.5 Acceptance Criteria

* Skill generation actually fires from completed tasks under policy (the loop is closed).
* No skill auto-deploys without policy approval *(existing invariant — keep test-covered)*.
* Every skill has provenance.
* User can approve, edit, reject, disable, or rollback.
* Private sessions are excluded from learning, enforced at the generation trigger.
* Skill confidence is evidence-based, not model-invented.
* Learning dashboard shows actual usage/effectiveness.

---

## Epic 6 — Governed Skill Ecosystem

### 9.6.1 Objective

Enable safe private, official, and community skills without marketplace malware risk.

### 9.6.2 Requirements

#### Skill registry types

built-in official · local private · generated · imported community (operator-initiated local import of a community-authored skill file — **not** marketplace distribution; see §9.6.5) · organization-approved · experimental

#### Skill manifest

name · version · author/source · permissions requested · tool namespaces needed · file/network scopes · approval patterns · secrets required · tests · risk rating · provenance · changelog · signature/hash · compatibility version.
(Today a skill is a bare `SKILL.md` with no frontmatter — the manifest is net-new and must be introduced in Epic 5's registry so generated and imported skills share one format.)

#### Import pipeline

static scan → permission extraction → suspicious pattern detection → capability preview → sandbox simulation → user approval → activation → rollback checkpoint.

#### Skill testing harness

dry run · fixture input · expected output · tool-call simulation · denied-permission simulation · path-scope simulation · budget simulation.

### 9.6.3 UI — Skill Center

installed / proposed / imported skills · permission summary · risk badge · scan result · test result · activate/disable/rollback.

### 9.6.4 Acceptance Criteria

* Imported skills cannot run before scan and approval.
* Skill permissions are visible.
* User can simulate a skill before activation.
* High-risk skills require explicit operator approval.
* Skill rollback works.
* Skill source/provenance is visible.

### 9.6.5 Marketplace deferral — scope boundary and exit criteria

Everything in this epic operates on skills the operator explicitly brings to the machine (generated locally, or a file/repo the operator chooses to import). A **public/community marketplace** — browsing, publishing, discovery, remote installation — is out of scope for this PRD and all of its phases.

Marketplace work may not begin until all of the following exit criteria are met, and then only under a separate approved PRD:

1. Skill rollback proven in real use (multiple rollbacks executed cleanly, artifact removal verified by hash).
2. The import scanner + sandbox simulator has run for a full phase with zero known bypasses.
3. Signature/hash verification infrastructure is shipped and enforced for imported skills.
4. The Security Posture Dashboard (Epic 9) reports skill risk and flags unscanned skills in production.

Until then, "community skills" means files an operator deliberately imports through the full scan → sandbox → approval pipeline, nothing more.

---

## Epic 7 — Multi-Channel Presence Fabric

### 9.7.1 Objective

Expand channel reach without expanding uncontrolled authority.

### 9.7.2 Verified current capability

Console (WS, seq-resume) and channel-http (`POST /task`, loopback-default, optional bearer front-door token, honest 202 on pending approval) exist. **Gaps: no per-channel policy of any kind (budget/tools/memory come from each request body), no rate limits, `sourceChannel` is recorded but never used for authorization, and — until Epic 0 — a channel seat can send any command.**

### 9.7.3 Requirements

#### Channel types

Web console · HTTP channel · Slack · Discord · future: Telegram, email, voice capture, mobile companion.

#### Per-channel policy

Each channel must define: allowed task types · allowed execution modes · max budget (**a channel-supplied `maxCost` is clamped to the channel cap, never trusted to raise it**) · whether private data is allowed · approval capability · write capability · memory access · tool namespace access · notification rules · rate limits · token/auth requirements.

#### Channel safety

* No anonymous non-loopback channels.
* Token required outside local dev *(loopback-default binding exists; the posture dashboard hard-warns on non-loopback-no-token — Epic 9)*.
* Headless channels cannot approve tool writes — now structurally guaranteed by role authorization (Epic 0), not just by adapter behavior.
* Channels that cannot render approval cards return pending approval honestly *(exists — HTTP 202)*.
* Proactive notifications must be user-controlled.
* Per-channel rate limits enforced gateway-side (none exist today).

### 9.7.4 UI — Channel Manager

active channels · scopes · tokens · budget caps · last activity · pending approvals · disable channel · rotate token · test channel.

### 9.7.5 Acceptance Criteria

* Every channel has an explicit policy.
* Channel tasks inherit channel caps; request-body budgets can lower but never raise them.
* Headless channels cannot silently approve (role-enforced, test-proven).
* Channel-specific receipt includes source channel.
* User can disable or rotate channel credentials.

---

## Epic 8 — Agent Teams & Visual Oversight

*(Greenfield — nothing in the current repo implements multi-agent execution. Unchanged from rev 1.0 except the note that agent-role authorization reuses the Epic 0 role/command model rather than inventing a second one.)*

### 9.8.1 Objective

Move TORQCLAW from single-agent execution to governed multi-agent workbench.

### 9.8.2 Requirements

**Agent roles:** Planner · Researcher · Builder · Tool operator · Reviewer · Compliance/safety reviewer · Memory-writer · Channel responder.

**Agent policy:** role · allowed tools · allowed channels · allowed memory scope · approval requirements · budget cap · model/provider · escalation triggers · output format · owner.

**Team execution:** planner creates task graph → agents execute bounded tasks → reviewer audits → memory-writer records verified state → operator approves high-risk gates.

**Visual board:** active agents · current task · status · confidence/evidence state · pending approvals · cost so far · blocked agents · next action.

### 9.8.3 Acceptance Criteria

* Agents cannot exceed assigned tool scope.
* Builder cannot approve own work.
* Reviewer cannot silently mutate implementation.
* Memory-writer cannot edit code.
* Operator can pause/stop any agent.
* Team activity appears in run receipt.

---

## Epic 9 — Security Posture Dashboard

### 9.9.1 Objective

Make TORQCLAW's safety posture visible and actionable.

### 9.9.2 Verified current capability

Loopback-first defaults on gateway (127.0.0.1:18790) and channel-http (127.0.0.1:18792); constant-time token comparison; unset tokens log dev-mode warnings; bearer tokens redacted from error output; malformed MCP server configs degrade only that server. **No dashboard, no config scanner, no security modes.**

### 9.9.3 Requirements

Dashboard sections: gateway binding · auth token status · active channels · exposed surfaces · MCP servers · tool approval patterns · path scopes · denied paths · **default protected-path layer status (Epic 3)** · provider keys presence without revealing values · budget defaults · skill risk summary · last security warning · pending high-risk approvals · local state DB location · telemetry/export settings.

Security modes: Maximum isolation · Balanced · Maximum capability · Custom.

Hard warnings:

* non-loopback with no token
* unrestricted filesystem MCP (empty allowlist = unconstrained is today's semantics — the scanner must flag exactly this)
* write-capable tools without approval patterns **or capability annotations**
* no budget default for cloud
* active imported skill without scan
* channel with write permissions and no approval UI
* role authorization disabled or bypassed
* state DBs outside the protected-path layer

### 9.9.4 Acceptance Criteria

* Dashboard detects risky configuration.
* User sees remediation steps.
* Secrets are never displayed.
* Security mode changes are previewed before apply.
* Dangerous config cannot be silently enabled.

---

## Epic 10 — Protocol Integrity & Schema Drift CI

### 9.10.1 Objective

Ensure the TypeScript gateway and Python Hermes wrapper never drift silently.

### 9.10.2 Verified current capability

Single Zod source dual-emits three JSON Schemas (`GatewayRequest`, `GatewayEvent`, `ClientCommand`) into both consumer dirs at build. Python compiles Draft 2020-12 validators at import and validates **GatewayRequest only**. **`ConnectFrame` is not emitted at all. No `schemaVersion`, no drift check, no golden fixtures, no Python tests, no CI (Epic 0).**

### 9.10.3 Requirements

* **Boundary note:** the first two bullets below are ticket **TCLAW-10A**, delivered during Phase 0 so CI v1/v2 (TCLAW-0A) has something to enforce. The rest of this epic — schemaVersion, extended Python validation, inspector UI, changelog — is protocol-evolution work and stays in Epic 10's own slot. See §12 Phase 0 for the full boundary statement.
* Add `pnpm contracts:check`: rebuild schemas into a temp dir, semantic (parsed-JSON) diff, with a file-set assertion, against both checked-in copies; nonzero exit on drift. Run in CI v1 (TCLAW-0A). *(TCLAW-10A)*
* **Emit `ConnectFrame`** alongside the existing three artifacts, then add golden fixtures for all four: `GatewayRequest`, `GatewayEvent`, `ClientCommand`, `ConnectFrame`. *(TCLAW-10A)*
* Python validation tests against the fixtures (pytest, in the Epic 0 Python CI job) — and extend Python-side validation beyond GatewayRequest to the event frames it produces.
* Add `schemaVersion` to protocol frames (additive optional first; required after one compatibility window).
* Protocol inspector UI showing current schema version and last-validated status.
* Compatibility changelog; breaking changes require a migration note.

### 9.10.4 Acceptance Criteria

* CI fails on schema drift.
* Python validates TS-generated fixtures for all four frame types.
* Protocol inspector shows current schema version.
* Breaking changes require a migration note.
* Generated schemas are not manually edited *(existing rule — now machine-enforced)*.

---

# 10. Data Model Additions

Reconciled with the existing schema (`sessions`, `events`, `tasks`, `task_episodes`, `task_search` FTS5, `skill_queue`, `tool_approvals` in gateway `state.db`; `tasks` + `task_events` in the engine's `hermes_tasks.db`). Rule: **extend or migrate existing tables; never run a parallel table for the same fact.**

## 10.1 `run_receipts` *(new — deterministic projection materialized at task-terminal time from events/tasks/tool_approvals; event log stays source of truth; rebuildable and idempotent per Epic 4)*

```text
id, task_id (UNIQUE — upsert key), session_id, created_at, source_channel,
selected_tier, route_diagnostics_json, budget_limit, budget_source,
cost_usd, cost_enforceable, elapsed_ms, iterations,
tools_called_json, cancelled, blocked_on, memory_used, context_chars,
result_state, safe_export_json, full_receipt_json, projection_version
```

## 10.2 `tool_approvals` *(existing — extend, do not replace)*

Existing: `approval_id, request_id, tool_name, args_json, status, created_at, decided_at`.
Add:

```text
session_id, server_namespace, risk_category, policy_reason,
args_redacted_json, target_summary, decision_scope, decided_by, grant_expires_at
```

## 10.3 `skills_registry` *(new — supersedes `skill_queue`; one-time migration of existing rows)*

```text
id, name, version, source_type, source_uri, author, status, risk_rating,
permissions_json, provenance_json, tests_json, confidence_score,
skill_path, content_hash, created_at, updated_at, last_used_at, rollback_ref
```

(`skill_path` + `content_hash` are what make rollback real — see Epic 5.)

## 10.4 `learning_events` *(new)*

```text
id, skill_id, task_id, session_id, event_type, reason, evidence_json,
before_version, after_version, created_at, approved_by
```

## 10.5 `channel_policies` *(new)*

```text
id, channel_name, channel_type, enabled, allowed_task_types_json,
allowed_tools_json, max_cost, execution_mode_default, can_approve_tools,
can_write, memory_access, rate_limit_json, auth_status, created_at, updated_at
```

## 10.6 `security_findings` *(new)*

```text
id, severity, category, message, evidence_json, remediation,
status, created_at, resolved_at
```

## 10.7 `spend_ledger` *(new — supports session/daily caps, Epic 1)*

```text
id, task_id, session_id, source_channel, provider, cost_usd,
attribution (exact | account_delta | unavailable), created_at
```

---

# 11. UX Surfaces

*(Unchanged in scope from rev 1.0; consolidated. Existing surfaces noted.)*

* **Composer** — budget selector *(exists)*, route preview *(new)*, privacy/local toggle *(exists)*, memory toggle *(exists)*, channel policy indicator, "simulate route" button.
* **Task Timeline** — routing event *(exists)*, cost heartbeat *(exists)*, tool calls *(exists)*, approval pause *(exists)*, budget warning *(exists)*, cancellation *(exists)*, result/error *(exists)*, receipt *(exists as card)*.
* **Run Receipt Page** — full replay, route explanation, cost summary, approvals, tools, memory/context, safe export, retry buttons.
* **Cost Control Center** — per-task/session/daily/provider spend, breaker count, uncapped-run warnings, retry-cheaper suggestions.
* **Permission Command Center** — pending approvals, approval history, risk categories, protected-path attempts, allow/deny templates.
* **Learning Dashboard** — proposed/active skills, provenance, confidence, rollback, policies, improvement metrics.
* **Skill Center** — official/private/generated/imported skills, scan results, sandbox tests, activation controls, permission summary.
* **Channel Manager** — active channels, scopes, budget caps, auth status, rate limits, disable/rotate/test.
* **Security Posture Dashboard** — exposed surfaces, MCP risk, channel risk, budget risk, skill risk, path-scope status, hardening actions.
* **Agent Team Board** — active agents, role, task, model/provider, status, approvals, cost, blocked state, stop/pause controls.

Note: the console is today a single-page terminal component. Multi-surface UX implies real routing/pages in `apps/console`; budget one refactor for it in Phase 1 rather than bolting panels into the terminal component.

---

# 12. Implementation Phases

## Phase 0 — Foundation Repair & Baseline Hardening

Goal: prepare the repo for safe expansion. **This phase absorbed Epic 0.**

Deliverables (by ticket):

* **TCLAW-0A** — CI pipeline, staged v0 → v1 → v2 (§9.0.2).
* **TCLAW-0B** — Role-based command authorization + channel task ownership model.
* **TCLAW-0C** — Behavior-based capability classification, fail-closed unknown default, path-scope write-check fix.
* **TCLAW-0D** — Cost-breaker unit tests.
* **TCLAW-0E** — Python test suite bootstrap (prerequisite for CI v2).
* **TCLAW-0F** — Token hygiene (`'dev'` default removal).
* **TCLAW-10A** *(Epic 10 scope pulled into Phase 0 — see boundary note below)* — `contracts:check` script, `ConnectFrame` emission, golden fixtures for all four frame types.
* Extend `RouterDiagnostics` (additive `ruleId`/`humanReason`/locks).
* `run_receipts` projection (rebuildable/idempotent) + `tool_approvals` extension migration.
* Feature flags for new UX surfaces.

**Phase 0 / Epic 10 boundary:** Phase 0 owns drift *enforcement wiring* — the `contracts:check` script, ConnectFrame emission, golden fixtures (TCLAW-10A), and running them in CI v1/v2 (TCLAW-0A). Epic 10 retains everything about protocol *evolution*: `schemaVersion` on frames, extending Python-side validation beyond GatewayRequest, the protocol inspector UI, and the compatibility changelog. Rule of thumb: "does today's build drift?" is Phase 0; "how do schemas change safely over time?" is Epic 10.

Acceptance:

* CI v0 green on existing unit tests; v1 green on drift gate + e2e; contracts build reproducible.
* Channel seat cannot approve, and cannot cancel tasks it does not own (test).
* Unknown-capability tools fail closed (test).
* Write-scope check no longer keyed to approval-name match (test).
* No behavior change unless covered by tests.

## Phase 1 — Visible Trust MVP

Goal: make existing safety visible.

Deliverables: route explanation panel + preview · run receipt page + replay · cost receipt with enforcement status · approval card v2 · approval history API/UI · basic Cost Control Center · safe diagnostic export (server-side redaction) · console multi-surface refactor.

Acceptance: every task has a structured route explanation · every terminal task has a queryable receipt · approval card shows tool, args, category, targets, reason · cost state visible for cloud tasks.

## Phase 2 — Governed Learning MVP

Goal: close and govern the learning loop.

Deliverables: **wire skill generation (5.0)** · skills registry (migrate `skill_queue`) · provenance model · learning event log · approval queue *(card exists — extend)* · rollback (path + hash tracked) · Learning Dashboard v1 · policies (never-learn-private, require-approval, domain allow/deny).

Acceptance: generation actually fires under policy · no activation without approval · every skill has provenance · approve/reject/disable/rollback all work · dashboard shows source evidence.

## Phase 3 — Channel Presence Fabric

Deliverables: channel policy model + clamping · Channel Manager · harden HTTP channel (rate limits, token required) · Slack adapter · Discord adapter · per-channel budget/tool/memory scopes · headless approval handling (role-enforced).

Acceptance: each channel has an explicit policy · headless channels structurally cannot approve · channel receipts show source channel + applied policy · disable/rotate/test works.

## Phase 4 — Skill Ecosystem

Deliverables: skill manifest format · import scanner · sandbox simulator · permission preview · test harness · official/private/imported categories · risk badges. **Local operator-initiated imports only — no marketplace distribution in this phase or any phase of this PRD (§9.6.5).**

Acceptance: imported skills cannot run before scan + approval · permissions visible · simulation works · high-risk skills need explicit approval · the §9.6.5 exit-criteria checklist is being tracked but is expected to remain unmet within this PRD.

## Phase 5 — Agent Teams

Deliverables: agent role registry (reusing the role/command authz model) · agent policy model · team board · task graph execution · reviewer + memory-writer roles · per-agent budget/tool/memory scopes · agent activity receipts.

Acceptance: agents cannot exceed scopes · builder cannot approve own work · memory-writer cannot edit code · operator can pause/stop any agent · team activity in receipts.

## Phase 6 — Security Posture & Enterprise Readiness

Deliverables: posture dashboard · security modes · risk scanner · remediation suggestions · redacted audit export · policy pack export/import · enterprise checklist.

Acceptance: dashboard detects risky config · secrets never displayed · redacted posture export works · dangerous config requires explicit confirmation.

---

# 13. Metrics

## 13.1 User Love Metrics

percent of runs with receipt opened · repeat usage per week · user cancellations per 100 tasks · approval deny rate · approval confusion feedback · route override rate · safe-export usage · skill approval rate · skill rollback rate · time-to-first-success.

## 13.2 Trust Metrics

tasks with budget cap · uncapped cloud tasks · provider-cost-unavailable tasks · budget breaker firings · blocked write attempts · protected-path attempts · denied high-risk approvals · private tasks routed local · local-only tasks routed local · schema drift failures caught in CI · **role-authorization denials** · **spend-attribution mode distribution (exact vs account-delta vs unavailable)**.

## 13.3 Learning Metrics

proposed skills · approved skills · active skills · disabled/rolled-back skills · skill reuse count · skill success/failure rate · average task improvement after skill activation · user edits per skill · **generation triggers fired vs drafts produced** (proves the loop is actually running).

## 13.4 Channel Metrics

tasks by channel · channel policy violations blocked · headless pending approvals · token rotations · disabled channels · per-channel spend · **request-budget clamp events**.

---

# 14. Risks and Mitigations

## Risk 1 — Governance overload

Too many approvals could make TORQCLAW feel slow.
Mitigation: progressive disclosure · safe defaults · allow-once / allow-task scopes · low-risk automation policies · clear approval reasons.

## Risk 2 — Fake improvement metrics

The learning dashboard could feel like marketing if metrics are weak.
Mitigation: only evidence-backed metrics · raw counts · before/after task IDs · user feedback · no invented "IQ" or "percent smarter" claims.

## Risk 3 — Channel sprawl increases attack surface

Mitigation: per-channel scopes · write disabled by default · token rotation · role-enforced headless no-approval · security posture dashboard · rate limits.

## Risk 4 — Skill marketplace risk

Mitigation: scan before import · sandbox simulation · permission preview · risk badges · rollback · official/private/imported separation.

## Risk 5 — Complex architecture slows delivery

Mitigation: phase delivery · feature flags · preserve existing behavior · ship trust visibility first · defer marketplace/team complexity.

## Risk 6 — Cost attribution under concurrency *(new)*

The account-usage-delta fallback attributes the whole account's spend delta to the polling task. Fine for one task at a time; wrong the moment channels or agent teams run concurrent FRONTIER tasks — and session/daily caps then enforce against distorted numbers.
Mitigation: record attribution mode per spend entry (`spend_ledger`) · treat account-delta totals as conservative (over-count blocks sooner, never later) · prefer per-task-keyed provider usage APIs where available · surface attribution mode in the Cost Control Center · gate agent-team concurrency (Phase 5) on attribution being solved or explicitly conservative.

## Risk 7 — Single-process engine constraint *(new)*

The Hermes wrapper mandates a single process (cancellation registry + SQLite assumptions). Channel expansion and agent teams increase load on one process; horizontal scaling would silently break cancellation.
Mitigation: keep the single-process constraint explicit in ops docs and the posture dashboard · capacity-test before Phase 3/5 · if scaling is ever needed, move the cancellation registry to the DB first.

---

# 15. Critical Invariants to Preserve

1. Privacy beats everything.
2. Local-only means local-only.
3. Write tools pause for approval — on both tiers.
4. Provider-reported spend is the enforcement source; no static pricing tables.
5. No fabricated telemetry.
6. No fabricated tool actions.
7. Blocked/cancelled tasks do not poison memory.
8. Generated skills never auto-deploy outside policy.
9. Client cannot inject internal grants — **and a connection's role bounds its command surface.**
10. Generated schemas are not hand-edited.
11. Hermes remains wrapped, not rewritten.
12. Security posture must be visible before expansion.
13. One terminal event per task.
14. The event log is the source of truth; receipts and dashboards are projections of it.

---

# 16. Implementation Priority

```text
1. TCLAW-0A v0/v1 + TCLAW-10A drift gate       (Epic 0 / 10)
2. TCLAW-0B role authz + task ownership        (Epic 0)   ← security fix
3. TCLAW-0C capability classifier, fail-closed (Epic 0)   ← security fix
4. TCLAW-0D/0E/0F tests + hygiene, CI v2       (Epic 0)
5. Route explanation extension                 (Epic 2)
6. Receipt projection + receipt page           (Epic 4)
7. Cost Control Center (+ session/daily caps)  (Epic 1)
8. Approval card v2 + approval history UI      (Epic 3)
9. Security posture dashboard v1               (Epic 9)
10. Wire skill generation + governed registry  (Epic 5)
11. Skill provenance + rollback                (Epic 5)
12. Channel policy manager                     (Epic 7)
13. Slack/Discord channel expansion            (Epic 7)
14. Skill import scanner/sandbox (local only)  (Epic 6)
15. Agent team board                           (Epic 8)
```

Items 1–3 are days of work each and remove the platform's only structural security gaps. Items 5–9 create immediate trust and user love. Items 10–15 create moat and expansion. Marketplace distribution is not on this list at all (§9.6.5).

---

# 17. Definition of Done

This PRD is complete when:

* CI runs the full test matrix on every change and fails on schema drift.
* A channel seat structurally cannot approve tools or skills.
* TORQCLAW shows why every task routed where it did.
* Every cloud run has visible budget state, including session/daily standing.
* Every terminal task has a queryable receipt materialized from the event log — and rebuildable from it, byte-identical.
* Every write-capable tool approval is auditable in the console.
* Skill generation fires under policy, and every generated/refined skill has provenance.
* Users can approve, reject, disable, or rollback skills — and rollback provably removes the artifact.
* Channels have scoped policies that clamp, never raise, request-supplied limits.
* Security posture is visible.
* Agent teams can operate with role scopes and review gates.
* No core safety invariant is weakened.

---

# 18. Product Positioning After Implementation

```text
TORQCLAW is the trust layer for self-improving agents.

It gives you Hermes-style learning, OpenClaw-style reach, and enterprise-grade governance:
local when private, cloud when needed, approval before action, budget before spend, and receipts after every run.
```

---

# 19. Final Recommendation

Repair the foundation first (CI, role authorization, capability classification — days, not weeks), then build **Visible Trust MVP**:

1. Route explanations
2. Run receipts
3. Cost Control Center
4. Approval Command Center
5. Security posture dashboard v1

Then build the compounding moat:

1. Wire + govern learning
2. Skill provenance and rollback
3. Channel policies
4. Skill sandbox/marketplace
5. Agent teams

This sequence gives users immediate confidence before expanding autonomy — and never ships a trust feature on top of an unverified base.

---

# Appendix A — Baseline Audit Evidence (2026-07-08)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | Router rule hierarchy, first-match-wins | ✅ | `packages/router/src/engine.ts:50-144` |
| 2 | Route reason object exists (`RouterDiagnostics`) | 🟡 thin | `packages/contracts/src/routing.ts:57-62`; emitted `packages/gateway/src/server.ts:107,153` |
| 3 | Two tiers only (`OLLAMA_LOCAL`/`API_EXTERNAL`) | ✅ | `packages/contracts/src/routing.ts:12-15` |
| 4 | Budget precedence: task → env → unlimited+warning | ✅ | `packages/gateway/src/dispatch.ts:36-40,120-127` |
| 5 | Circuit breaker cancels on breach, 2s poll, 30s heartbeat | ✅ | `packages/bridge/src/hermes.ts:6-7,78-100` |
| 6 | Spend chain: credits → account delta → null (never fake 0) | ✅ | `engines/hermes_kernel/mcp_wrapper/hermes_runner.py:95-117` |
| 7 | No pricing tables; no session/daily caps | ✅ confirmed absent | repo-wide grep |
| 8 | Breaker has unit tests | ❌ | none import `CircuitBreakerError`; only manual `ops/e2e-budget.mjs` |
| 9 | Approvals server-owned; client cannot inject grants | ✅ | `packages/contracts/src/commands.ts:36-40`; `packages/gateway/src/enrich.ts:33-35`; `tests/contracts-grants.test.ts` |
| 10 | Grants single-use; no TTL anywhere | ✅ / ❌ TTL | `packages/gateway/src/approvals.ts:45-74`, `dispatch.ts:80-94` |
| 11 | Approval history persisted (no API/UI) | 🟡 | `packages/gateway/db/schema.sql:101-110` |
| 12 | Write detection = name regex; path write-scope keyed to same flag | 🟡 bug | `packages/bridge/src/registry.ts:41,73,106-112`; `toolFilter.ts:60-62` |
| 13 | No default protected paths (.env/.ssh) | ❌ | `pathScope.ts` config-driven only |
| 14 | Receipts real-telemetry-only, persisted via events + telemetry_json | ✅ | `dispatch.ts:42-63,166`; `schema.sql:14-43` |
| 15 | Seq-cursor replay/resume | ✅ | `schema.sql:17-27`; `sessions.ts:41-52` |
| 16 | Blocked/cancelled/failed tasks excluded from memory | ✅ | `dispatch.ts:156-184` |
| 17 | Skill generation wired | ❌ | `draft_and_queue_skill` (`server.py:156`) has zero callers; `hermes_runner.py:235-237` disables memory/reflection |
| 18 | Skill approval + no-auto-deploy + edit/diff UI | ✅ | `skill_queue.py:54-82`; `TorqTerminal.tsx:573-674` |
| 19 | Skill rollback / provenance beyond source_task_id | ❌ | `skill_queue.py` |
| 20 | Python validates GatewayRequest only; ConnectFrame not emitted | 🟡 | `mcp_wrapper/contracts.py:21-27`; `scripts/emit-schemas.ts:13-19` |
| 21 | No schemaVersion / drift check / golden fixtures | ❌ | repo-wide grep |
| 22 | No CI | ❌ | no `.github/` at repo root |
| 23 | No Python tests | ❌ | no `test_*.py` outside vendor |
| 24 | Channel role not enforced as authorization | ❌ | gateway `server.ts` never branches on role |
| 25 | channel-http honest 202 on pending approval | ✅ | `packages/channel-http/src/server.ts:96-107` |
| 26 | No rate limiting anywhere | ❌ | confirmed absent |
| 27 | Loopback-first defaults, constant-time token compare | ✅ | gateway `server.ts:25-38`; channel-http `server.ts:22-47` |
| 28 | Cost attribution shared across concurrent tasks | 🟡 known | `hermes_runner.py:60-62` |
| 29 | Engine single-process constraint | 🟡 known | `mcp_wrapper/server.py:191-193` |
