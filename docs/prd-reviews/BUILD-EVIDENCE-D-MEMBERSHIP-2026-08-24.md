# Builder Evidence Packet — Item D: Curated Channel Membership

**Builder seat:** Claude Sonnet 5 (claude-sonnet-5). **Branch:** `phase1-server-owned-authority`. **Contract:** `docs/prd-reviews/G1D-FABLE-CHANNELS-AGENT-UX-2026-08-24.md`, "Amendment 1 (Item D: curated membership)" + delta-G1R disposition (ND-1..ND-6, T-D1..T-D10).

## Objective

Ship the operator-only wire surface (`ADD_CHANNEL_MEMBER` / `REMOVE_CHANNEL_MEMBER`) and console UI that let the operator curate which agents are in a channel, calling through — never duplicating — the already-built, already-tested store internals.

## Scope

Contracts (`packages/contracts/src/commands.ts`) + thin collabSurface handlers (`packages/gateway/src/collabSurface.ts`) + authz named arms in both blocks (`packages/gateway/src/authz.ts`) + dispatch wiring (`packages/gateway/src/server.ts`) + console Members UI (`apps/console/src/components/ChannelsPanel.tsx`) + tests (new file + two authorized pin-bumps + two pre-existing regression-test disclosures forced by the new UI surface). `store.ts` and `autoReplyDispatcher.ts` are frozen/read-only for this slice.

## Controlling invariant

An agent's channel membership is an explicit, operator-only, wire-level action, re-asserted by the store's own transaction (never inferred, never widened by a missing authz arm); membership alone never implies an agent can speak (autostart + a live binding are still required — ND-6); and the co-member-visible payload never gains a new field.

## What changed

1. **Contracts** — added `ADD_CHANNEL_MEMBER { channelId, agentPrincipalId, idempotencyKey }` and `REMOVE_CHANNEL_MEMBER { channelId, agentPrincipalId, idempotencyKey }` to `ClientCommandSchema`. Regenerated both generated JSON Schema copies via `pnpm --filter @torqclaw/contracts build`; verified deterministic via `pnpm --filter @torqclaw/contracts check`.
2. **collabSurface.ts** — `handleAddChannelMember` / `handleRemoveChannelMember`: thin, call-only wraps of `store.addChannelMember` / `store.removeChannelMember` (store.ts:2037-2183 / :2185-2305, untouched). Zero new business logic; error mapping mirrors `handleSetChannelExternalExportPolicy`'s existing pattern (IDEMPOTENCY_CONFLICT / INVALID_REQUEST / COLLAB_NOT_FOUND / CHANNEL_ARCHIVED → the matching `CollabSurfaceError`, everything else → `COLLAB_UNAVAILABLE`).
3. **authz.ts** — named arms for both commands added to BOTH gates: the non-operator explicit-deny switch (~line 273-274, grouped with the other agent-mutation denies) and `authorizeOperator`'s delegate-gated block (~line 344-345, joining `CREATE_AGENT`/`UPDATE_AGENT_PROFILE`/`LIST_AGENTS`/`SET_LOCAL_AGENT_AUTOSTART`). This closes the ND-4 fail-open hazard: `authorizeOperator`'s own tail (`return ALLOW;` once a surface is present and no earlier arm matched) would otherwise have silently authorized these two commands for ANY operator surface, delegate authority or not.
4. **server.ts** — dispatch cases for both commands: gate on `collabSurfaceCommandsEnabled()`, call the collabSurface handler, and on success re-run `handleListChannelMembers` so the console's roster refreshes without a manual re-select (matches `SET_CHANNEL_EXTERNAL_EXPORT_POLICY`'s existing pattern of a follow-up read after a successful write).
5. **ChannelsPanel.tsx** — Members section gains an operator-only "Add agent…" picker (candidates = `LIST_AGENTS` roster minus current `LIST_CHANNEL_MEMBERS` members, ND-3: UI-cosmetic exclusion, correctness rests on the store's own idempotency) and a per-row remove button on agent (non-owner) rows only. `LIST_AGENTS` is requested once at mount, alongside the existing `LIST_CHANNELS` call. The `ServerChannelMemberEntry` payload shape is UNCHANGED — still exactly `{principalId, displayName, role, kind, working, since}` (B-4/D-6). A one-line ND-6 disclosure sentence ("Membership puts an agent in the room — it still needs autostart enabled to speak.") ships under the Members heading. The "Working now (agents)" and "This console's task" presence sections remain 100% dispatch-free, unchanged.

## Files changed

- `packages/contracts/src/commands.ts` — new command shapes
- `packages/contracts/generated/ClientCommand.json` — regenerated (deterministic build output)
- `engines/hermes_kernel/mcp_wrapper/schemas/ClientCommand.json` — regenerated (deterministic build output)
- `packages/gateway/src/collabSurface.ts` — `handleAddChannelMember`, `handleRemoveChannelMember`
- `packages/gateway/src/authz.ts` — named arms in both blocks
- `packages/gateway/src/server.ts` — dispatch wiring, import list
- `apps/console/src/components/ChannelsPanel.tsx` — picker, remove affordance, `LIST_AGENTS` mount dispatch, `RosterSection` DOM restructure (see Deviations)
- `tests/collab-channel-membership-wire.test.ts` — **new**, T-D1..T-D10
- `tests/collab-c1-built-artifact.test.ts` — authorized pin-bump (migration count 13→14, migration id list)
- `tests/auth-v2-phase1.test.ts` — authorized pin-bump (authz.ts SHA-256, `1239cb15...` → `206a9abf...`)
- `tests/channels-panel.test.tsx` — authorized disclosure updates (mount-dispatch count, allowlists, flag-off expectation) forced by the new `LIST_AGENTS` mount call
- `tests/channels-panel-members.test.tsx` — authorized disclosure update (T-11 boundary narrowed to "zero controls except one remove-button per agent member")

Untouched (frozen, verified below): `packages/collab/src/store.ts`, `packages/gateway/src/autoReplyDispatcher.ts`.

## RED → GREEN evidence

**The fail-open authz defect (ND-4).** `authorizeOperator`'s own unconditional tail is `return ALLOW;`, reached by any command not matched by an earlier named arm once a surface is present. Before this slice's named arms existed, `ADD_CHANNEL_MEMBER`/`REMOVE_CHANNEL_MEMBER` did not exist as commands at all — so the historical exposure window is nil — but the STRUCTURAL hazard (a future command landing in the contract union with no authz.ts arm silently inherits blanket operator ALLOW regardless of delegate authority) is real and is exactly what ND-4 flags. `tests/collab-channel-membership-wire.test.ts`'s `T-D5` suite proves this two ways:
- A minimal literal reproduction of the pre-slice `authorizeOperator` tail shape (`preSliceStyleFailOpenTail`) demonstrates the defect directly: a `delegate:false` caller with no named arm is wrongly allowed (RED, `ok: true`).
- The REAL, current `authorize()` with this slice's named arm denies the identical `delegate:false` caller (GREEN, `ok: false`) — the two results are asserted to diverge, proving the named arm — not test construction — is what closes the hole.
- Additional GREEN-only coverage: operator+delegate → ALLOW; operator role without delegate → DENY (not fail-open ALLOW); `surface:false` (no live surface object) → DENY (not the legacy blanket ALLOW other surface-less commands correctly get); `channel`/`node` seats → DENY via the NAMED explicit-deny arm, not a bare default fallthrough.

## Commands run — exact results

```
pnpm --filter @torqclaw/contracts build
  → [contracts] emitted 8 schemas -> generated/, engines/hermes_kernel/mcp_wrapper/schemas/

pnpm --filter @torqclaw/contracts check
  → [contracts:check] OK — 8 schemas match source of truth in 2 checked-in dirs.

pnpm --filter @torqclaw/collab --filter @torqclaw/gateway --filter @torqclaw/console build
  → packages/collab build: Done
  → packages/gateway build: Done
  → apps/console build: ✓ Compiled successfully, ✓ types valid, ✓ 4/4 static pages

pnpm typecheck  (turbo run typecheck, 9 packages)
  → Tasks: 14 successful, 14 total

npx vitest run tests/collab-channel-membership-wire.test.ts
  → 19 passed (19)  [new T-D1..T-D10 suite]

npx vitest run tests/collab-c1-built-artifact.test.ts
  → 4 passed (4)   [pin-bump verified GREEN: "C1_ARTIFACT_SELF_MIGRATED collab=14 migrations"]

npx vitest run tests/auth-v2-phase1.test.ts
  → 49 passed (49)  [pin-bump verified GREEN]

npx vitest run tests/agent-participation-a3c.test.ts tests/agent-participation-cron.test.ts
  tests/agent-participation-failed-no-coalesce.test.ts tests/agent-participation-s3.test.ts
  tests/agent-participation-s4-members.test.ts tests/agent-participation-s4-presence.test.ts
  tests/agent-participation-greeting-loop.test.ts tests/agent-participation-configuration-readiness.test.ts
  tests/collab/agent-local-autostart-writer.test.ts tests/agent-provisioning-authz.test.ts
  tests/authz.test.ts tests/collab/store-channels.test.ts
  → 12 files, 169 passed (169)  [named regression set — zero regressions]

npx vitest run tests/channels-panel.test.tsx tests/channels-panel-members.test.tsx
  → 2 files, 91 passed (91)  [after DOM-structure fix + authorized disclosures]

npx vitest run tests/ --exclude "tests/failover/**"  (full suite)
  First run:  2 files failed, 9 tests failed | 169 passed of 2576  (channels-panel.test.tsx ×5,
              channels-panel-members.test.tsx ×4 — all traced to Item D's new dispatch/DOM
              surface, fixed as described below)
  Final run:  1 file failed, 1 test failed | 2574 passed, 1 skipped of 2576
              (tests/collab/bootstrap-recovery.test.ts, "fails cleanly with corrupted
              ciphertext" — 5000ms timeout under full-suite CPU load; re-ran in isolation:
              28/28 PASS in 4.15s, including that exact test. Unrelated file — Argon2id/scrypt
              KDF recovery-kit round-trip, zero relation to channels/membership/authz/contracts.
              Zero edits by this Builder to bootstrap/secrets/recovery code. Load-induced flake,
              not a regression from this slice.)
```

## Deviations from the packet (all disclosed, all authorized-in-place per the packet's own §7 bounded-extras convention)

1. **`ChannelsPanel.tsx` `RosterSection` DOM restructure.** My first pass wrapped the `<h3>Members</h3>` heading in a new flex-layout `<div>` alongside the picker button, which changed what `rosterHeading.parentElement` resolves to in `tests/channels-panel-members.test.tsx` and `tests/channels-panel.test.tsx` — those pre-existing tests scope their assertions via `.parentElement`/`.closest('div')` traversal from the "Members" heading, assuming it is a direct sibling of the member list. Fixed by keeping `<h3>` a direct child of the SAME div that contains the member list, and positioning the picker with `absolute` instead of a flex-sibling wrapper. A code comment now flags this DOM-structure dependency for future maintainers. No test was weakened — this is a pure implementation fix once the real DOM shape was understood.
2. **Pre-existing test disclosures forced by the new UI surface** (all through the repo's own "dated authorization comment, never a weakened assertion" convention, matching the style already used in `tests/auth-v2-phase1.test.ts` and `tests/collab-c1-built-artifact.test.ts`):
   - `tests/channels-panel.test.tsx`: mount-dispatch test updated from "exactly once, `LIST_CHANNELS`" to "exactly twice, `LIST_CHANNELS` + `LIST_AGENTS`" (same mount effect, order preserved). `READ_ONLY_ALLOWLIST`, `S6_ALLOWLIST`, `S6_FULL_ALLOWLIST` widened to admit `LIST_AGENTS` (`S3_ALLOWLIST` intentionally left unwidened — every test using it clears the mock after mount, before asserting). The flag-off-equivalent test's expected action array widened from `['LIST_CHANNELS']` to `['LIST_CHANNELS', 'LIST_AGENTS']`.
   - `tests/channels-panel-members.test.tsx`: the T-11 "zero buttons anywhere in the Members section" test renamed and narrowed to its correct, packet-authorized boundary — exactly one remove control per agent member row, zero for the owner row, zero links — with an explicit accessible-name assertion (`Remove Botty`) so the control identity is pinned, not just its count.
3. **Item 7 (bounded extra, pre-authorized):** confirmed via `git diff master -- packages/collab/src/migration.ts` that `AGENT_TURN_RESOLUTION_NOTE_MIGRATION_ID` (`20260824_008_agent_turn_resolution_note_v1`) is the sole new migration on this branch (the whole file is a 527-line addition relative to master, entirely Builder P's prior work; this ID is the newest entry). Updated both pinned assertions in `tests/collab-c1-built-artifact.test.ts` (the ordered id array, and the post-reboot row-count check, 13→14) with a dated authorization comment, per that file's existing convention. Never weakened to a subset/contains check.
4. **Item 8 (bounded extra, pre-authorized):** confirmed via `git diff master -- packages/gateway/src/authz.ts` that every hunk except my two additions (the `ADD_CHANNEL_MEMBER`/`REMOVE_CHANNEL_MEMBER` case arm in the non-operator switch, and the `authorizeOperator` join) was already present and already covered by a dated authorization comment in `tests/auth-v2-phase1.test.ts` (the most recent being 2026-08-24 Item B(ii)/SET_LOCAL_AGENT_AUTOSTART). Recomputed the SHA-256 and added a new dated comment documenting my delta specifically.

## Prohibited-scope compliance (verified, not assumed)

- **`autoReplyDispatcher.ts`:** zero edits by this Builder (never called Edit/Write on this file this session). `git diff master -- packages/gateway/src/autoReplyDispatcher.ts | grep -i "ADD_CHANNEL_MEMBER\|REMOVE_CHANNEL_MEMBER"` → no matches. `tests/collab-channel-membership-wire.test.ts`'s `T-D8` suite additionally asserts structurally that neither new handler's function body references `autoReplyDispatcher`/`triggerAutoReply`, and that the dispatcher file itself contains no reference to either new command name.
- **`store.ts`:** zero edits by this Builder (never called Edit/Write on this file this session; every interaction was a Read). `git diff master -- packages/collab/src/store.ts | grep -i "ADD_CHANNEL_MEMBER\|REMOVE_CHANNEL_MEMBER"` → no matches (the pre-existing diff against master is entirely Builder P/Q's Item A/B work — `addChannelMember`/`removeChannelMember` themselves were already built and are called, never modified, by this slice).
- **No git commit/add/checkout/restore** performed at any point this session.
- **No member-payload field added** — `ServerChannelMemberEntry` interface in `ChannelsPanel.tsx` is byte-identical to before this slice; `T-D6` in the new test file re-asserts the exact key-set `{principalId, displayName, role, kind, working, since}` against a live store round trip after an `ADD_CHANNEL_MEMBER` wire call.
- **No untracked operator files touched** (`.claude/agents/*`, `ops/skill-staging/`, `docs/BLUEPRINT-*`, `docs/PRD-TORQ-ARCHITECTURE-*`, `docs/clawed.jpg`, root `build-evidence.md`) — confirmed absent from this Builder's edit list above.

## Known limitations

- The one remaining full-suite failure (`tests/collab/bootstrap-recovery.test.ts`, KDF timeout) is a pre-existing, load-induced flake unrelated to this slice's scope, confirmed non-reproducing in isolation (28/28 PASS). Flagging per verification discipline rather than silently omitting it — this Builder did not fix or suppress it, since it is out of Item D's scope and store.ts/secrets code is frozen for this slice.
- The console's "Add agent…" picker exclusion (ND-3) is client-side/UI-cosmetic; a stale `LIST_AGENTS` snapshot could theoretically offer an already-member agent, but the store's own same-state idempotency (store.ts:2085-2094, untouched, pre-existing) makes that harmless — a double-add is a no-op, never a duplicate row.
- No new e2e/browser verification was run beyond the Vitest/jsdom component tests above (`@vitest-environment jsdom`); a live browser walkthrough of the picker/remove UI was not performed as part of this evidence packet.

## Status

**READY_FOR_INDEPENDENT_VERIFICATION**
