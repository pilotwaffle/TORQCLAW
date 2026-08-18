# G2A Final Audit — PRD-TCLAW-AGENT-PARTICIPATION-007 S2 (agent collab MCP tools)

**Seat:** G2A final verifier.
**Model:** `claude-opus-4-8`. CLAUDE.md §2 names Claude Opus 4.8 for this seat and I *am* Opus 4.8 — **no substitution applies.**
**Scope:** `fba9738..7c0a4af` — `d1abe09` (the slice), `facf19b` (load-bearing-ternary doc), `7c0a4af` (V-S2-1 fix + G1R verdict).
**G1R verdict read:** `docs/prd-reviews/VERIFY-OPUS-AGENT-PARTICIPATION-S2.md` (APPROVE WITH CONDITIONS, blocker V-S2-1 fixed in `7c0a4af`). Not deferred to — every load-bearing claim re-verified by my own execution.
**Date:** 2026-08-18. **Method:** the main tree was dirty with the concurrent S3 builder's WIP, so all gates and probes ran in a **clean worktree at `7c0a4af`** (`.g2a-s2-wt`, removed afterward). Three mutation probes with rebuilds; every mutation restored and confirmed gone from `dist`.

---

## VERDICT: **APPROVE WITH CONDITIONS**

S2 earns it. The mechanism is right: one registration path and one dispatch path, genuinely shared with remote servers; the identity channel resists spoofing; error opacity holds; totality holds; the V-S2-1 fix is truthful and pinned. Two conditions, both about pins rather than behavior — on this slice more than any before it, because this is the first surface where a non-human writes to a shared substrate with no approval gate, and both unpinned guards become **live the moment S3 (building concurrently right now) supplies a trigger.**

---

## What I verified by execution (not read)

**Probe A — V-S2-1 fix is pinned.** Removed the `collab_write` classifier arm (`profilePolicy.ts:66-68`), rebuilt bridge:
```
FAIL … V-S2-1 REGRESSION: read_only admits a substrate-MUTATING tool. …
  expected [ 'collab__post_message', …(1) ] to not include 'collab__post_message'
Tests  1 failed | 12 passed (13)
```
Verbatim the commit's recorded RED. The positive control (`read_channel` still admitted, still `'none'`) shares the test. Restored; dist confirmed re-corrected (`grep -c collab_write` = 1).

**Probe B — the one G1R and the builder both missed: the `_meta` spoof-resistance is pinned by NO test.** I mutated `executeTool` (`registry.ts:331`) so a model-supplied `args._meta` **overrides** the verified caller identity — the exact privilege-escalation shape S1 exists to prevent:
```
...(callerCollabPrincipalId
  ? { _meta: { [COLLAB_CALLER_META_KEY]: (args as any)?._meta?.[COLLAB_CALLER_META_KEY] ?? callerCollabPrincipalId } }
  : {}),
```
Rebuilt; full S2 suite: **13/13 GREEN.** G1R's spoof probes (S-1/S-2/S-3, including the non-member-claims-member escalation) were scratch probes, correctly executed and never committed — grep confirms zero `_meta` references in either S2 test file. The protection is real today (see the trace below) but a future refactor of one line reopens a client-settable caller identity with a fully green suite. This is instance **eight** of the program's pattern, and the first one that is an identity-spoofing hole. Latent only because no production trigger exists; S3 creates one. **C-S2-1 (condition): commit G1R's S-2 probe as a permanent test** — outsider caller id + `args._meta` claiming a member's id → `COLLAB_NOT_FOUND`, zero rows.

**Probe C — B-2's compile-time layer is real.** Widened the transport union with an `in-process` member:
```
packages/bridge/src/serverConfig.ts(106,64): error TS2339: Property 'url' does not exist …
packages/bridge/src/serverConfig.ts(106,88): error TS2339: Property 'token' does not exist …
```
Exact lines G1R recorded. `facf19b`'s "load-bearing ternary" claim is true, not aspirational. Restored; bridge tsc clean.

## The `_meta` identity channel — sound today (independently traced)

Every hop re-verified against committed source: no `ClientCommand` variant carries an identity field; zod strips unknowns (no `passthrough`/`catchall` anywhere in contracts); `enrichCommand` builds the payload from its own 4th parameter, fed only by `server.ts`'s connection-scoped `agentCollabPrincipalId ?? undefined`; `executeTool` attaches `_meta` as a **sibling** of `arguments`, so `args._meta` cannot collide with it; the handlers (`collabAgentTools.ts:112`) treat absent/empty as `COLLAB_IDENTITY_REQUIRED` and refuse. `preview.ts` passes 3 args; the re-mint path spreads only gateway-built, re-validated stored requests. **Unspoofable as written — and unpinned (Probe B).**

## The `collab_write` classifier — my ruling on its shape

The fix's core decision is right: keyed on name+namespace, **not** capability (capability is the overloaded field; reusing it rebuilds the bug), sitting first ahead of the capability short-circuits, and `'collab_write'` listed in no profile so posting is excluded everywhere while the speech ruling (`requiresApproval` via `capability: 'read'`) stands untouched. Adding the enum member breaks no frozen contract — I grep-verified every `SideEffectClass` consumer (all inside `profilePolicy.ts`/`profile.ts`; no exhaustive switch; the profile-conformance suites don't enumerate the values) and the conformance gates pass.

**One directional weakness, non-blocking (NB-S2-1):** the arm `/post|write|send|create|delete|update/i` fails **open** for a *future* collab write tool whose name avoids those verbs — e.g. an S6 `ack_cursor` or a `react`/`pin` tool carrying `capability: 'read'` under the speech precedent would short-circuit to `'none'` and re-enter `read_only`, reincarnating V-S2-1. The fail-closed shape inverts the test: within the `collab` namespace, return `'collab_write'` *unless* the name matches a read-verb allowlist (`read|list|get`). Today both real tools classify correctly either way, so this is a hardening recommendation for the next collab tool, not a defect in this slice.

## Ruling on the runaway-poster residual — I agree with G1R, and I verified its premise

**"No production trigger" holds, verified by my own trace:** `executeTool`'s only production caller is `ollama.ts:394`, forwarding `req.payload.callerCollabPrincipalId`; that field is set only by `enrichCommand`, fed only by `server.ts:414`'s `agentCollabPrincipalId`, which is null on every connection that can reach `SUBMIT_PROMPT` (authz denies it to `node`, the only agent-holdable seat). grep confirms no other setter. The residual is genuinely theoretical today.

**Ruling: ship S2 as-is; adopt G1R's condition as binding on S3** — auto-reply must not ship until STOP (R-3a) or a per-principal post-rate bound exists. The operator's turn-cap ruling (R-2) is a cost control; this is an abuse control, so R-2 does not pre-empt it. Agreed without reservation — and note C-S2-1 makes the same S3 boundary load-bearing twice: S3 must not land with an unpinned identity channel AND no rate bound.

## The rest of the checklist

- **Error opacity (protection 6):** holds. `mapStoreErrorToToolErrorText` emits `COLLAB_NOT_FOUND: <substrate's own message>` unelaborated, byte-matching the wire surface's arm; unclassified throws collapse to bare `COLLAB_UNAVAILABLE`. G1R's live evidence (identical strings for hidden vs nonexistent, neither containing "member") is consistent with the code I read.
- **A6/T-9 totality:** holds. Both handlers catch every store throw and return `isError: true`; the mapping's `default:` arm handles non-`Error` throws; `executeTool` converts `isError` into a thrown `Error` that ollama's existing try already handles; the MCP SDK validates schema violations pre-handler (`-32602`). The dual byte bound (16,384 newlines) is enforced server-side and correctly stated as not JSON-Schema-expressible. I found no admitted input that throws.
- **Falsifiability sweep:** G1R's per-test table is accurate. Its two flagged weak tests are weak as described (a matcher-less `.rejects.toThrow()`; the B-2 string-search half) — both backed by stronger coverage elsewhere. **No test drives a replica** — all S2 tests import built dist artifacts; B-S0-1 is not repeated. To G1R's two weak tests I add Probe B's finding, which is worse than weak: absent.
- **N-S2-4 confirmed:** `toolFilter.ts:29-34`'s comment claims "a source-level test pins that this literal matches the gateway-side constant" — **no such test exists** (grep-verified). Drift direction is fail-noisy-not-fail-open (diverged literals make collab tools visible to identity-less tasks, which the handler then refuses), but the claimed pin is fictional. Add the one-line equality test or fix the comment.
- G1R's N-S2-1/2/3 (comment typo, self-contradicting comment, unmeasured TOOL_COUNT_OVERFLOW claim) verified as stated; all minor.

## Gate results — all my own runs, clean worktree at `7c0a4af`

| gate | result |
|---|---|
| `pnpm build` | PASS — 8/8 (dist freshness independently verified by grep after a FULL TURBO cache hit) |
| Named 7-file set (S2 ×2, S1, collab-surface-post, profile-conformance ×3) | PASS — **87/87** |
| `npx vitest run` (full suite) | 2195 passed / 23 skipped / 3 failed + 7 file-level failures — **all environmental**: the 7 collab built-artifact files hit the shared gateway-build-lock ETIMEDOUT under cold full-suite contention (G1R documented the same) and pass **22/22 on warm re-run**; the 3 `tests/failover/*` are Python-ledger timeouts, an artifact the fresh worktree lacks (same class passes in the main repo). **Zero failures attributable to this range.** |
| `tsc --noEmit` bridge / gateway / contracts / inference | PASS ×4 (exit 0) |
| `pnpm reachability` | PASS |
| `git diff --stat fba9738..7c0a4af` | 19 files, 1663+/54-, all in scope |

## Tree state afterward

Worktree probes all restored (`git status` clean on `packages/`), dist rebuilt and grep-verified correct, worktree removed. Main tree untouched (the S3 builder's WIP preserved). This verdict is the only file created.

---

**Bottom line:** the slice that hands an autonomous agent an ungated pen is, as built, careful — one dispatch path, server-stamped identity, opaque errors, total handlers, and an honest residual. Approve with two pins owed before S3 makes them load-bearing: **C-S2-1** (commit the spoof probe — today the identity channel is protected by code nobody can break-test) and G1R's S3 rate/STOP condition, which I adopt. Plus NB-S2-1 (invert the classifier to fail-closed) and the N-S2-4 fictional drift-guard, both cheap.
