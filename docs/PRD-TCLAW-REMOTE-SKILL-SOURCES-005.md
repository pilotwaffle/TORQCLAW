# PRD-TCLAW-REMOTE-SKILL-SOURCES-005 — Phase 4: Signed Remote Skill Sources

- Status: **DESIGN — v1.2, 2026-08-12. G1R round 2: PASS — three follow-ups (F-1..F-3) + implementation guardrails ACCEPTED and folded; review loop CLOSED. Last PRD revision before implementation. No frozen R-1..R-10 outcome reopened; no architecture change (all three are prose/scoping).** Canonical design contract for Phase 4 (signed remote skill sources). Supersedes, in detail, the Phase-4 sketch in `docs/PRD-TCLAW-RESILIENT-EXTENSIBILITY-001.md` §9.5 (L223-241), §13 Phase 4 (L402-405), §14 (L407-418), and the Phase-4-gated open question in §17 (L449). (§17 L450, Windows key storage, is gated "Before Phase 3", not Phase 4 — it is nonetheless resolved here, §13.) Where this PRD and the PRD-001 sketch disagree, this PRD wins; every deviation is recorded in §16 rather than silently absorbed.
- **Changelog v1.2** (G1R round-2, review loop closed): **F-1** audit-headroom check scoped to REMOTE transactions only — local flag-off path keeps `aa6057b` capacity behavior byte-for-byte; local `revert_activation` audit routed through `_append_audit` fail-closed (fixes O-9 silent-drop on the local path without changing timing) (R-9, §14.4, RS-7/SP-1, P4-6); **F-2** revocation-wins-over-pin precedence made normative (§5.3, §5.8); **F-3** remote-manifest seam two-disposition partition + reconcile-never-reaches-seam invariant pinned in prose (§6.3); **implementation guardrails** added as §18 (four build-fleet watch notes).
- **Changelog v1.1** (G1R round-1 rulings **O-1..O-21** addressed): O-1 bundle digest-pin map / anti-rollback (§5.2, §6.3, AC-16, DP-15, D-6); O-2 revocation-vs-active reporting (§6.5, AC-17, §14.6, D-1); O-3 DP-12..14 + SP-pins-as-tests statement (§10); O-4 SP-9 trust-lock leaf ordering (§8); O-5 fail-closed-when-unwired + constructor injection + DP-16 (§6.3); O-6 decide-seam trust facts + AC-18 (§7.2, R-10b); O-7 audit headroom as PRIMARY (R-9, §14.4); O-8 `artifacts/` durable-evidence runbook §14.5 + bounded `skill_trust/` reads (folds O-21); O-9 overflow log relocated outside `skill_trust/` (R-9); O-10 ticket restructure — stub wiring forbidden (§11); O-11 TCJSON escaping fix + bool-before-int (§5.1); O-12 guidance ordering + `retryAfter` (§5.8, §7.3); O-13 mapper exhaustiveness arm (§5.8); O-14 early `skill_id` validation (§6.1); O-15 manifest signature stub `"detached"` (§5.3, §13); O-16 persist-failure scoping (§5.6); O-17 REJECT cleanup + APPROVE-scoped edit refusal (§6.2); O-18 citation corrections (R-10b, §7.2, §7.3, header, P4-2); O-19 caller-distinction wording (§6.1, §7.1); O-20 `trustUnenforced` flag-off fact (§12); N-1..N-7 folded as one-liners where cited.
- Baseline: **`aa6057b`** (merge of C2 Approval Broker runtime). Every `file:line` reference in this document was verified against that tree.
- Feature flag: **`TORQCLAW_REMOTE_SKILL_SOURCES`**, read per-call via the `_TRUTHY` pattern (`governed_skills.py:112`, `governed_skills.py:127-133`), default **OFF**. Remote sources additionally require `TORQCLAW_GOVERNED_SKILLS=1`; the legacy skill path (`skill_queue.py:170-177`) is never reachable from a remote source. Flag-off behavior is byte-identical (SI-4 discipline; PRD-004 §1.2.1 constraint 4). **No migration, build, test, or release may change the default.**
- House-style ancestors: `docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004.md` (controlling invariants, frozen specs, per-ticket design, deletion probes, adversarial acceptance); `docs/PRD-TCLAW-TRUSTOS-002-v2.0.md` §12 (the unenforced-claim mandate this PRD is built around).

---

## 1. Decision and scope boundary

### 1.1 Decision

Add signed remote skill sources to the governed skill pipeline: the **kernel** fetches a publisher's two-file package over bounded HTTPS, **independently computes** its package digest, verifies an Ed25519 signature over that digest against an origin-scoped, operator-configured trust root with signed revocation bundles, and only then admits the package into the **existing** governed lifecycle (`skill_queue` pending → operator `decide_skill` → `ActivationCoordinator` install). The dormant TypeScript trust engine `packages/gateway/src/skillTrust.ts` is **deleted**; its *model* is ported to a new Python trust engine colocated with the install authority in `engines/hermes_kernel/mcp_wrapper/`.

### 1.2 The defect this PRD is built around

The program's recurring defect is the **unenforced claim**: a control that exists but is connected to nothing. Five confirmed instances; the last one standing is `skillTrust.ts` — 661 lines of Ed25519 verification, revocation, and quarantine with **zero production importers** (verified on `aa6057b`: the only importer is `tests/skill-trust.test.ts:15`). The repo admits it in prose: *"Nothing in TORQCLAW verifies a skill signature today"* (`README.md:205-206`), and records the module as dormant-by-declaration (`ops/reachability.mjs:61`).

`docs/PRD-TCLAW-TRUSTOS-002-v2.0.md:811-816` states the binding mandate:

> "Claiming skill signature verification on the strength of this file existing would be the same defect a fourth time. **P4-1 must gate on an *activation-path* test, not a unit test.**"

Therefore every control specified in this PRD carries three things, stated inline:

1. its **enforcement point** (the exact production seam that calls it),
2. its **activation-path test** (an observable end-to-end behavior, not a unit vector),
3. its **deletion probe** (the sabotage that must turn the suite RED — §10).

A control missing any of the three is a FREEZE blocker.

### 1.3 What already exists and is reused, not rebuilt

| Capability | Where it lives (verified) | This PRD's relationship to it |
|---|---|---|
| Digest-addressed package store, staged atomic activation, approval binding | `verified_skill_store.py` (`package_digest` L124-127; approval record L230-237; `activate` L249-352) | Reused verbatim; gains a real verification call at its policy seam (§6.3) |
| Governed install transaction (retain → publish → invalidate → commit → verify → finalize/restore) | `governed_skills.py:328-562` via `ActivationCoordinator` | Reused; remote packages enter it through a fetched-package install path (§6.2) |
| Rollback / disable, end to end | `governed_skills.py:565-753`, `756-961`; surface `skill_rollback.py` | Reused; rollback gains trust re-evaluation (§6.3) |
| Failure taxonomy, single mapper | `governed_skills.map_activation_failure` L1048-1112 | Extended, never forked (§5.8) |
| Queue + decision surface | `skill_queue.py:54-177`, `server.py:412-418` | Extended additively (§6.2) |
| Bounded read idiom | `_read_bounded` limit+1, `verified_skill_store.py:1206-1214` | Reused for HTTP streaming (§5.3) |
| Byte caps | `MAX_MANIFEST_BYTES` / `MAX_SKILL_BYTES` / `MAX_PACKAGE_BYTES`, `verified_skill_store.py:33-53` | Reused as the fetch bounds (§5.3) |
| Atomic persistence | `_atomic_write_json` L1317-1327 | Model for trust-store persistence (§5.6) |

### 1.4 Assumptions and lane dependencies

- **The authorization remediation (server-owned connection roles, production rejection of `TORQCLAW_GATEWAY_TOKEN`) is a SEPARATE, UNSHIPPED lane. This PRD does not depend on it landing and must not conflict with it.** Ground truth on `aa6057b`: `TORQCLAW_GATEWAY_TOKEN` is live (`ops/doctor.mjs:62`, `ops/bench.mjs:1465`, `.env.example:1`, `README.md:274,298`) and production does not reject it. Nothing in this PRD describes any behavior of that unshipped branch in the present tense.
- `TORQCLAW_GOVERNED_SKILLS` is live and merged; its default remains off in code (`README.md:190-193`). Remote sources layer strictly on top of governed mode.
- The collab C1/C2 surface-authority machinery (`authz.ts:214-235`) exists on `aa6057b` behind `TORQCLAW_COLLAB_ENABLED`; §7.1 extends one condition in it and is specified **against current master independently** — it does not inherit from, or wait on, any other lane.

---

## 2. Owner rulings (FROZEN — design within them; each recorded with rationale)

### R-1 — Verification locus: the kernel verifies; the TS engine is deleted

Signature verification runs in the **kernel** (Python), in `engines/hermes_kernel/mcp_wrapper/`, colocated with the install authority (`VerifiedSkillStore`, `governed_skills`). `packages/gateway/src/skillTrust.ts` (661 lines, zero production importers) is **deleted**, along with `tests/skill-trust.test.ts`. The dormant entry at `ops/reachability.mjs:61` is removed with a retirement comment in the L62-85 house style (the same style that records the skill pipeline's and collab's exits from `DORMANT`). The expectation at `tests/reachability.test.ts:87` is **inverted** (`toContain('skillTrust.ts')` → `not.toContain('skillTrust.ts')`), so reintroducing the dormant entry turns the suite red — the same inversion pattern already used at L90-98 for the wired skill pipeline. `README.md:201-206` is corrected.

*Rationale.* The process that installs must be the process that verifies. An IPC verdict is a claim, not proof — the exact failure mode `governed_skills._already_active_and_published` documents for the provenance sidecar (`governed_skills.py:281-291`: "a CLAIM, not proof... anything that can write into published_skills can make it lie", fixed by re-hashing the actual bytes). A gateway-side "verified: true" flag crossing the MCP boundary to a kernel that installs on faith would rebuild that defect at process scale. Deleting the TS engine also leaves exactly **one** canonicalization implementation in the repo (SP-4); two implementations of canonical JSON is a signature-forgery seam waiting for a divergence.

The Python engine ports the **model** of `skillTrust.ts`, not the lines: origin-scoped Ed25519 keys (`skillTrust.ts:80-85`), signed trust bundles with strictly monotonic `sequence`+`issuedAt` (L331-337), key and skill revocations including digest-optional skill revocation (L87-101, L399-405), freshness windows with future-skew bound (L594-609), clock-rollback quarantine that only a newer signed bundle clears (L284-289, L420-430), atomic tmp+rename persistence that fails closed on persist failure (L466-483), strict exact-keys parsers (L627-630), and canonical-JSON signing payloads (L16-56). Ed25519 arrives via the `cryptography` package, added as an **explicit** kernel dependency in `engines/hermes_kernel/pyproject.toml` (uv). Note: `cryptography` is already present *transitively* via `PyJWT[crypto]==2.13.0` (`pyproject.toml:26`); relying on a transitive extra for a security control is itself an unenforced claim, so the dependency is pinned explicitly.

Because the Python implementation becomes the single source of truth and the signing CLI must byte-match it, the canonical JSON form is specified normatively **in this PRD** (§5.1).

### R-2 — Fetch locus and bounds: the kernel fetches, before the lock

The kernel performs the fetch — the first outbound HTTP in the kernel. Constraints (each enforced, tested, probed):

- **HTTPS only.** `http://` source URLs are refused at config parse time and again at fetch time.
- **Redirects refused** (limit 0). Publishers configure final URLs. A redirect response is a fetch failure, not a follow.
- Connect and read **timeouts** (frozen defaults §5.3).
- **Bounded streaming download** using the `_read_bounded` limit+1 idiom (`verified_skill_store.py:1206-1214`): read `limit+1` bytes; more than `limit` ⇒ refuse. Caps reuse `MAX_MANIFEST_BYTES` / `MAX_SKILL_BYTES` / `MAX_PACKAGE_BYTES` (`verified_skill_store.py:33-53`).
- Fetch + verify + stage run **entirely before** the `ActivationCoordinator` — the same discipline `install_approved_skill` already applies to stage/approve ("stage + approve happen OUTSIDE the coordinator's lock", `governed_skills.py:360-370`). A network call inside `_MUTATION_LOCK` would stall all Hermes run admission, because `hermes_run_admission` fences run construction on the same lock (`runtime_quiescence.py:313-359`). This is structural property SP-3.
- **No archives, ever.** Packages remain exactly two files (`skill.json` + `SKILL.md`), fetched as one flat JSON envelope (§5.3). The repo deliberately has zero decompression surface; no zip/tar/gzip content-encoding is introduced.

*Rationale.* Fetching in the gateway and shipping bytes to the kernel would put a second copy of the bounds in a second language and make the kernel trust a transported artifact — R-1's IPC-claim problem restated for content instead of verdicts.

### R-3 — Digest binding: the signed digest IS the computed package digest

The digest a publisher signs is the kernel package digest: `sha256(manifest_bytes + b"\x00" + skill_bytes)` (`package_digest`, `verified_skill_store.py:124-127`), in **raw lowercase hex** (64 chars, no prefix). The verifier computes this digest **independently from the fetched bytes, before any signature evaluation**; a signature whose `digest` field does not equal the computed digest is refused with reason `digest-mismatch` — regardless of whether the signature over that (wrong) digest would verify.

The `sha256:`-prefix ambiguity is resolved normatively: package digests are raw hex because they are also directory names; per-file digests inside the manifest (`files["SKILL.md"]`) keep the `sha256:` prefix — exactly the split `_normalize_digest` documents (`verified_skill_store.py:1170-1179`). The signed envelope's `digest` field MUST be raw hex; a prefixed value is an `invalid-schema` refusal, never silently normalized.

*Rationale.* This closes the caller-supplied-digest trap: `skillTrust.ts:122-123` signed and evaluated "a caller-supplied content digest" it never computed — a verifier of that design attests to whatever digest the caller claims, binding the signature to nothing on disk.

### R-4 — No admission seam: enforce at the decision seam that already exists

No new "admission" call is added to the install path. The kernel approval token already binds `skillId`+`digest`+permissions (`verified_skill_store.py:230-237`, checked at L943-973), and the coordinator transaction already has exactly one commit seam. Adding an unreached admission call would repeat the `refuseFrontier` dead-code defect — the C2 build's G2A D-2 finding, preserved as a warning in `grantAdmission.ts:110-115`: the refusal existed but the path never called it, so the tier was "unwired-and-OPEN".

Instead, the **existing** policy seam becomes real: `_enforce_activation_policy` (`verified_skill_store.py:1140-1153`) is today a metadata-shape check (profile compatibility; for `http(s)` sources: HTTPS + Ed25519 *metadata shape*). It is converted into a **real verification call**: for remote-sourced manifests it performs full trust evaluation — bundle freshness, key trust, key/skill revocation, and signature verification over the freshly computed package digest (§6.3).

`aa6057b` correction to the planning brief: `rollback()` **already calls** `_enforce_activation_policy` (`verified_skill_store.py:509`), alongside `activate()` (L279). So no missing call has to be added — but the call is currently vacuous for trust purposes. What rollback genuinely lacks is any signer context: converting the seam therefore requires R-6's persisted signer identity, and the normative consequence stands: **a version signed by a since-revoked key is rollback-INELIGIBLE** (`SKILL_TRUST_REVOKED_KEY`), evaluated inside `rollback()` at the same seam, on every rollback of a remote-sourced version.

### R-5 — Config and flag: TORQCLAW-owned file, per-call flag, doctor preflight

- Source configuration lives in **`$TORQCLAW_DATA_DIR/skill_sources.json`** (§5.5): origins, source base URLs, and origin-scoped **trusted authority PUBLIC keys**. Public keys only — this repository is public, and the trust model is asymmetric-key by design: nothing in the config, the repo, or the environment may constitute a secret. (Secondary note: this also stays forward-compatible with the pending authorization-remediation lane's no-new-static-secrets direction, without depending on it — §1.4.)
- Strict exact-keys parser, bounded size (§5.5). Parse failure ⇒ remote sources are entirely unavailable (`SKILL_REMOTE_CONFIG_INVALID`), never partially available.
- Gated by **`TORQCLAW_REMOTE_SKILL_SOURCES`**, default OFF, read **per-call** via the `_TRUTHY` pattern (`governed_skills.py:112, 127-133`) — never captured at import (the stale-`dist`/import-capture trap, `docs/prd-reviews/PRD-TCLAW-COLLAB-GATEWAY-004.md` §1.3).
- Remote sources additionally require `TORQCLAW_GOVERNED_SKILLS=1`. Remote never touches the legacy path (`skill_queue.py:170-177`).
- **NEVER `config.yaml`.** It is upstream-owned, TORQCLAW never parses it, and it carries the mtime-keyed negative-lookup staleness class documented at `skill_publisher.py:61-100` (a negative cached against config mtime "would never naturally expire for the life of the process").
- Trust-store persistence at **`$TORQCLAW_DATA_DIR/skill_trust/`** (§5.6): atomic writes, fail closed on persist failure (model: `skillTrust.ts:466-483`, `_atomic_write_json` `verified_skill_store.py:1317-1327`).
- `doctor` gains a **conditional preflight** in the existing live-gating idiom (`ops/doctor-core.mjs:131` gates on env; conditional block shape at L176-183): when `TORQCLAW_REMOTE_SKILL_SOURCES` is truthy, `skill_sources.json` must parse, every configured authority `publicKey` must parse as a valid Ed25519 SPKI public key (N-4), and `$TORQCLAW_DATA_DIR/skill_trust/` must be writable; any failure is a red `preflight.remote-skill-sources` record. When the flag is off, the check is absent (not a pass — absent), preserving flag-off output identity.

### R-6 — Signer persistence: additive optional state.json fields

`state.json` gains **additive, optional** fields; `schemaVersion` stays `1` (`_empty_state`, `verified_skill_store.py:1016-1017`); no migration machinery is invented:

- `installed[skillId][digest]` (written by `_installed_record`, L1035-1043) gains `{"origin": <str>, "keyId": <str>}` for remote installs. Absent for local installs. The state validator (`_load_state` L922-936) is updated to tolerate-and-validate: absent is legal; present-but-malformed is a `SkillRecoveryError`.
- Audit rows for remote installs (`_append_audit`, L992-1013) carry `origin` and `keyId`.

*Rationale.* This is what makes R-4's revocation-driven rollback-ineligibility implementable — at rollback time the store must know *which origin's* trust state and *which key* to evaluate for a years-old installed digest — and what makes future revocation-driven quarantine of installed versions possible without guessing.

### R-7 — Capability pilot restriction: nothing beyond `["read"]`

A remote skill whose manifest `requiredCapabilities` is not a subset of `["read"]` is **REFUSED at verification time** — fail closed, own reason `capability-unsupported`, own operator code `SKILL_TRUST_CAPABILITY_UNSUPPORTED` (§5.8).

*Rationale.* The local install path fixes capabilities at `["read"]` by construction (`_build_package`, `governed_skills.py:254`) and then auto-confirms the permission delta on that basis: `store.approve(staged, confirm_permission_delta=True)` at `governed_skills.py:387`, justified by the comment at L384-386 — "The capability set is fixed at ["read"] by _build_package, so there is no hidden escalation being waved through here." A remote manifest is **publisher-authored**: without this restriction, a manifest declaring `["read","exec"]` would launder a capability escalation straight through that auto-confirm. This is an explicit **pilot bound** with a stated lift condition: it is removed only by a future capability-delta approval UX phase that puts the delta in front of the operator instead of auto-confirming it.

### R-8 — Revocation freshness: refresh-on-use; background refresher deferred

- **Refresh-on-use:** the origin's trust bundle must be within its freshness window at fetch/verify time AND is **re-checked at every activation and rollback decision time** (§6.3). Stale ⇒ refuse with `SKILL_TRUST_STALE`, retryable-after-refresh (the remedy is `refresh_skill_trust`, §6.5, then retry).
- **Hard expiry:** a bundle is usable only while `now ≤ min(signed nextUpdate, acceptedAt + 72h)` — the earlier of the publisher's own signed horizon and 72 hours after verified acceptance, matching PRD-001 §9.5's outer bound (L230). `acceptedAt` is persisted in the trust store at acceptance.
- A **periodic background refresher is explicitly DEFERRED**: the kernel has no scheduler, and inventing one for this feature would be silent scope expansion. This deviates from PRD-001 §9.5's "refreshed ... at least every 24 hours while enabled" (L230). Recorded honestly in §16 with the consequence stated: **a revoked key is discovered at the next governed operation (install / activate / rollback / explicit refresh), not within 24 hours.** Operators who need a tighter bound run `refresh_skill_trust` on their own schedule; the runbook (§14) says so.

### R-9 — Trust audit separation: a dedicated bounded log, never state.json

Trust, refresh, and quarantine events go to a **new dedicated append-only bounded log** under `$TORQCLAW_DATA_DIR/skill_trust/` (§5.6): size-rotated, retaining N archives — **NOT** into `state.json`'s `audit[]`. That array has a 1,000-entry fail-closed cap (`MAX_AUDIT_ENTRIES` `verified_skill_store.py:53`; `_append_audit` L992-1013 raises `SkillAuditCapacityError` at capacity): routing remote-source event volume (every fetch, every freshness check, every refusal) into it would exhaust the cap and **DoS the entire governed pipeline**, since every governed mutation appends before it can commit.

Install/activate/rollback/disable audit rows continue in `state.json` unchanged.

**Fix in passing (in scope, own tests):** `revert_activation`'s inline audit write (`verified_skill_store.py:430-437`) bypasses `_append_audit`'s capacity check — `if isinstance(audit, list) and len(audit) < MAX_AUDIT_ENTRIES: audit.append(...)` **silently drops the record at capacity**, contradicting the fail-closed capacity ruling every other writer obeys. Two aligned fixes (F-1), deliberately kept on separate scopes so the local path is untouched in timing:

- **Audit headroom — REMOTE transactions only (O-7 as revised by F-1).** A REMOTE install/rollback transaction requires headroom up front — before the coordinator transaction begins (checked outside the lock, re-checked under it), `len(audit) ≤ MAX_AUDIT_ENTRIES − 2` (room for the action row AND a potential revert row); otherwise it fails closed with `SkillAuditCapacityError` **before any mutation**. This check is **gated behind the remote flag and applies only to remote transactions**. Rationale (F-1, recorded): an *unconditional* headroom check would refuse the purely-local path earlier than `aa6057b` — at `audit ∈ {999, 1000}` instead of only at `1000` in `_append_audit` — and a fixed-transcript AC-7/SP-1 test would never catch it (the transcript never reaches 999 audit rows), so it would be a real RS-7 violation hiding behind green tests. Remote-scoping the check keeps the local path's capacity timing byte-for-byte.
- **Local revert routes through `_append_audit` (fail-closed), REQUIRED PAIRING.** The O-9 silent-drop bug is still fixed on the local path — but by routing `revert_activation`'s audit write through `_append_audit` (which raises `SkillAuditCapacityError` at capacity) instead of the current silent `len < MAX` append. This touches **only the revert/restore arm, never the success path**, so local *success* behavior stays byte-identical to `aa6057b` (a local success at `audit == 999` still appends and commits exactly as before; the headroom check above never runs on the local path). A local revert at capacity now fails closed rather than dropping — which is the fail-closed direction P2-1h mandates, and is not reachable on the fixed flag-off transcript.

Defense-in-depth (remote path only, last resort, unreachable once the remote headroom check exists): if `SkillAuditCapacityError` nonetheless fires inside a *remote* transaction's revert, the revert still commits (a restore path must not strand a failed activation as governed-active over an audit row), the dropped record is written to **`$TORQCLAW_DATA_DIR/skill_audit_overflow.log`** — O-9: deliberately OUTSIDE `skill_trust/` and flag-independent — and the result carries `"auditOverflow": true`. That key firing is a red-flag signal that the remote headroom check was bypassed (file a defect), not a routine arm. The overflow-log diversion exists for the remote path only; the local path fails closed outright (previous bullet), never diverts.

### R-10 — Gateway scope: minimal, three items

**(a) `APPROVE_SKILL` joins the approve-authority gate.** On `aa6057b`, `authorizeOperator` gates only `APPROVE_TOOL` on the surface's live `approve` authority (`authz.ts:220-232`); `APPROVE_SKILL` falls through to the blanket `return ALLOW` at `authz.ts:234`. The condition at L220 is extended to cover `APPROVE_SKILL` — specified here **against current master, independently**; it inherits nothing from any other lane. A kernel-side note is added at the decision seam (`skill_queue.decide` docstring) stating that the deeper, writer-level re-check lives with the kernel (approval-token digest binding + activation-time trust evaluation), so the gateway gate is a surface gate, not the enforcement of record. Lockout consideration: the surrounding comment (`authz.ts:201-204`) warns that inventing authority gates for unspecified commands is "scope drift with real lockout risk" — this PRD *is* the specification for this one command, and the lockout surface is identical to `APPROVE_TOOL`'s: an operator surface without a live `approve` grant loses skill approval **only when `ctx.surface` is present** (collab flag on + C1 surface). Flag-off / legacy connections keep today's blanket allow byte-identically (`authz.ts:217-218`) — the no-change guarantee.

**(b) Trust facts on the approval card.** The `PENDING_APPROVAL` event metadata for a remote skill carries `{sourceOrigin, keyId, digest, verificationStatus}` so `SkillApprovalCard` (`apps/console/src/components/TorqTerminal.tsx:1054-1155`) can render them next to the existing name/draft facts. (Citation corrected per O-18: the skill card's own docblock is `TorqTerminal.tsx:1051-1053`, and today the card renders only the skill name; the "ONLY facts the system knows" rule at L1048-1050 belongs to the P2 *tool* card — the trust-facts addition **adopts** that discipline rather than inheriting it.) The full `SKILL.md` body stays behind the existing `GET_SKILL_DRAFT` fetch path (`server.py:421-424`; ≤8KB drafts ride along per `server.py:403-404`) rather than joining a card frame. The bridge already forwards skill-shaped `PENDING_APPROVAL` events untouched — it suppresses only tool-approval events carrying `toolName` (`packages/bridge/src/hermes.ts:142-146`) — so no bridge change is needed. Execution addition within this ruling (O-6): because in the pilot flow a card exists only when `source_task_id` was supplied, the **decide seam** (`get_skill_draft`) also returns the same trust facts — §7.2, AC-18; the card is the console-phase consumer of the metadata, never the sole surface.

**(c) Guidance strings.** `skillDecision.ts:22-62` gains guidance strings for the new error codes (§5.8), in its existing style: name the next action, not just the failure class (L34-41).

**Owed, recorded:** gateway-side skill-approval history/persistence is explicitly out of scope; `ApprovalHistoryPanel.tsx:191` currently prints "Tool approvals only — skill approvals are not shown in this history." That remains true after this phase and is owed to a later console phase, together with console-native remote-install initiation (§6.1 note).

---

## 3. Controlling invariants (normative)

- **RS-1 (verify-before-trust, kernel-local).** No remote byte reaches `VerifiedSkillStore.stage()` until the kernel has, in-process: computed the package digest from the fetched bytes (R-3), evaluated the signature against a fresh, unrevoked, origin-scoped key from an accepted trust bundle (R-1), and checked the capability bound (R-7). A verdict computed anywhere else — another process, a sidecar file, a queue-row claim — is not a verdict (SP-7).
- **RS-2 (re-verify at decision seams).** Trust is re-evaluated from current trust state at *every* activation and rollback of a remote-sourced version, at `_enforce_activation_policy` (R-4, §6.3). Install-time verification never grandfathers a later activation past a newer revocation or a stale bundle.
- **RS-3 (digest is the only content identity).** Approval, activation, rollback, idempotency-reconciliation, and revocation all bind to the computed package digest. No name-based or version-based identity exists anywhere in the remote path (versions are display metadata; the store's own `list_versions` already documents that governed versions carry a fixed manifest version, `verified_skill_store.py:640-642`).
- **RS-4 (no network under the mutation lock).** Fetch and trust-bundle refresh complete before `ActivationCoordinator.run()` acquires `_MUTATION_LOCK`. The re-verification inside the lock (§6.3) reads only local trust state — it never fetches. If local state is stale, it refuses (`SKILL_TRUST_STALE`); the retry path is: release, refresh, re-decide.
- **RS-5 (fail closed, everywhere, with a typed reason).** Every trust failure — parse, bound, signature, freshness, monotonicity, revocation, clock, persistence — refuses the governed operation with a typed reason from the §5.8 registry. There is no "warn and proceed" arm and no partial acceptance of a bundle or package.
- **RS-6 (one decision writer).** `skill_queue.decide()` remains the only writer that flips a queue row out of `pending` (`skill_queue.py:92-93` guard; governed flip-after-success at L146-149). `install_remote_skill` writes only new `pending` rows.
- **RS-7 (flag-off identity — unqualified).** With `TORQCLAW_REMOTE_SKILL_SOURCES` unset: no new file is read or written, no new tool succeeds (new tools refuse with `SKILL_REMOTE_SOURCES_DISABLED`), doctor output is byte-identical, and a fixed local install/decide/rollback transcript is byte-identical to `aa6057b` behavior. This holds **with no carve-out** (F-1): the audit-headroom check is remote-transaction-scoped, so it never fires on the local path; the local `revert_activation` fix changes only the failure/restore arm (fail-closed instead of silent-drop), never the success path, and is unreachable on the fixed transcript. There is no earlier-refusal boundary and no result-shape change on the flag-off path.

---

## 4. What "remote-sourced" means (normative predicate)

A package is **remote-sourced** iff its manifest `source` begins with `https://` — the predicate `_enforce_activation_policy` already keys on (`verified_skill_store.py:1147-1148`). Local operator-approved packages keep `source: "torqclaw:operator-approval"` (`governed_skills.py:252`) and are untouched by every rule in this PRD. The fetched manifest's `source` MUST equal the exact URL the envelope was fetched from (§5.3); a mismatch is `invalid-schema`. `http://` remains refused (existing L1150-1151 behavior, kept).

---

## 5. Frozen specifications

### 5.1 Canonical JSON — `TCJSON_V1` (normative; single implementation)

The byte form signed by publishers and verified by the kernel. Ported from `canonicalizeSignedPayload` (`skillTrust.ts:16-56`) with one recorded tightening (D-2, §16). The Python implementation in the trust engine is the **single source of truth**; the signing CLI (§13) MUST import that function, never re-implement it (SP-4).

1. **Encoding:** UTF-8, no BOM, no insignificant whitespace (separators `,` and `:`).
2. **Objects:** keys sorted lexicographically by Unicode code point; duplicate keys rejected at parse (`_reject_duplicate_keys` discipline, `verified_skill_store.py:1197-1203`). Only plain JSON objects — in Python terms only `dict` — are serializable.
3. **Arrays:** order preserved.
4. **Strings:** JSON string serialization with minimal escaping: `"` and `\` escaped; control chars use the two-char escapes JSON defines (`\n` `\t` `\r` `\b` `\f`); all other controls as `\u00XX`; non-ASCII characters raw UTF-8, never `\u`-escaped — exactly Python `json.dumps(ensure_ascii=False)` semantics, which byte-matches `JSON.stringify` for these inputs (O-11).
5. **Numbers:** integers only, `|n| ≤ 2^53 − 1`, serialized without decimal point, exponent, or leading zeros; `-0` serializes as `0`. **Non-integer numbers are rejected.** (Tightening vs the TS model, which admitted finite floats via `JSON.stringify` — ES shortest-round-trip float formatting is not natively reproducible in Python, and every field actually signed — `sequence`, `version` — is an integer. Recorded as D-2.) Normative implementation note (O-11): the canonicalizer MUST type-check `bool` **before** `int` — Python `bool` is an `int` subclass, and `True` must serialize as `true`, never `1`; a Phase-0 vector pins this.
6. **Booleans/null:** `true` / `false` / `null`.
7. **Rejected:** any non-JSON-plain value, `NaN`/`Infinity`, floats, objects with non-string keys, nesting depth > **64** (`MAX_CANONICAL_DEPTH`, port of `skillTrust.ts:20`).
8. **Size bound:** canonical payload ≤ **256 KiB** (`DEFAULT_MAX_CANONICAL_PAYLOAD_BYTES` port, `skillTrust.ts:199`); larger ⇒ `payload-too-large`.

Signature primitive: Ed25519 (RFC 8032) over the UTF-8 bytes of the canonical form; signatures encoded as unpadded base64url, decoded length exactly 64 bytes; public keys are DER SubjectPublicKeyInfo, unpadded base64url (ports of `skillTrust.ts:58-78, 203-217, 615-620`; base64url must round-trip canonically — non-canonical encodings rejected).

Phase-0 vectors (ticket P4-1): positive and negative vectors covering Unicode (astral, NFC/NFD distinct inputs are distinct bytes — no normalization), key-order, empty object/array, depth-cap, float rejection, big-int rejection, duplicate-key rejection, `-0`.

### 5.2 Trust bundle — `TRUST_BUNDLE_V1`

Schema is the `SignedTrustBundle` model (`skillTrust.ts:103-116`), strict exact keys:

```json
{
  "version": 1,
  "origin": "<https origin, e.g. https://skills.example.com>",
  "sequence": 7,
  "issuedAt": "2026-08-12T00:00:00.000Z",
  "nextUpdate": "2026-08-13T00:00:00.000Z",
  "trustedKeys": [ { "origin": "<same origin>", "keyId": "<id>", "publicKey": "<spki-der-b64url>" } ],
  "revocations": [
    { "kind": "key",   "keyId": "<id>", "revokedAt": "<iso>", "reason": "<opt>" },
    { "kind": "skill", "skillId": "<id>", "digest": "<opt raw hex>", "revokedAt": "<iso>", "reason": "<opt>" }
  ],
  "skills": { "<skillId>": "<raw hex digest>" },
  "signingKeyId": "<authority key id>",
  "signature": "<b64url over TCJSON_V1 of everything except `signature`>"
}
```

**Digest-pin map (O-1 — pinned upgrades / anti-rollback, delivers PRD-001 §13 L404).** `skills` is an OPTIONAL top-level key (the exact-keys parser admits it as optional): ≤ 2048 entries, ids `_ID_RE`-shaped, values raw lowercase hex. Normative rule: when the accepted bundle carries a pin for a `skillId`, `install_remote_skill` AND the §6.3 activation/rollback seam **REFUSE** any envelope or installed version of that skill whose computed digest ≠ the pinned digest — reason `digest-not-current` (§5.8, maps to `SKILL_TRUST_REFUSED`, non-retryable). Because bundles are strictly monotonic (sequence + issuedAt), the pin is monotonic too: a publisher advancing the pin makes every older digest permanently refusable — anti-rollback for free. Pin absent for a `skillId` ⇒ no pin enforced for it (current behavior). AC-16 / DP-15 gate this.

Acceptance rules (ports, each with the TS source line for the model): signed by an **operator-configured authority key for that exact origin** (`skill_sources.json`, §5.5 — the analog of `TrustStoreOptions.trustedAuthorities`, `skillTrust.ts:129-130`); every `trustedKeys[].origin` equals the bundle origin (L547 — cross-origin key smuggling is `origin-mismatch`); `sequence` strictly increasing AND `issuedAt` strictly increasing vs the currently accepted bundle for that origin (L331-337); freshness: `issuedAt < nextUpdate`, `nextUpdate − issuedAt ≤ 24h` (`invalid-freshness`), `issuedAt ≤ now + 2min` skew (`future-issued`), `now ≤ nextUpdate` (`stale`), `now ≥ issuedAt − 2min` (`trust-not-yet-valid`) (L594-609); bounds `maxTrustedKeys=256`, `maxRevocations=2048` (L200-201); timestamps strict ISO-8601 UTC milliseconds (L636-641). Replaying the currently accepted bundle is `sequence-not-monotonic` — which is precisely why quarantine recovery requires a strictly newer bundle.

Bundle location: `<sourceBaseUrl>/trust-bundle.json` (frozen path suffix), fetched under §5.3 bounds with cap 256 KiB.

### 5.3 Remote package envelope — `REMOTE_PKG_V1` (the no-archive fetch format)

One flat JSON document per skill — a single bounded fetch, so the two package files cannot diverge across separate requests:

```json
{
  "formatVersion": 1,
  "origin": "<https origin>",
  "skillId": "<store-safe id>",
  "keyId": "<publisher key id from the origin's bundle>",
  "digest": "<raw lowercase hex sha256(manifestBytes + 0x00 + skillBytes)>",
  "manifestBytes": "<b64url of the exact skill.json bytes>",
  "skillBytes": "<b64url of the exact SKILL.md bytes>",
  "signature": "<b64url Ed25519 over TCJSON_V1 of {digest, keyId, origin, skillId}>"
}
```

- The signed payload is exactly `{digest, keyId, origin, skillId}` — the `SignedSkillArtifact` identity model (`skillTrust.ts:118-126, 584-592`) minus the free-form `payload` member: the *content* is bound through `digest` alone (R-3), so signing the (potentially large) bytes again would add nothing and reintroduce canonical-form questions for binary content.
- The signature is inherently **detached** from the package bytes: it cannot live inside `skill.json` because a self-referential signature would change the manifest bytes and therefore the digest it signs. The in-manifest `signature` field the store already parses (`verified_skill_store.py:1130-1136`) is retained as a shape requirement for remote manifests (existing `_enforce_activation_policy` L1152-1153 behavior) and MUST carry the same `keyId` as the envelope — a cross-check, not a second cryptographic object. Its stub form is frozen (O-15): `{"algorithm": "Ed25519", "keyId": "<envelope keyId>", "value": "detached"}` — the fixed placeholder string `"detached"` is present in `skill.json` **before** digest computation (the manifest bytes are hashed with the stub in place); the verifier checks `keyId` equality and `algorithm == "Ed25519"` only and explicitly ignores `value`.
- Fetch location: `<sourceBaseUrl>/skills/<skillId>.json` (frozen path shape). Envelope cap: **2 MiB** (`MAX_PACKAGE_BYTES` reuse — base64 of a maximal package is ~768 KiB plus framing, so the cap dominates). Decoded `manifestBytes` ≤ `MAX_MANIFEST_BYTES` (64 KiB), decoded `skillBytes` ≤ `MAX_SKILL_BYTES` (512 KiB), sum ≤ `MAX_PACKAGE_BYTES` — the store re-enforces all three at stage anyway (`_read_package`, L1069-1084), by design redundantly.
- Timeouts (frozen defaults, operator-overridable in §5.5 per source): connect 10 s, read 30 s. Redirects: refused (R-2). TLS verification: system trust store, never disabled.
- Verification order (normative, each step fail-closed before the next): parse envelope (exact keys, bounds) → decode bytes → **compute digest from decoded bytes** → compare to envelope `digest` (`digest-mismatch` on inequality) → load origin trust state; freshness check → key lookup (`untrusted-key` / `origin-mismatch` / `revoked-key`) → verify signature over `{digest, keyId, origin, skillId}` (`signature-invalid`) → skill revocation scan, digest-optional (`revoked-skill`) → bundle digest-pin check when the accepted bundle pins this `skillId` (`digest-not-current` on mismatch, O-1) → parse manifest via the store's own `_parse_manifest` rules; check `source` == fetch URL, id == envelope `skillId`, in-manifest `signature.keyId` == envelope `keyId` → capability bound (R-7).
- **Revocation wins over the pin (F-2, normative).** The revocation scan runs BEFORE the pin check (order above), so a digest that is BOTH pinned-mismatched and revoked refuses with `revoked-skill` → `SKILL_TRUST_REVOKED_SKILL`, never `digest-not-current`. This gives the O-13 mapper-exhaustiveness test a deterministic expected code for the overlap case. (The inverse concern — un-pinning a skill in a newer bundle — is already safe: monotonic acceptance means a newer bundle governs, and dropping a pin simply stops enforcing `digest-not-current` for that skill; no separate rule needed.)

### 5.4 Digest binding

As R-3. Additionally: after `stage()` the staged artifact's digest (recomputed by the store from the staged bytes, `verified_skill_store.py:172-175`) MUST equal the verified envelope digest; inequality aborts the install (`SkillIntegrityError` — this is the TOCTOU tripwire, AC-2). At activation, `_install_version` recomputes again (L885-887). Tampering with staged bytes between verify and activate is caught by recompute, never by re-trusting the earlier verdict.

### 5.5 `skill_sources.json` (strict, bounded, public-key-only)

```json
{
  "schemaVersion": 1,
  "sources": {
    "<sourceId>": {
      "origin": "https://skills.example.com",
      "baseUrl": "https://skills.example.com/torqclaw",
      "authorities": [ { "keyId": "<id>", "publicKey": "<spki-der-b64url>" } ],
      "connectTimeoutMs": 10000,
      "readTimeoutMs": 30000
    }
  }
}
```

- Exact-keys at every level (timeouts optional with the frozen defaults); unknown key ⇒ `SKILL_REMOTE_CONFIG_INVALID`. File cap 256 KiB, read via `_read_bounded`. `sourceId` must match the store's id regex discipline (`_ID_RE` shape, `verified_skill_store.py:61`). `baseUrl` must be `https://` and must be within `origin`. ≤ 16 sources, ≤ 8 authority keys per source (bounds prevent unbounded key fan-out).
- Contains **public keys only**. A linter/doctor check refuses any value that parses as a private key PEM/DER.
- Read per call (like the flag) — never cached across calls; the file is small and the negative-cache staleness class (§R-5 rationale) is thereby structurally impossible.
- SSRF posture, decided (N-1): every fetch target derives exclusively from operator-configured URLs in this file — never from model output, publisher content, or any request parameter — over HTTPS with system trust, hostname verification, and redirect refusal. No private-IP ban is imposed, deliberately: it would be wrong here, since the P4-9 pilot fixture is loopback HTTPS by design.

### 5.6 Trust-store persistence — `$TORQCLAW_DATA_DIR/skill_trust/`

```
skill_trust/
  bundles/<sourceId>.json     accepted signed bundle + {acceptedAt} (verbatim bundle retained so it can be re-verified on load)
  clock.json                  { schemaVersion: 1, lastObservedNowMs, clockRollbackDetected }
  artifacts/<skillId>/<digest>.json   the verified REMOTE_PKG_V1 signature envelope (identity fields only, not the bytes)
  events.log, events.log.1..N        R-9 operational log (see below)
```

- All writes atomic (tmp + `os.replace`, `_atomic_write_json` model). **Persist failure fails the in-flight operation closed and quarantines** — scoped (O-16): a `clock.json` persist failure quarantines **ALL origins** (clock state is global evidence); a `bundles/<sourceId>.json` persist failure quarantines **that origin only**. Either way, the port of `skillTrust.ts:478-482` holds: "Persistence failure must never turn a verified request into an unverified success."
- On load, a persisted bundle is **re-verified** (signature + schema) against the current `skill_sources.json` authorities before use, AND the persisted bundle's `origin` must equal the current configured origin for that `sourceId` (N-3 — a config edit that repoints a `sourceId` cannot inherit another origin's accepted bundle). Corrupt or unverifiable persisted state fails closed into quarantine, recoverable only by a strictly newer accepted bundle (port of L441-464).
- ALL `skill_trust/` loads — not just the fetch path — use bounded, reparse-guarded reads (the `_read_bounded` / `_load_bounded_json` discipline, `verified_skill_store.py:1206-1222`) (O-8, folding O-21).
- `artifacts/` is what makes R-4/RS-2 implementable: activation/rollback re-verification needs the original signature to re-verify against current trust state. Missing/corrupt artifact record for a remote-sourced version ⇒ refuse (`SKILL_TRUST_REFUSED`, reason `artifact-record-missing`). **`artifacts/` is DURABLE EVIDENCE, not a cache** — see §14.5 for the backup/loss/recovery contract (O-8).
- Clock discipline: within-process monotonic observation (`observeClock` port, L420-430); across restarts, persisted `lastObservedNowMs` with an allowed wall regression of **5 minutes** (PRD-001 §9.5 L231); beyond that ⇒ clock-rollback quarantine for all origins; recovery ONLY via a strictly newer signed bundle per origin (`resetAfterClockRepair` returns false by design — L284-289; "a clock repair is not cryptographic evidence").
- `events.log`: append-only JSON-lines; rotated at 1 MiB; retain 4 archives; records bundle acceptance/refusal (with reason), refresh attempts, quarantine entry/exit, per-operation trust verdicts, and O-2 revocation-vs-installed reports. Never read by any control path — observability only. (R-9's `state-audit-at-capacity` overflow records live in `$TORQCLAW_DATA_DIR/skill_audit_overflow.log`, outside this tree — O-9.) Rotation assumes a **single writer in a single kernel process** (N-5) — the same one-process assumption the server already documents (`server.py:462-464`); no cross-process rename coordination is claimed on Windows.

### 5.7 `state.json` additive fields

As R-6. Shape (validator-tolerated, never required):

```json
"installed": { "<skillId>": { "<digest>": { "...existing...": "...", "origin": "https://skills.example.com", "keyId": "pub-2026-01" } } }
```

`skill_queue` gains one additive nullable column via a `PRAGMA table_info`-guarded `ALTER TABLE` (the `storage.ts:107-111` precedent cited in PRD-004 §1.3, applied in Python — `CREATE TABLE IF NOT EXISTS` at `skill_queue.py:17-25` never re-runs on an existing DB):

```sql
ALTER TABLE skill_queue ADD COLUMN remote_json TEXT NULL;
-- {"sourceId","origin","keyId","digest","stageId","verifiedAt"} for remote rows; NULL for every local row
```

Legacy rows are untouched; `NULL` means "local row, exactly today's semantics."

### 5.8 Error taxonomy extension (single mapper; frozen registry)

`governed_skills.map_activation_failure` (`governed_skills.py:1048-1112`) remains the **single source of truth** — the new codes are new arms in it, never a parallel dictionary (the rule PRD-004 §9.1 already binds surfaces to). The trust engine raises one typed exception, `SkillTrustError(reason=...)`, whose `reason` comes from the frozen registry below: the 18-reason set ported verbatim from `skillTrust.ts:142-160`, plus `digest-mismatch`, `capability-unsupported`, `digest-not-current` (O-1), `trust-engine-unavailable` (O-5), and the persistence reason `artifact-record-missing`.

| Trust reason(s) | Operator code | Retryable | Semantics |
|---|---|---|---|
| `stale` | `SKILL_TRUST_STALE` | **retryable-after-refresh** | Bundle outside freshness window; run `refresh_skill_trust`, then retry the operation |
| `revoked-key` | `SKILL_TRUST_REVOKED_KEY` | no | Signer key revoked; version is install- and rollback-ineligible |
| `revoked-skill` | `SKILL_TRUST_REVOKED_SKILL` | no | Skill (or exact digest) revoked by publisher |
| `clock-rollback`, `clock-unavailable` | `SKILL_TRUST_CLOCK_ROLLBACK` | no | Quarantined; operator runbook §14.1 — recovery requires a strictly newer signed bundle |
| `capability-unsupported` | `SKILL_TRUST_CAPABILITY_UNSUPPORTED` | no | R-7 pilot bound; lift condition is the capability-delta UX phase |
| `signature-invalid`, `digest-mismatch`, `digest-not-current`, `trust-engine-unavailable`, `invalid-schema`, `payload-too-large`, `origin-mismatch`, `unknown-authority-key`, `unknown-origin`, `untrusted-key`, `invalid-key`, `invalid-freshness`, `future-issued`, `trust-not-yet-valid`, `sequence-not-monotonic`, `issued-at-not-monotonic`, `artifact-record-missing` | `SKILL_TRUST_REFUSED` | no | Cryptographic/structural refusal; the specific reason rides in `error` and the §5.6 log |

Fetch/config codes (raised before the trust engine is reached):

| Condition | Code | Retryable |
|---|---|---|
| Network/timeout/redirect-response/TLS failure | `SKILL_REMOTE_FETCH_FAILED` | yes |
| `sourceId` not in config | `SKILL_REMOTE_SOURCE_UNKNOWN` | no |
| `skill_sources.json` missing/invalid while flag on | `SKILL_REMOTE_CONFIG_INVALID` | no |
| `TORQCLAW_REMOTE_SKILL_SOURCES` off (or governed off) | `SKILL_REMOTE_SOURCES_DISABLED` | no |
| `edited_markdown` supplied for a remote (signed) queue row | `SKILL_REMOTE_EDIT_REFUSED` | no |

**Pin-vs-revocation precedence (F-2):** a digest that is both pinned-mismatched and revoked resolves to `revoked-skill` → `SKILL_TRUST_REVOKED_SKILL`, never `digest-not-current` — the revocation scan precedes the pin check (§5.3). The exhaustiveness test below asserts this exact code for the overlap case.

**Mapper exhaustiveness rule (O-13, normative).** `map_activation_failure` gains one `isinstance(exc, SkillTrustError)` arm that maps EVERY reason: the specially mapped reasons above get their codes; **any unknown or future reason maps to non-retryable `SKILL_TRUST_REFUSED`** — never to the generic retryable `SKILL_ACTIVATION_FAILED` fallback (`governed_skills.py:1105-1106`). The arm is placed BEFORE any parent-class arm — the subclass-ordering pitfall `skill_rollback.py:64-73` documents (a subclass swallowed by an earlier parent arm mislabels the one failure that needs operator inspection). A registry-exhaustiveness test asserts every reason in the frozen registry maps to a code and that an out-of-registry reason maps non-retryable.

`clock-unavailable` is a **mapped-but-dead arm** on `aa6057b` Python (N-7): an in-process raising/non-finite wall-clock read is not producible end to end, so it is mapped for completeness and covered by unit injection only — no e2e vector pretends to exercise it.

All results keep the established never-raise dict shape of the operator surfaces (`skill_rollback.py:48-58` pattern); the `status` key follows the existing `queue_status` rule (`governed_skills.py:1055-1058`). Retryable-after-refresh results additionally carry `retryAfter: "refresh_skill_trust"` (O-12 — a new key on remote results, permitted by §12 rule 4). `skillDecision.ts` guidance strings (R-10c, O-12): code-specific strings MUST be checked **before** the generic retryable arm — on `aa6057b` the guidance is a single three-way ternary keyed on `retryable` first (`skillDecision.ts:37-41`, O-18), which would emit "retry when the running Hermes task(s) finish" for `SKILL_TRUST_STALE`; the structure is reworked so code-specific strings win. Strings: `SKILL_TRUST_STALE` → "run refresh_skill_trust for the source, then decide again"; `SKILL_TRUST_CLOCK_ROLLBACK` → "see the clock-rollback runbook; a newer signed trust bundle is required"; `future-issued`/`trust-not-yet-valid` refusals note the ≤2-minute skew wait; others → non-retryable inspect-first wording in the existing style.

---

## 6. End-to-end flows

### 6.1 Remote install — `install_remote_skill(source_id, skill_id, source_task_id=None)`

New MCP tool in `server.py`, kernel-side flow (every step before the queue write is outside all locks):

1. **Gate:** `TORQCLAW_REMOTE_SKILL_SOURCES` truthy AND `governed_skills.enabled()`; else `SKILL_REMOTE_SOURCES_DISABLED`.
2. **Validate `skill_id`** against the store id discipline (`_ID_RE`, `verified_skill_store.py:61`) **BEFORE any URL is constructed and before any `artifacts/<skillId>/` path is formed** (O-14); a non-conforming id is refused as `SKILL_TRUST_REFUSED` with reason `invalid-schema`.
3. **Config:** parse `skill_sources.json`; resolve `source_id` (§5.5).
4. **Trust refresh (fetch-time freshness, R-8):** if the origin's persisted bundle is missing or outside its window, fetch `trust-bundle.json` and run acceptance (§5.2). Still stale/refused ⇒ typed refusal.
5. **Fetch envelope** (§5.3 bounds), **verify** (§5.3 order — digest computed independently first, then signature, revocations, digest-pin, capability bound R-7).
6. **Persist** the verified signature envelope to `skill_trust/artifacts/<skillId>/<digest>.json` (§5.6).
7. **Stage:** materialize the two decoded files into a temp package dir and `store.stage()` it — the store recomputes and re-validates everything (`_read_package`, L1046-1100), including the F-2 empty-body bound (L1077-1082). Staged digest must equal verified digest (§5.4).
8. **Queue:** `skill_queue` INSERT of a `pending` row — `proposed_name = skill_id`, `skill_markdown =` decoded `SKILL.md` text (for card/draft display), `remote_json = {sourceId, origin, keyId, digest, stageId, verifiedAt}` (§5.7). RS-6: this writes only `pending`; it never decides.
9. **Surface:** when `source_task_id` is provided, emit the `PENDING_APPROVAL` event exactly as `draft_and_queue_skill` does (`server.py:398-408` — same ≤8 KiB ride-along rule), with the R-10(b) trust facts added to `meta`. Return `{status: "pending_approval", queue_id, digest, origin, keyId, verificationStatus: "verified"}`.

Two concurrent `install_remote_skill` calls for the same skill produce two `pending` rows — benign (N-6): whichever is decided second reconciles idempotently against the same pinned digest (§6.4) via `_already_active_and_published`.

**Pilot reachability note (honest bound):** like `rollback_skill` / `disable_skill`, this tool is **operator-invoked; the kernel MCP surface does not distinguish callers on `aa6057b`** (O-19) — kernel-MCP registration proves the tool's reachability, not its caller's authorization (the boundary PRD-004 §9.1 already records for the rollback tools). Console-native initiation (a button that invokes it and a task context that carries the card) is owed to the later console phase alongside approval history (R-10 owed items). In the pilot, the operator invokes the tool directly; when invoked without `source_task_id` there is no card — the trust facts are then observable at the decide seam via `get_skill_draft` (§7.2, AC-18) before deciding via `decide_skill(queue_id, ...)`.

### 6.2 Decision and install of a remote row

`skill_queue.decide()` (`skill_queue.py:54-177`) is extended on the governed branch only:

- Row has `remote_json` ⇒ **`edited_markdown` on APPROVE is refused** with `SKILL_REMOTE_EDIT_REFUSED` before any state change: the signature covers exact bytes (R-3); an edit would change the digest and sever the signature. The row stays `pending`. The refusal is scoped to APPROVE only (O-17): REJECT carrying `edited_markdown` ignores it, exactly matching today's contract (`skill_queue.py:57` — "edited_markdown is ignored on REJECT"). (Local rows keep edit semantics unchanged.)
- REJECT of a remote row additionally removes `staging/<stageId>` — the fetched bytes are no longer needed; the `skill_trust/artifacts/` record MAY remain, it is evidence, not authority (O-17).
- APPROVE routes to a new `governed_skills.install_remote_staged(queue_row_facts)` instead of `install_approved_skill(name, content)`. It:
  1. resolves the staged artifact by `stageId` (`_resolve_artifact`, `verified_skill_store.py:894-914`); a missing/invalid stage (e.g. cleaned by an operator, or a crashed process' reconcile) is a typed, non-retryable refusal telling the operator to re-run `install_remote_skill`;
  2. recomputes the staged digest and requires equality with `remote_json.digest` (§5.4);
  3. **re-verifies trust now** (RS-2): current bundle freshness, key trust/revocation, skill revocation, signature from the persisted artifact record over the recomputed digest — refresh-on-use means a decide() that happens days after fetch cannot ride the fetch-time verdict;
  4. runs the **same** stage→approve→coordinator pipeline as the local path (`approve` at the same seam — the R-7 bound has already guaranteed `requiredCapabilities ⊆ ["read"]`, so the `confirm_permission_delta=True` call at `governed_skills.py:387` remains truthful for remote rows for exactly the reason its comment states), with the commit callback calling `store.activate()` whose `_enforce_activation_policy` performs the same full trust evaluation **inside** the transaction (§6.3) — reading only local trust state (RS-4);
  5. writes the R-6 signer fields into the installed record and audit row.
- Row flip to `approved` happens **only after** success — the existing GS-COORD ordering (`skill_queue.py:118-149`) unchanged.
- Failures map through `map_activation_failure(exc, queue_status="pending")` — the row stays pending on every failure arm, including all new trust arms.

### 6.3 Activation-time and rollback-time enforcement (the converted seam)

`_enforce_activation_policy(manifest, active_profile)` gains the trust hook for remote-sourced manifests (predicate §4). Because both `activate()` (L279) and `rollback()` (L509) already call it, the conversion covers both decision seams with **zero new call sites** (R-4). Evaluation, in order, all local-state-only:

1. resolve `(origin, keyId)` — at activate, from the artifact-record + manifest; at rollback, from the R-6 persisted installed record (absent for a remote-sourced manifest ⇒ refuse);
2. origin's accepted bundle exists, is within `min(nextUpdate, acceptedAt+72h)`, and the origin is not clock-quarantined;
3. `keyId` is currently trusted for that origin and not revoked (`revoked-key` ⇒ rollback-ineligible, AC-4);
4. skill not revoked for this id (digest-optional match, `skillTrust.ts:399-405` model);
5. when the accepted bundle pins this `skillId`, the recomputed digest equals the pin (`digest-not-current`, O-1);
6. signature from `skill_trust/artifacts/<id>/<digest>.json` verifies over the digest **recomputed from the package bytes being activated** (the store has already recomputed it in `_read_package` on the same code path);
7. `requiredCapabilities ⊆ ["read"]` (R-7 re-checked — a bound checked only at fetch time would be an unenforced claim at this seam).

**Wiring and fail-closed-when-unwired (O-5, normative — the sixth-unenforced-claim guard).** The trust evaluator is **constructor-injected** into `VerifiedSkillStore`, wired at the single production construction site `governed_skills._store()` (`governed_skills.py:150-181`). When `_enforce_activation_policy` encounters a remote-sourced manifest (§4) with the remote flag on and **no evaluator attached to this store instance**, it REFUSES — `SKILL_TRUST_REFUSED`, reason `trust-engine-unavailable` — it never skips. An unwired seam fails closed instead of silently passing; DP-16 pins it.

The seam needs the digest and store context; the conversion therefore threads the already-computed artifact digest into the policy call (an internal signature change within `verified_skill_store.py`, no public API change). Local manifests (`source` not `https://`) skip steps 1-7 exactly as today — flag-off and local behavior byte-identical.

**Seam partition (F-3, normative — auditable in place).** For a remote-sourced manifest, this seam has exactly two dispositions: **(a) flag on** ⇒ full trust evaluation (steps 1-7 above), refusing `trust-engine-unavailable` if no evaluator is attached to the store instance (O-5); **(b) flag off** ⇒ the trust hook is skipped and the operation's result carries `trustUnenforced: true` (§12 rule 6). There is no third path. Critically, **`reconcile()` / store init never reach this seam**: `_enforce_activation_policy` is called only at `verified_skill_store.py:279` (`activate`) and `:509` (`rollback`); `_reconcile_transaction` (L737-863) does not call it (verified on `aa6057b`). So journal recovery re-commits a previously-decided activation without re-running trust evaluation — which is correct, because the decision seam already evaluated trust when the operation was first admitted, and reconcile only finishes a crash-interrupted commit; it never admits a new one. Pinning this in prose so a future auditor does not re-derive "does reconcile bypass trust?" as an open hole.

### 6.4 Idempotency and crash-retry for fetched packages

The local path's idempotency rests on `_build_package` purity: `(skill_id, markdown) → digest` is a pure function (`governed_skills.py:232-241`), so a success-side-crash retry re-derives the same digest and `_already_active_and_published` (L267-325) can prove "already done" by digest equality plus byte re-hash. **The remote path never re-synthesizes a package, so it does not need synthesis purity — it has something stronger: the digest is pinned.** Justification, explicit:

- The digest is computed from publisher content at verify time and **pinned in the queue row** (`remote_json.digest`) and in the trust artifact record. Publisher content is deterministic per content by definition of a hash; if the publisher later changes the published bytes, that is a *different* digest and a different (future) install — it cannot silently retarget this row, because the install source is the **staged bytes**, gated by equality with the pinned digest (§6.2 step 2), never a re-fetch.
- Success-side crash (activation landed, queue flip lost): retry of `decide()` calls `_already_active_and_published(sid, pinned_digest)` — same mechanism, same byte-re-hash proof (L313-325), no second activation. The reconciled result surfaces `reconciledFromPriorSuccess` exactly as today (`skill_queue.py:157-165`).
- Failure-side crash: the coordinator's journal/restore discipline is unchanged; the row stayed `pending`; a retry decides again against the same staged bytes and pinned digest.
- Crash between verify and queue-write: no row exists; `install_remote_skill` is re-run; a fresh stage of identical bytes yields the identical digest (stage ids differ, digests do not — RS-3).

### 6.5 Trust refresh — `refresh_skill_trust(source_id)`

New MCP tool: fetch + acceptance of the origin's bundle on demand (§5.2), outside all locks, returning `{ok, origin, sequence, decision, reason?}`. This is the retry remedy for `SKILL_TRUST_STALE` and the recovery vehicle for quarantine (§14). It is the *only* network path besides the envelope fetch, and neither ever runs under `_MUTATION_LOCK` (RS-4/SP-3).

**Revocation-vs-installed reporting (O-2, normative).** On accepting a bundle, the refresh scans the installed and active records (R-6 gives `origin`/`keyId` per digest) against the new bundle's key/skill revocations and digest pins, and RETURNS the matches — `revocationsAffectingInstalled: [{skillId, digest, active}]` — also written to `events.log`. **Reporting only**: refresh never auto-disables or mutates governed state (RS-6 single-writer discipline is preserved); the runbook (§14.6) instructs the operator to run `disable_skill` on an active hit. AC-17 gates this.

---

## 7. Gateway scope (minimal — R-10 verbatim)

### 7.1 `authz.ts` — `APPROVE_SKILL` joins the approve-authority gate

`authorizeOperator` (`authz.ts:214-235`): extend the L220 condition from `cmd.action === 'APPROVE_TOOL'` to also cover `'APPROVE_SKILL'`. Everything inside the branch is unchanged: live `currentRole()` check (L227), `holdsAuthority('approve')` (L230), absent-surface blanket allow (L217-218). Channel/node denial of `APPROVE_SKILL` already exists (`authz.ts:153`) and is untouched. Specified against `aa6057b` independently (§1.4). Flag-off no-change guarantee and lockout consideration: §2 R-10(a). The kernel-side note in `skill_queue.decide`'s docstring states both halves (O-19 wording): the writer-level re-check lives with the kernel decision seam, and the kernel tools are operator-invoked — the kernel MCP surface does not distinguish callers on `aa6057b`.

### 7.2 Trust facts at the decide seam (primary) and on the approval card (console-phase consumer)

**Decide seam — the surface the deciding operator actually uses (O-6, primary).** `get_skill_draft` (`server.py:421-424` → `skill_queue.get_draft`, `skill_queue.py:40-51`) is extended to return the trust facts for remote rows — `{sourceOrigin, keyId, digest, verificationStatus}`, read from the row's `remote_json` — so the facts are observable at the seam a pilot decision actually flows through (§6.1 note: a card exists only when `source_task_id` was supplied). AC-18 gates this at the MCP tool seam. Local rows return exactly today's shape.

**Approval card — console-phase consumer of the same metadata.** `PENDING_APPROVAL` metadata additions for remote rows: `sourceOrigin`, `keyId`, `digest`, `verificationStatus` (always `"verified"` at emit time — an unverified package never reaches the queue, RS-1; the field exists so the card never has to infer it). `SkillApprovalCard` (`TorqTerminal.tsx:1054-1155`; its docblock at L1051-1053 — O-18) renders them as plain facts, adopting the no-invented-assessments discipline of the P2 tool card (L1048-1050); the card render test is explicitly a **unit vector, not an activation-path AC** (O-6). The card's Edit affordance is disabled for rows carrying trust facts (matches §6.2's APPROVE-scoped `SKILL_REMOTE_EDIT_REFUSED` — the UI should not offer what the kernel will refuse).

### 7.3 `skillDecision.ts` guidance strings

Per §5.8, including the O-12 ordering rule: code-specific strings are checked **before** the generic retryable arm — on `aa6057b` the guidance is a single three-way ternary keyed on `retryable` first (`skillDecision.ts:37-41`; O-18: it is a ternary, not a per-code structure), so the structure is reworked rather than merely appended to. No other gateway change. No new tables, no schema change in `state.db` (§12).

---

## 8. Structural properties (numbered, house style)

- **SP-1 Flag-off identity.** `TORQCLAW_REMOTE_SKILL_SOURCES` unset ⇒ byte-identical behavior on a fixed transcript of local install/decide/rollback/disable/doctor operations (RS-7), with no carve-out (F-1). Pinned by a transcript test; the transcript's byte-identity is now literally unconditional because the only capacity-behavior change (audit headroom) is remote-scoped and the local revert fix is on a non-success arm.
- **SP-2 Fail closed on every trust failure.** Every refusal arm in §5.8 terminates the governed operation with no partial state; there is no advisory/warn path. Pinned per-arm.
- **SP-3 No network inside `_MUTATION_LOCK`.** Fetch and refresh complete before the coordinator; in-lock re-verification reads local state only. Pinned by a test that fails any socket call while the lock is held (socket-guard fixture around the coordinator run).
- **SP-4 Single verification implementation.** One canonicalizer, one verifier, in the kernel; the signing CLI imports them; `skillTrust.ts` and its test are gone; the reachability expectation is inverted so the dormant entry cannot silently return.
- **SP-5 Every new module reachable in its introducing commit.** `pnpm reachability` (entry points include `mcp_wrapper/server.py`, `ops/reachability.mjs:44`; substance threshold L89) must PASS with **no new `DORMANT` entries** in every P4 commit — each new module ships wired to `server.py` transitively in the commit that adds it.
- **SP-6 One decision writer.** Only `decide()` flips queue rows out of `pending` (RS-6); `install_remote_skill` inserts `pending` rows only. Pinned by a test asserting no other write site (and by the existing `status != "pending"` guard, `skill_queue.py:92-93`).
- **SP-7 Verification colocated with install authority.** No trust verdict crosses a process boundary; the gateway receives *facts about* a verdict (§7.2), never supplies one.
- **SP-8 Trust events never enter `state.json` `audit[]`.** The 1,000-entry fail-closed governed audit is reserved for governed lifecycle rows; trust/refresh/quarantine volume goes to the rotated §5.6 log (R-9). Pinned by asserting `audit[]` length is unchanged across a refresh/verify storm.
- **SP-9 Trust-engine lock is a leaf (O-4).** The trust engine's internal lock orders strictly AFTER `store._lock` in the global order — `_MUTATION_LOCK` → `store._lock` → trust lock — is never held while acquiring any other lock, and is NEVER held across network I/O. `refresh_skill_trust` fetches outside the lock, then locks → re-runs monotonic acceptance → persists; a concurrent refresh that lost the race is refused `sequence-not-monotonic` — the correct outcome, not a deadlock. Trust-engine singleton construction follows the `_STORE_SINGLETON_LOCK` ceremony (`governed_skills.py:116-124`). In-lock quarantine persistence (a write) obeys the same leaf ordering. Pinned by a lock-order assertion test.

---

## 9. Acceptance criteria (observable activation-path behaviors)

Each criterion is an end-to-end behavior at a production seam — never a unit vector (the TRUSTOS-002 L816 mandate). "Refused" always means: typed code from §5.8, queue row (if any) still `pending`, no governed/published state change, event in the §5.6 log.

- **AC-1 (the L816 mandate).** A package whose envelope signature does not verify (wrong key, tampered signed fields, tampered signature) is refused at `install_remote_skill` with `SKILL_TRUST_REFUSED`, and the operator-visible error names the reason. Proven at the MCP tool seam, not by calling the trust engine directly.
- **AC-2 (TOCTOU).** After a successful verify, the staged `SKILL.md` bytes are tampered on disk before APPROVE; `decide()` is refused by the stage-time/activation-time digest recompute (`SkillIntegrityError` path) — the fetch-time verdict is provably not reused.
- **AC-3 (digest-mismatch).** An envelope whose `digest` field differs from the independently computed digest — but whose signature over that wrong digest is *valid* — is refused with reason `digest-mismatch` (proves compute-before-verify ordering, R-3).
- **AC-4 (revoked-key rollback).** Install and activate a remote version; accept a newer bundle revoking its key; `rollback_skill` to that version is refused with `SKILL_TRUST_REVOKED_KEY` at the `rollback()` policy seam. A local version in the same store remains rollback-eligible (scoping proof).
- **AC-5 (stale blocks activation).** With a bundle past `min(nextUpdate, acceptedAt+72h)`, APPROVE of a pending remote row is refused with `SKILL_TRUST_STALE` (retryable-after-refresh); after `refresh_skill_trust` accepts a newer bundle, the same decide succeeds.
- **AC-6 (capability bound).** An envelope whose manifest declares any capability beyond `["read"]` is refused at `install_remote_skill` with `SKILL_TRUST_CAPABILITY_UNSUPPORTED`; nothing is staged or queued.
- **AC-7 (flag-off byte-identity).** A fixed transcript of local operations (queue → decide → rollback → disable → list_versions → doctor) with the flag unset produces byte-identical results/output to `aa6057b`; `install_remote_skill` / `refresh_skill_trust` return `SKILL_REMOTE_SOURCES_DISABLED`; no file under `skill_trust/` is created.
- **AC-8 (doctor preflight).** With flag on and `skill_sources.json` absent or unparseable, `doctor` preflight reports a red `preflight.remote-skill-sources`; with flag off, the record is absent and doctor output is unchanged.
- **AC-9 (edit refusal).** `decide_skill(queue_id, "APPROVE", edited_markdown=...)` on a remote row is refused with `SKILL_REMOTE_EDIT_REFUSED`; the row stays `pending`; a subsequent unedited APPROVE succeeds.
- **AC-10 (clock rollback).** Persisted `lastObservedNowMs` regressed beyond 5 minutes ⇒ every remote verify/activate/rollback refuses with `SKILL_TRUST_CLOCK_ROLLBACK`; replaying the previously accepted bundle does not recover (`sequence-not-monotonic`); a strictly newer signed bundle does.
- **AC-11 (skill revocation, digest-optional).** A bundle revoking `skillId` without a digest blocks every digest of that skill at install and activation; a digest-scoped revocation blocks only that digest.
- **AC-12 (monotonicity).** A bundle with `sequence` ≤ accepted, or `issuedAt` ≤ accepted, is refused (`sequence-not-monotonic` / `issued-at-not-monotonic`) at `refresh_skill_trust` — replay of an old-but-valid bundle can never roll trust state back.
- **AC-13 (redirect/bounds).** A source answering 301/302 is refused (`SKILL_REMOTE_FETCH_FAILED`, no follow); an envelope one byte over cap is refused at `limit+1` streaming, connection closed.
- **AC-14 (authority gate).** With collab on and an operator surface lacking a live `approve` grant, `APPROVE_SKILL` is denied at `authz.ts` with the authority reason; with `ctx.surface` absent, behavior is byte-identical to `aa6057b` (blanket allow).
- **AC-15 (activation-path boot proof).** After a remote install completes, a real agent boot renders the skill into the actual system prompt (the GS-ACCEPT harness pattern, `pyproject.toml:46-53` acceptance marker); after AC-4's revocation plus disable, it does not. "Verify the artifact, not the unit test."
- **AC-16 (digest pin / anti-rollback, O-1).** With an accepted bundle pinning `skillId` to digest D2, a validly-signed older envelope at D1 is refused at `install_remote_skill` with reason `digest-not-current`; activation/rollback of an installed D1 is refused at the §6.3 seam with the same reason.
- **AC-17 (revocation-vs-active reporting, O-2).** Accepting a bundle that revokes the key (or skill) of an installed, ACTIVE version makes `refresh_skill_trust` return that version in `revocationsAffectingInstalled` (with `active: true`) and log it; the skill remains active until the operator runs `disable_skill` — reporting, never auto-quarantine.
- **AC-18 (decide-seam trust facts, O-6).** For a pending remote row, `get_skill_draft(queue_id)` returns `{sourceOrigin, keyId, digest, verificationStatus}` — proven at the MCP tool seam; local rows return today's shape byte-identically.

---

## 10. Deletion probes (house method — each sabotage must turn the suite RED)

| # | Sabotage (applied to a built tree) | Test that must go red |
|---|---|---|
| DP-1 | Skip signature verification in the envelope verify path (return allow) | AC-1 (bad-signature refused at the tool seam) |
| DP-2 | Reuse the envelope's claimed digest instead of computing from bytes | AC-3 (valid-signature-over-wrong-digest) |
| DP-3 | Skip the stage/activation digest recompute | AC-2 (TOCTOU tamper) |
| DP-4 | Drop the trust evaluation from `_enforce_activation_policy`'s remote arm | AC-4, AC-5 (revoked-key rollback; stale activation) |
| DP-5 | Remove the R-6 signer fields from `_installed_record` | AC-4 (rollback cannot resolve origin/key ⇒ the refusal test's *positive* control — local rollback eligibility — plus AC-4's remote arm both pin it) |
| DP-6 | Remove the `APPROVE_SKILL` condition from `authz.ts:220` | AC-14 |
| DP-7 | Route trust events into `state.json` `audit[]` | SP-8 pin (audit length invariant under a refresh storm) plus the existing capacity fail-closed tests |
| DP-8 | Re-add the `skillTrust.ts` `DORMANT` entry (or the file) | Inverted `tests/reachability.test.ts:87` expectation |
| DP-9 | Skip the R-7 capability check at verify OR at the activation seam | AC-6 (verify-time) and the §6.3-step-6 activation-time re-check test |
| DP-10 | Let `refresh_skill_trust` accept a replayed bundle | AC-12 |
| DP-11 | Have the signing CLI ship its own canonicalizer | SP-4 cross-vector test (CLI-signed bundle must verify in the engine; a mutation of the engine canonicalizer must break the CLI's output symmetrically) |
| DP-12 | Move the envelope fetch inside `ActivationCoordinator.run()` (under `_MUTATION_LOCK`) | SP-3 socket-guard test (O-3) |
| DP-13 | Make `install_remote_skill` write a non-`pending` queue status | SP-6 single-writer pin (O-3) |
| DP-14 | Treat an unset `TORQCLAW_REMOTE_SKILL_SOURCES` as truthy | AC-7 flag-off transcript (O-3) |
| DP-15 | Drop the digest-pin comparison (verify-time or seam-time) | AC-16 (O-1) |
| DP-16 | Construct `VerifiedSkillStore` without the injected trust evaluator, attempt a remote activation with the flag on | The `trust-engine-unavailable` refusal test (O-5) |

**SP pins count as gate tests for this table (O-3, explicit):** SP-3's socket-guard, SP-6's single-writer pin, and SP-1/AC-7's flag-off transcript are the red-detectors for DP-12, DP-13, and DP-14 respectively — listed here so §10 is complete against RS-4/RS-6/RS-7 rather than implicitly delegating them.

The probe harness follows the GS-COORD deletion-probe method: apply sabotage, run the gate, require RED, revert. Green-after-deletion = uncovered control = FREEZE blocker.

---

## 11. Ticket breakdown and dependency order

Each ticket carries its gates; a ticket is done only when its ACs pass, its deletion probes go red under sabotage, `pnpm reachability` passes with no new `DORMANT` entries, and the full existing suites stay green.

**Stub wiring is forbidden (O-10, normative):** a caller that imports but does not enforce at a production seam does not satisfy SP-5. Every ticket below lands each new module in the same commit/merge-gate as a REAL enforcing call site.

- **P4-1 — Kernel trust engine + decision-seam enforcement (ONE merge gate, O-10)** (`mcp_wrapper/skill_trust.py` + the `verified_skill_store.py` seam conversion): TCJSON_V1 canonicalizer, bundle acceptance (§5.2), artifact evaluation (§5.3 order), persistence + clock discipline (§5.6), `SkillTrustError` reason registry, `cryptography` pinned in `pyproject.toml`, Phase-0 vectors (§5.1) — **merged together with its first real enforcing call site: the §6.3 `_enforce_activation_policy` conversion, including the O-5 constructor injection at `governed_skills._store()` and the fail-closed `trust-engine-unavailable` arm.** The engine is thereby reachable from `server.py` AND enforcing at a production seam in its introducing merge (SP-5); a standalone unit-tested trust module with no enforcing caller is the very defect this program names. Gates: DP-4, DP-16 red-under-sabotage; seam-level refusal tests (an unbundled/stale/revoked/unpinned-mismatch remote manifest refuses at activate/rollback); unit vectors are necessary but not sufficient. ACs 10, 11, 12, 16 complete at the tool seam once P4-5 lands.
- **P4-2 — TS engine retirement**: delete `packages/gateway/src/skillTrust.ts` + `tests/skill-trust.test.ts`; remove `ops/reachability.mjs:61` with an L62-85-style retirement comment; invert `tests/reachability.test.ts:87`; correct `README.md:201-206` — including L203's "662 lines" → 661 (O-18). Depends on P4-1 merged (the model's reference stays in history, not in the tree). Gate: DP-8 red-under-sabotage; reachability PASS.
- **P4-3 — Config, flag, doctor**: `skill_sources.json` parser (§5.5), `TORQCLAW_REMOTE_SKILL_SOURCES` per-call gate, `skill_trust/` layout bootstrap, doctor conditional preflight incl. the N-4 SPKI key check. Gates: AC-7, AC-8; SP-1 transcript; DP-14.
- **P4-4 — Fetcher** (`mcp_wrapper/skill_sources.py`): bounded HTTPS client (limit+1 streaming, no redirects, timeouts), envelope + bundle fetch. Depends P4-1, P4-3. Gates: AC-13; SP-3 socket-guard test; DP-12.
- **P4-5 — Remote install flow** (`mcp_wrapper/remote_skills.py` + `server.py` tools `install_remote_skill`, `refresh_skill_trust`; `skill_queue` guarded `remote_json` column; `decide()` routing + APPROVE-scoped edit refusal + REJECT stage cleanup; `get_skill_draft` trust facts; `governed_skills.install_remote_staged`; O-2 refresh reporting): §6.1, §6.2, §6.4, §6.5, §7.2 decide seam. Depends P4-4. Gates: **AC-1 (the L816 mandate), AC-2, AC-3, AC-6, AC-9, AC-16, AC-17, AC-18**; SP-6; DP-1/2/3/9/13/15.
- **P4-6 — Signer persistence + audit headroom + mapper arms** (`verified_skill_store.py`, `governed_skills.py`): R-6 fields + validator tolerance; F-1 audit fixes — remote-scoped headroom check AND local `revert_activation` routed through `_append_audit` fail-closed (R-9); `map_activation_failure` arms incl. the O-13 exhaustiveness arm + registry-exhaustiveness test (§5.8). Depends only on P4-1 (O-10); its e2e ACs additionally need P4-5's install path. Gates: AC-4, AC-5; DP-5; **the F-1 boundary tests** — (i) remote transaction refused before mutation when `audit` is filled to `MAX_AUDIT_ENTRIES − 1`; (ii) the local flag-off transcript byte-identical with `audit == 999` present (proves the headroom check does NOT fire locally — the RS-7 boundary test the review demanded); (iii) local revert at capacity fails closed via `_append_audit`, not a silent drop; (iv) remote last-resort overflow arm covered by injection.
- **P4-7 — Trust operational log** (§5.6 `events.log`, rotation; O-9 `skill_audit_overflow.log`). Depends P4-3. Gates: SP-8 / DP-7.
- **P4-8 — Gateway minimal** (§7): `authz.ts:220` extension + tests; card trust facts + edit-disable (unit vectors); `skillDecision.ts` restructured strings (O-12). Depends P4-5, P4-6 for the codes. Gates: AC-14 / DP-6; guidance-ordering test (`SKILL_TRUST_STALE` string wins over the retryable arm); flag-off parity test.
- **P4-9 — Signing CLI + bootstrap + runbook** (`scripts/skill_signing.py`, §13; runbook §14 into operator docs). Depends P4-1 (imports the canonicalizer — SP-4/DP-11). Gates: cross-vector test (CLI output verifies in the engine); a full pilot dry-run: keygen → sign bundle → sign envelope → host on loopback HTTPS fixture → `install_remote_skill` → approve → AC-15 boot proof.

Order: P4-1 (engine + seam, one merge) → {P4-3, P4-4} → P4-5 → {P4-6, P4-7} → {P4-2, P4-8, P4-9}. No ticket both "lands with its caller" and precedes that caller (O-10): P4-1 carries its own enforcing seam; P4-4/P4-5 add the fetch/tool callers on top of the already-enforcing engine. P4-2 may land any time after P4-1; nothing else depends on it.

---

## 12. Migration rules (strictly additive)

1. `state.json`: optional fields only (§5.7); `schemaVersion` stays 1; the validator tolerates absence; **no migration machinery is invented**; an old state file is fully valid new state.
2. `skill_queue`: one nullable column via guarded `ALTER TABLE` (§5.7); repeat/interruption safe; every existing row, value, and rowid preserved; `NULL` = legacy semantics.
3. **No new tables gateway-side.** No `state.db` change of any kind.
4. Existing installs are unaffected: local manifests never enter a trust path (§4); every existing operation's result shape is unchanged (new result keys appear only on remote rows).
5. Flag-off default preserved: **no migration, build, test, or release may change the `TORQCLAW_REMOTE_SKILL_SOURCES` default** (house rule, verbatim).
6. Rollback of the feature = unset the flag: remote tools refuse and trust files become inert data. Normative rule for already-installed remote-sourced versions: with the remote flag OFF, §6.3's trust hook is skipped entirely (the flag gates the whole subsystem per-call, RS-7), so previously installed remote versions behave as local ones — flag-off is a safe retreat, never a bricking of installed state. The trade-off is stated, not hidden: while the flag is off, a key revocation is not enforced against already-installed versions; turning the subsystem off is the operator's explicit acceptance of that, and the runbook says so. Zero-cost honesty fact (O-20): a rollback/activation result for a version carrying R-6 remote fields while the flag is OFF additionally includes `trustUnenforced: true` plus a one-sentence note — a new result key on remote-version results only, permitted by rule 4; AC-7's transcript is local-only, so flag-off byte-identity holds.

---

## 13. Key management and signing CLI

- **`scripts/skill_signing.py`** — offline, operator-run, stdlib + the same `cryptography` package, importing TCJSON_V1 and the schema constants from `mcp_wrapper.skill_trust` (SP-4). Subcommands: `keygen` (writes private key PEM + public SPKI b64url), `sign-bundle` (assembles + signs TRUST_BUNDLE_V1; enforces monotonic sequence/issuedAt against a previous bundle file if given), `sign-skill` (takes `skill.json` + `SKILL.md` paths, computes the package digest itself, emits REMOTE_PKG_V1), `verify` (round-trip self-check).
- **Private keys NEVER in the repo or in environment variables.** Key paths are supplied at invocation (`--key <path>`). The CLI refuses to run against a key file located inside the repository working tree or inside `$TORQCLAW_DATA_DIR` (path containment check).
- **Windows storage location (resolves PRD-001 §17 L450):** operator keys live in an operator-owned directory **adjacent to** the data dir — default **`~/.torqclaw-signing/`** (sibling of the default `~/.torqclaw`), deliberately *outside* `$TORQCLAW_DATA_DIR` so data-dir backups, exports, or support bundles can never sweep private key material. NTFS ACLs are the operator's responsibility; the runbook documents `icacls` hardening as guidance, not enforcement.
- **Signing order (O-15):** `sign-skill` writes the in-manifest signature stub (`{"algorithm": "Ed25519", "keyId": "<id>", "value": "detached"}`) into `skill.json` **before** computing the package digest, then signs the digest — the manifest bytes are hashed with the stub in place (§5.3). A hand-rolling publisher who hashes first and stubs second will produce a first-attempt `digest-mismatch`; this ordering note exists so they don't.
- **One hosting path per signature (N-2):** because the manifest `source` must equal the exact fetch URL (§4), a signature binds the package to ONE hosting path — mirroring or migrating a source to a new URL requires re-signing.
- **Bootstrapping the first pilot publisher:** operator runs `keygen` twice (authority key, publisher key); writes the authority *public* key into `skill_sources.json`; signs bundle sequence 1 trusting the publisher key; hosts `trust-bundle.json` + `skills/<id>.json` at the source `baseUrl` (any static HTTPS host — see OQ-1); runs `refresh_skill_trust`, then `install_remote_skill`. The P4-9 pilot dry-run automates this end to end against a loopback HTTPS fixture.

---

## 14. Operator recovery runbook (ships with P4-9)

### 14.1 Clock-rollback quarantine
Symptom: `SKILL_TRUST_CLOCK_ROLLBACK` on every remote operation. Meaning: persisted wall time regressed > 5 min, or trust persistence failed — the kernel can no longer prove bundle freshness. Recovery: fix the clock, then obtain a **strictly newer signed bundle** (sequence AND issuedAt strictly higher) from the publisher and run `refresh_skill_trust`. Replaying the old bundle is refused by design (AC-10). A clock repair alone never clears quarantine.

### 14.2 Corrupt trust persistence (bundles only)
Symptom: quarantine immediately after start; §5.6 log shows a load-time verification failure. Recovery: delete the affected `skill_trust/bundles/<sourceId>.json` (a bundle file is a cache of signed data, never the root of trust — the roots are the public keys in `skill_sources.json`), then `refresh_skill_trust`. **This delete-and-refetch advice applies ONLY to `bundles/` — never to `artifacts/` or the whole `skill_trust/` tree (O-8; see §14.5).** Deleting `clock.json` is NOT a recovery path and re-enters 14.1's requirement by design.

### 14.3 Stale bundle
Symptom: `SKILL_TRUST_STALE`. Recovery: `refresh_skill_trust(source_id)`, then retry the refused operation. If the publisher has not published a fresh bundle, remote operations stay blocked — that is the fail-closed contract, not an outage to work around. Because there is no background refresher (R-8 deferral), schedule `refresh_skill_trust` externally if a tighter revocation-discovery bound than "next governed operation" is required.

### 14.4 Governed audit at capacity
Two symptoms, both fail-closed (F-1):
- **Remote transaction** refused with `SkillAuditCapacityError` **before any mutation** — the remote-scoped headroom check (`len(audit) ≤ MAX_AUDIT_ENTRIES − 2`).
- **Local transaction**: a local *revert/restore* at capacity now fails closed via `_append_audit` (previously it silently dropped — O-9 fix on the local path); a local *success* is unaffected and behaves exactly as `aa6057b` (fails closed at 1000 in `_append_audit`).

Action either way: the governed audit is at its fail-closed cap — the same operator action the existing capacity error demands. If a *remote* result ever carries `auditOverflow: true` (the remote-only last-resort arm), treat it as a **red flag that the remote headroom check was bypassed and file a defect**; the diverted record is in `$TORQCLAW_DATA_DIR/skill_audit_overflow.log` (O-9). The local path never diverts — it fails closed outright.

### 14.5 `artifacts/` is durable evidence — back it up (O-8)
`skill_trust/artifacts/` holds the **only copy of the signature evidence for each installed remote digest** — it is durable evidence, not a cache. Back it up WITH `state.json`. Loss consequence: remote-sourced installed versions become permanently rollback- and re-activation-ineligible (`artifact-record-missing`, fail-closed) unless the publisher still serves the **identical** digest. Recovery: re-run `install_remote_skill` — it re-persists the artifact record iff the served envelope still carries the same digest; a publisher who has moved on cannot resurrect the old version's eligibility, by design.

### 14.6 Revocation hits an ACTIVE version (O-2)
Symptom: `refresh_skill_trust` returns `revocationsAffectingInstalled` with an `active: true` entry (also in `events.log`). Meaning: a currently active skill's key or digest is now revoked; it **remains active and prompt-rendered until you act** — refresh reports, it never auto-disables (RS-6). Action: run `disable_skill(skill_id)` (or `rollback_skill` to an unaffected installed digest). The next activation/rollback of the affected version would refuse at the §6.3 seam either way; disabling closes the already-running exposure.

---

## 15. Non-goals

- Capability-delta approval UX (R-7's lift condition — a later phase).
- Background/periodic trust refresh scheduler (R-8 deferral, §16 D-1).
- Gateway-side skill-approval history/persistence (`ApprovalHistoryPanel.tsx:191` — later console phase), and console-native remote-install initiation (§6.1 note).
- Skill marketplace, discovery, search, ratings, payments (PRD-001 §16 ruling stands).
- Archive formats of any kind (zip/tar/compression) — the two-file, zero-decompression contract is permanent for this phase.
- BRIDGE/FRONTIER interactions — skills are kernel-local; nothing here touches tool grants, `grantAdmission.ts`, or the FRONTIER fail-closed posture.
- Multi-publisher federation, cross-origin key delegation, cross-signing trust grants (PRD-001 §9.5 L232's "cross-signing is evidence but does not automatically grant trust" is preserved by simply not implementing cross-signing at all).
- Any change to the legacy (non-governed) skill path.

---

## 16. Recorded deviations from PRD-001 §9.5 (honest ledger)

- **D-1 (refresh cadence + active-version quarantine).** §9.5 L230 requires revocation refresh "at least every 24 hours while enabled," and L232 requires a revoked key to "disable and quarantine every affected installed version." Deferred (R-8): no kernel scheduler exists. True worst case, stated verbatim (O-2): **an already-active revoked skill remains active and prompt-rendered until an operator disables it; no automatic quarantine of active versions exists in this phase.** A revoked key is discovered at the next governed operation or explicit refresh — and `refresh_skill_trust` now REPORTS affected installed/active versions (§6.5, AC-17, runbook §14.6) so the operator's disable action is prompted, not left to archaeology. The 72 h hard expiry (kept) bounds new activations, not already-active state.
- **D-2 (canonical numbers).** §11 L329 specifies RFC 8785 (JCS) canonicalization. TCJSON_V1 instead freezes a strict subset: integers-only numbers (§5.1 rule 5). Rationale: JCS number serialization requires ES shortest-round-trip float formatting, which Python does not natively guarantee; every signed field is an integer; a subset that rejects floats cannot produce a cross-implementation divergence. The `README.md:208-211` caveat ("without RFC 8785 interoperability vectors") is thereby resolved by narrowing, not by achieving JCS.
- **D-3 (separate revocation authority).** §9.5 L229 requires each trust entry to name a *separate* revocation-authority key and URL. This PRD folds revocation into the origin's signed trust bundle (the `skillTrust.ts` model). Rationale: one signed, monotonic document per origin is strictly simpler to reason about and to make monotonic; a separate revocation channel doubles the freshness/monotonicity surface for a single-publisher pilot. Revisit at multi-publisher scale (non-goal).
- **D-4 (signature coverage).** §11 L329 signs the canonicalized *manifest*. This PRD signs the identity envelope over the computed **package digest** (R-3, §5.3), which transitively covers every manifest byte AND every `SKILL.md` byte — strictly stronger content binding, and immune to the caller-supplied-digest trap.
- **D-5 (SemVer downgrade policy).** §11 L329's SemVer downgrade rules are inapplicable: governed identity is digest-only (RS-3); "upgrade" is a new digest through the same approval; "downgrade" is `rollback_skill` to an exact installed digest, now trust-gated (AC-4).
- **D-6 (pinned upgrades — IMPLEMENTED, not deferred; O-1).** PRD-001 §13 L404's "pinned upgrades" — distinct from the §11 L329 SemVer rule D-5 covers — is delivered by the bundle digest-pin map (§5.2): the publisher's signed, strictly monotonic bundle pins the current digest per skill, and every older digest is refused `digest-not-current` at install AND at the activation/rollback seam (AC-16, DP-15). Anti-rollback follows from bundle monotonicity, with no new freshness surface.

---

## 17. Open questions (genuinely open only)

| # | Question | Owner | Needed by |
|---|---|---|---|
| OQ-1 | Pilot publisher hosting: which static-HTTPS host serves the first real `trust-bundle.json` + envelopes (the PRD-001 §17 L449 question, still open)? | Operator | Before the P4-9 live pilot (the loopback-fixture pilot does not need it) |
| OQ-2 | TTL ratification: are 24 h max bundle window, 72 h hard expiry, 2 min skew, 5 min restart regression the pilot values, or does the operator tighten them? (Defaults above are binding until re-ratified.) | Operator | Before flag-on in any real deployment |

**OQ-1 / OQ-2 — DEFERRED by operator ruling 2026-08-23** (recorded in
`docs/prd-reviews/G1D-FABLE-CLEANUP-DOCS-TRUTH-2026-08-23.md`): no pilot publisher has been
chosen (none is currently in use), so OQ-1 does not block anything today. TTL re-ratification
(OQ-2, the 30-day window) ships together with the first real publisher, not before. The flag
posture is unchanged by this ruling — `TORQCLAW_REMOTE_SKILL_SOURCES` remains default OFF, and
neither OQ is treated as resolved.

Everything else PRD-001 §17 left open that touches this phase is decided in this document: Windows key storage (§13 — the L450 question, gated "Before Phase 3" but resolved here, O-18), rollback/revocation semantics (R-4/AC-4), pinned upgrades (§5.2/D-6), and the trust/revocation document format (§5.2).

---

## 18. Implementation guardrails (build-fleet watch notes)

Non-normative-but-binding notes the review surfaced; each is a build-time check the implementing tickets inherit, not a new requirement.

- **G-1 (headroom arithmetic assumption).** The `MAX_AUDIT_ENTRIES − 2` remote headroom (§2 R-9, F-1) assumes **at most one revert row per transaction** — one action row plus one potential revert. A build-time assertion/note must confirm no code path triggers a revert AND a second audit-bearing mutation in the same transaction; if such a path is ever added, the headroom constant must grow to match. (On `aa6057b` the coordinator's `restore` performs exactly one `revert_activation`, so the assumption holds today.)
- **G-2 (both policy seams, DP-4/DP-16).** The deletion probes for the trust seam must go RED at **both** `_enforce_activation_policy` call sites — `activate` (`verified_skill_store.py:279`) AND `rollback` (`:509`) — not just activate. A probe that only sabotages the activate path while rollback still enforces would leave a live hole passing the gate; the harness runs the sabotage against both entry points.
- **G-3 (single-implementation anti-forgery, DP-11).** The SP-4 cross-vector test must demonstrate the guard *symmetrically*: a mutation to the engine's TCJSON_V1 canonicalizer must break verification of CLI-signed output (and vice versa). A test that only checks "CLI output verifies today" does not prove the single-implementation invariant — it must prove a divergence is *detectable*.
- **G-4 (refresh snapshot under lock, SP-9).** `refresh_skill_trust`'s O-2 revocation-vs-installed scan must snapshot installed/active state **under `store._lock`, then release it before any trust-lock work** — never iterate live store state while doing trust-engine work. This preserves the SP-9 leaf-lock discipline (`_MUTATION_LOCK` → `store._lock` → trust lock, one direction) and avoids holding `store._lock` across the trust evaluation.

---

## Review-loop closure — flag-off byte-identity (unqualified)

As of v1.2, RS-7 / SP-1 flag-off byte-identity is **unqualified and true, with no boundary carve-out.** The only capacity-behavior change this PRD introduces (the audit-headroom pre-check) is scoped to REMOTE transactions and gated behind `TORQCLAW_REMOTE_SKILL_SOURCES`, so it can never fire on the purely-local flag-off path; the paired local `revert_activation` fix routes only the revert/restore arm through `_append_audit`'s existing fail-closed capacity check, leaving every local *success* path — including a success at `audit == 999` — byte-for-byte identical to `aa6057b`. No new file under `skill_trust/` is created flag-off (the overflow log, when it exists at all, lives outside that tree and only on the remote path). A fixed flag-off transcript therefore produces byte-identical bytes, order, errors, result shapes, and capacity timing to the baseline — with no earlier-refusal boundary to explain away. The review loop is closed; this is the implementation baseline.
