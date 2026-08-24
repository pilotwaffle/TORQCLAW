# Build Evidence — G1D-FABLE-CHANNELS-AGENT-UX-2026-08-24, Items B and C

## Objective
Ship the operator-gated local-agent enablement affordance (Item B) and the operator-only honest readiness roster (Item C), exactly as re-scoped by the G1D resolution table and bound by G1R obligations 1, 2, 3, 4, 12, 13, 15, 16.

## Scope
- **B(i)** — surfaced the *existing* `UPDATE_AGENT_PROFILE { reconfirmExternalContext: true }` flow in `AgentsPanel.tsx` as a legible "Enable this agent to respond" affordance, plus a "Test connection" action driving the existing `LIST_AGENT_PROVIDERS` readiness path. No contract change for this half.
- **B(ii)** — added the one true missing writer: `SET_LOCAL_AGENT_AUTOSTART { agentPrincipalId, autostart }`, a narrow, `ollama-local`-only, keyed/idempotent/sequenced store command (`CollaborationStore.setLocalAgentAutostart`), server handler (`handleSetLocalAgentAutostart`), and console toggle.
- **Item C** — `AgentsPanel` renders a `configurationReadiness: 'live' | 'parked'` badge per agent, computed server-side in `handleListAgents` via the **exported** `runtimeProfileAllowsAutomaticTurn` (imported read-only from the frozen `autoReplyDispatcher.ts`) — never a re-derived formula. `ChannelMemberEntry`/`listChannelMembers` are untouched (B-4(b): operator-only, no co-member disclosure).
- Contracts, generated schemas (TS + Python mirror), and `authz.ts`'s seat-lattice were updated to match.

## Controlling invariant
An agent's ability to speak in a channel is server-derived, operator-enabled, and honestly disclosed: enablement is an explicit operator action over the wire (never client-inferred, never defaulted on), the roster shows exactly which members can respond, and an agent's own repeated output must never become the context that replaces the operator's question.

Preserved intact: `external_context_confirmed` still has exactly one writer (`upsertAgentPersona`'s reconfirm branch); local `autostart` now has exactly one companion writer (`setLocalAgentAutostart`), which is flatly incapable of touching a subscription profile (rejects `provider_account_id !== 'ollama-local'` inside the transaction, before any mutation). No parallel readiness formula exists — the client badge and the dispatcher's real gate call the identical exported predicate.

## Important disclosure: unreviewed background-agent code found in the working tree, verified and adopted after independent review

Before I began substantive work, a previously-launched research fork (briefed as strictly read-only) crashed mid-session due to a connection error, but had already written a substantial, unauthorized source diff to the working tree (`agentSurface.ts`, `store.ts`, `server.ts`, `authz.ts`, `commands.ts`, generated schemas, `AgentsPanel.tsx` — implementing effectively all of B(ii) and Item C's server/client wiring). I did not treat this as trusted or pre-approved. I:

1. Read every hunk of every touched file via `git diff` before accepting any of it.
2. Verified each hunk against the packet's exact requirements (writer scoping, authz mirroring, predicate reuse, frozen-file boundaries).
3. Ran a full force-cache-bypassed typecheck and build across all 14 workspace packages to confirm it compiled and was internally consistent.
4. Found it materially correct, narrowly scoped, and well-commented with in-line citations to the exact packet obligations — no scope creep beyond B(ii)/C, no secrets, no out-of-boundary edits (its `authz.ts` touch is the correct, necessary N-3 surface re-assertion, not scope creep).
5. Adopted it as the base for my own work rather than discarding correct work or re-deriving it, but I independently authored and ran 100% of the test coverage myself (the crashed fork's self-report claimed it was "writing a test file," but zero test files existed on disk from it — the report of that in-progress action, per the tool's own guidance, was not trusted or reproduced).

This diff was fully re-derivable from the packet text and repo conventions; I verified it line-by-line rather than assuming its correctness, and I am the one accountable for it now that I have built on it, tested it, and reviewed it in this evidence packet.

## What changed

### Contracts
- `packages/contracts/src/commands.ts`: added `SET_LOCAL_AGENT_AUTOSTART { agentPrincipalId: uuid, autostart: boolean, idempotencyKey: uuid }` to the `ClientCommandSchema` discriminated union. No provider/adapter/model fields — deliberately narrower than `UPSERT_AGENT_RUNTIME_PROFILE` so it can never change what an agent runs.
- `packages/contracts/generated/ClientCommand.json`, `engines/hermes_kernel/mcp_wrapper/schemas/ClientCommand.json`: regenerated via `pnpm --filter @torqclaw/contracts build`; verified byte-identical to what the pre-existing diff already contained (deterministic emitter output), and `pnpm --filter @torqclaw/contracts check` confirms both checked-in copies match source of truth.

### Store (`packages/collab/src/store.ts`)
- `setLocalAgentAutostart(caller, { agentPrincipalId, autostart }, idempotencyKey, hasLiveDelegateAuthority)`: follows the exact `withReadThenSequencer → mutex.withLock → runKeyedCommand` discipline used by `upsertAgentPersona`. Inside the transaction: `assertOperatorCaller` + live-delegate-authority recheck + `assertOwnedAgent`, then a fresh read of the target's `provider_account_id`; **rejects with `INVALID_REQUEST` for any non-`ollama-local` profile or a missing profile row**, before any write. The `UPDATE` itself is additionally `WHERE ... AND provider_account_id = 'ollama-local'` as defense-in-depth. Never touches any `external_context_*` column.

### Gateway (`packages/gateway/src/agentSurface.ts`, `server.ts`, `authz.ts`)
- `handleSetLocalAgentAutostart`: mirrors `handleUpdateAgentProfile`'s structure exactly (identity check → store call → error-code mapping).
- `handleListAgents`: each returned agent now carries `configurationReadiness: runtimeProfileAllowsAutomaticTurn(profile ?? null) ? 'live' : 'parked'` — imported directly from `autoReplyDispatcher.ts`, read-only, zero re-derivation.
- `server.ts`: new `case 'SET_LOCAL_AGENT_AUTOSTART'` dispatch arm, identical shape to the `UPDATE_AGENT_PROFILE` arm (feature-flag gate, handler call, terminal-result publish).
- `authz.ts`: `SET_LOCAL_AGENT_AUTOSTART` joins the `CREATE_AGENT`/`UPDATE_AGENT_PROFILE`/`LIST_AGENTS` operator+live-delegate-authority gate in `authorizeOperator`, and joins the `channel`-seat deny arm. `node`-seat is unaffected (falls through the existing default deny).

### Console (`apps/console/src/components/AgentsPanel.tsx`)
- Per-agent card badge: "Live" / "Parked" from `agent.configurationReadiness`, with a `title` attribute stating the honest scope limitation ("configuration readiness only — per-channel conditions ... are not shown here").
- Editor drawer gained an "Enable this agent to respond" section: for local agents, a live-refreshing autostart checkbox wired to `SET_LOCAL_AGENT_AUTOSTART` (applies immediately, no persona save required); for subscription agents, restates the real reconfirm precondition and reuses the existing `reconfirmExternalContext` checkbox/save flow — no new command for that half.
- "Test connection" button re-issues `LIST_AGENT_PROVIDERS` and displays the live provider note.

### Frozen files — confirmed untouched by me
- `packages/gateway/src/autoReplyDispatcher.ts`: `git diff` shows exactly Builder P's two pre-existing hunks (the `selfPrincipalId` argument at the `buildAnchorWindowContext` call site, and the duplicate-suppression insertion before `commitAgentTurnFallbackOutput`). I imported `runtimeProfileAllowsAutomaticTurn` read-only; no additional diff.
- `packages/gateway/src/autoReplyContext.ts`, `packages/collab/src/migration.ts`, `packages/collab/src/autoReply.ts`, `tests/agent-participation-greeting-loop.test.ts`: zero edits by me (diffs present are Builder P's, pre-existing when I started).
- `tests/agent-participation-s4-members.test.ts`: **zero diff** (`git diff --stat` does not list it) — `ChannelMemberEntry`'s key-set stayed byte-identical, confirmed structurally by my own new test too.
- Operator-WIP hunks (`dispatch.ts`, `friendly.ts`+test, `hermesAttempt.ts`+test, `.claude/*`): untouched by me.

## Files changed (by me, directly)
- `packages/contracts/src/commands.ts` (reviewed/adopted)
- `packages/contracts/generated/ClientCommand.json`, `engines/hermes_kernel/mcp_wrapper/schemas/ClientCommand.json` (regenerated, verified deterministic)
- `packages/collab/src/store.ts` (reviewed/adopted `setLocalAgentAutostart`)
- `packages/gateway/src/agentSurface.ts` (reviewed/adopted)
- `packages/gateway/src/server.ts` (reviewed/adopted)
- `packages/gateway/src/authz.ts` (reviewed/adopted)
- `apps/console/src/components/AgentsPanel.tsx` (reviewed/adopted)
- `tests/auth-v2-phase1.test.ts` (authored: updated the pinned `authz.ts` SHA-256 with a new dated authorization comment, following the file's own established pattern, after confirming my `authz.ts` change was the sole cause of drift)
- `tests/collab/agent-local-autostart-writer.test.ts` (new, authored)
- `tests/agent-participation-configuration-readiness.test.ts` (new, authored)

## Tests added/changed
### `tests/collab/agent-local-autostart-writer.test.ts` (new, 6 tests)
1. Flips autostart for an existing `ollama-local` profile idempotently under the keyed-command discipline; replay of the same idempotency key doesn't re-mutate; never touches `external_context_*` columns.
2. Rejects a subscription profile outright, zero mutation.
3. Rejects an agent with no runtime profile row.
4. Denies non-operator caller, revoked live-delegate authority mid-flight, and non-owned target — zero mutation in all three.
5. Idempotency-key reuse against a materially different body conflicts (`IDEMPOTENCY_CONFLICT`).
6. **Deletion-probe (obligation 1 companion)**: greps `store.ts` for every `UPDATE collab_agent_runtime_profiles ... autostart ...` statement, asserts exactly one is equality-scoped to `provider_account_id = 'ollama-local'` (my new writer), and that every inequality-scoped (`<> 'ollama-local'`) statement belongs to `upsertAgentPersona`'s revoke/reconfirm branches — proving the two writers never overlap.

**RED-then-GREEN evidence** (deletion probe caught a real bug in my first draft): my initial regex for "local-scoped" matched the substring `'ollama-local'` anywhere, which also matched the persona-revoke path's `<> 'ollama-local'` clause — the probe correctly failed (`expected length 1, got 4`) until I tightened it to distinguish `=` from `<>`. Re-run after the fix: 6/6 pass.

### `tests/agent-participation-configuration-readiness.test.ts` (new, 13 tests)
- **N-3 companion (3 tests)**: `SET_LOCAL_AGENT_AUTOSTART` requires live operator-role + delegate authority (mirrors `CREATE_AGENT`/`UPDATE_AGENT_PROFILE` exactly); `channel`/`node` seats denied outright; store-side identity recheck (`handleSetLocalAgentAutostart(null, ...)` → `identity_required`, never bypassable from the surface).
- **Obligation 12 (7 tests)**: `runtimeProfileAllowsAutomaticTurn` exercised directly across the full {local, subscription} × {autostart on/off} × {confirmed} × {flag on/off} matrix, including the null-profile case and the stale-binding refusal (obligation 4). One integration test calls the real `handleListAgents` end-to-end (real store, real DB, real `publishCollabSurface`) and asserts its published `configurationReadiness` field agrees, agent-by-agent, with an independent call to the same exported predicate — proof there is no parallel formula.
- **Obligation 13 (1 test)**: `listChannelMembers`' returned member shape is asserted to have exactly the six pre-slice keys (`displayName, kind, principalId, role, since, working`) with explicit negative assertions that `willRespond`/`configurationReadiness`/`autostart` are absent.
- **Obligation 15 (1 test)**: a local agent created with `autostart=false` is proven parked (`runtimeProfileAllowsAutomaticTurn` false); `handleSetLocalAgentAutostart` is called over the real handler+store; the same agent's profile is re-read and proven live, with the underlying `autostart=1` row verified directly. This is harness integration (real store/handler/predicate, not a booted subprocess) per the packet's explicit "(booted or harness integration)" allowance.
- **Obligation 16 (1 test)**: a subscription profile that already holds a full, valid external-context confirmation is still rejected by `setLocalAgentAutostart` exactly like an unconfirmed one — proving the two writers can never overlap even in the hardest case.

**Debugging note (transparency on iteration)**: getting this file green required discovering and fixing two real test-harness gaps, not production bugs: (1) `agentSurface.ts`'s handlers read `getCollabDbForAutoReply()`/`getStore()` directly rather than through the repo's `setCollabSurfaceStoreForTest` seam, which zeroes the module-private `storeDb` by design — I had to additionally spy on both exported functions and wire the real `setCollabSurfaceKindLookupDbForTest` seam so `callerFor`'s kind resolution worked; (2) one test used a non-UUID string as a `sessionId`, which `publishCollabSurface`'s wire-frame Zod validation correctly rejected — fixed by using a UUID. Neither was a defect in the packet's implementation; both are documented in the test file's own comments for future maintainers.

### `tests/auth-v2-phase1.test.ts` (pinned-hash update, 1 assertion changed)
The file's own doc comment mandates: "Recompute and re-authorize deliberately on any future approved change; never delete this pin." My `authz.ts` addition is exactly such a change (G1D-authorized, Item B(ii)/N-3). I added a dated authorization entry in the same style as the prior six entries in this file, and updated the pinned SHA-256 from `e122a277...` to `1239cb15...` (independently recomputed via `sha256(readFileSync('packages/gateway/src/authz.ts'))`, confirmed to match the failing test's own "Received" value before I touched anything — i.e., the drift was proven to originate solely from my authorized diff, not from an unrelated or accidental change).

## Commands run — exact results

```
pnpm --filter @torqclaw/contracts build     → PASS ("[contracts] emitted 8 schemas" x2)
pnpm --filter @torqclaw/contracts check     → PASS ("OK — 8 schemas match source of truth in 2 checked-in dirs")
pnpm --filter @torqclaw/collab build        → PASS (tsc, no errors)
pnpm --filter @torqclaw/gateway build       → PASS (tsc, no errors)
pnpm --filter @torqclaw/console build       → PASS (next build, 4/4 static pages, no type errors)
pnpm typecheck --force                      → PASS (14/14 tasks, cache bypassed, real re-execution)
pnpm reachability                           → PASS ("141 modules reachable from 6 entry points"; only the
                                               3 pre-existing declared-dormant AUTH-005 files, unrelated to this slice)
pnpm lint                                   → honest no-op ("lint not configured — no ESLint in this repo"),
                                               matches tests/lint-gate-honesty.test.ts which passed

npx vitest run tests/collab/agent-local-autostart-writer.test.ts
  tests/agent-participation-configuration-readiness.test.ts
  tests/agents-panel.test.tsx tests/agents-panel-mutation-correlation.test.ts
  tests/agent-participation-s4-members.test.ts tests/agent-participation-s4-presence.test.ts
  tests/collab/agent-runtime-profile.test.ts tests/agent-provisioning-authz.test.ts
                                             → PASS: 8 files, 74/74 tests

npx vitest run tests/ --exclude "tests/failover/**"
                                             → 169/170 files pass, 2555/2557 tests pass, 1 skipped
                                               (exact same single pre-existing failure both before and
                                               after my tests/auth-v2-phase1.test.ts pin fix — see Known
                                               limitations)
```

## Runtime/browser/a11y evidence
This slice is operator-console UI (AgentsPanel toggle, badge, button) plus wire/store logic — no new page, no new route, no routing/approval/cost/security *behavior* change beyond the explicitly scoped authz addition. Evidence gathered:
- `tests/agents-panel.test.tsx` (13/13, pre-existing + unaffected) exercises the panel via `@testing-library/react` with real DOM assertions (`getByRole`, `getByLabelText`, `fireEvent`) — this is real rendered-output proof, not a snapshot.
- The new "Live"/"Parked" badge and "Enable this agent to respond" section use existing Tailwind utility classes matching the surrounding card/dialog markup (`rounded-full`, `text-[10px]`, existing color tokens) — no new CSS framework, no new component library.
- The badge carries a `title` attribute (native browser tooltip) stating the honest scope limitation, satisfying B-5's "label it plainly" requirement without inventing a new disclosure UI pattern.
- The local-autostart checkbox has an explicit `disabled={Boolean(pendingMutation)}` state (no double-submit) and a `<label>`-wrapped `<input type="checkbox">` (native keyboard/focus/screen-reader semantics inherited for free — no custom widget).
- I did not boot the live dev console in a browser for this slice (no operator dev-stack ports were touched, per my explicit boundary); the `next build` succeeding with 0 type errors across 4/4 static pages, combined with the RTL-driven component tests, is the evidence available without touching the running stack on 18790/3000/8000.

## Known limitations
1. **`tests/collab-c1-built-artifact.test.ts` — 1 pre-existing failing test, NOT caused by my Item B/C work.** Builder P's frozen `packages/collab/src/migration.ts` added `AGENT_TURN_RESOLUTION_NOTE_MIGRATION_ID = '20260824_008_agent_turn_resolution_note_v1'` (the `resolution_note` column backing the `duplicate_suppressed` discriminator its own `autoReplyDispatcher.ts` hunk writes). This test pins the exact list of applied migration IDs and needs the same kind of authorized-pin-bump treatment I gave `tests/auth-v2-phase1.test.ts`. I did not fix it because: (a) it requires either editing `migration.ts` (a frozen Builder-P file I was explicitly told never to touch) or editing a test file not named in my task brief and not caused by my diff; (b) I independently verified via `git diff packages/collab/src/migration.ts` that every line contributing to this drift belongs to Builder P's pre-existing hunk, confirmed before I made any edit of my own. **This is a pre-existing gap in the tree I inherited, reported here for G1D/Builder-P attention, not a regression I introduced or am authorized to fix.**
2. Obligation 15 was proven via harness integration (real store + real handler + real exported predicate, in-process), not a booted-subprocess gateway round trip — the packet's own text explicitly allows "(booted or harness integration)" for this obligation, and the existing `tests/agent-participation-s4-*.test.ts` files already carry the booted-gateway-round-trip proof pattern for this same command family, so a second boot fixture would have been redundant coverage rather than new signal.
3. No live browser/screenshot verification of the AgentsPanel UI was performed in this session (the operator's dev stack on 18790/3000/8000 was explicitly off-limits); verification rests on the Next.js production build succeeding, TypeScript strictness, and React Testing Library's real-DOM component tests.

## Deviations from the packet
None in scope or interface. The one procedural deviation is disclosed above: a background research agent's crashed session left a substantial unauthorized source diff in the working tree, which I did not blindly trust — I independently reviewed, verified (via full typecheck/build), and tested every line of it before treating it as part of my own accountable output, and I authored all test coverage myself from scratch.

## Status: READY_FOR_INDEPENDENT_VERIFICATION

The one known test failure (`tests/collab-c1-built-artifact.test.ts`) is pre-existing, out of my file scope, and fully diagnosed with its exact root cause and fix path identified (a migration-list pin bump in a file I am not authorized to touch). It should not block independent verification of Items B and C, but must be flagged to whoever owns Builder P's `migration.ts` slice or to G1D for disposition before this branch ships.
