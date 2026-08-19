# G1R INDEPENDENT VERIFICATION — PRD-TCLAW-COLLAB-PRESENCE-UI-005 · Slice S5 (agent co-presence / roster)

**Seat:** G1R — independent verifier / design reviewer
**Model disclosure:** the routing profile names **Opus 5** for this seat and the model filling it **is `claude-opus-5`**. **No substitution.**
**Repo:** `E:\TorqClaw` · branch `phase1-server-owned-authority` · HEAD `86d3914`
**Target:** UNCOMMITTED working-tree changes — `apps/console/src/components/ChannelsPanel.tsx`, `tests/channels-panel.test.tsx`, `tests/collab-presence-a5-zero-writes.test.ts` (new/untracked)
**Method:** fresh thread, no authoring context. Findings below are from **execution and mutation probes**, not inspection.
**Date:** 2026-08-17

---

## VERDICT: **REJECT — 1 blocking (B-1), 2 non-blocking**

The slice's *engineering* is unusually good and its tests are **genuinely falsifiable** — I proved four of them RED by mutation. The build is rejected on a single defect, and it is precisely the failure mode this program keeps producing:

> **B-1 — the A5 zero-writes proof is VACUOUS.** It counts rows in a `:memory:` database that no production code path can ever write to. I constructed a real mirroring write into the **production** collab DB during the lifecycle and **A5 stayed green.**

A5 is described in the PRD as the *spine* of S5's "presence only, read-side only" claim. A spine that cannot break is not a spine. Everything else here — including the escalated identity question — resolves in the builder's favour.

---

## 1. THE IDENTITY RULING (the escalated decision)

**Choice: (c), with a mandatory (b) follow-on filed and NOT built in this slice.**

The builder escalated correctly, and the builder's *engineering* judgment — do not unilaterally add `principalId` to a disclosure-sensitive frame — was **right**. But the conclusion drawn from it (ship the structural enforcement as final, document the limitation in a code comment) is **not** sufficient, because the limitation is documented *only where users never look*.

### 1.1 The confirmed substrate fact

Independently verified, not taken from the brief:

- `GatewayEventSchema` (`packages/contracts/src/events.ts:19-29`) has fields `seq, id, requestId, sessionId, tier, type, message, metadata, timestamp`. **No `principalId`, no `agentId`.**
- The CONNECTED frame (`packages/gateway/src/server.ts:282-288`) sends `metadata: { sessionId, resumed }` and nothing else. Confirmed *empirically* by the live wire transcript printed by `tests/collab-c1-flag-off-identity.test.ts`:
  `"type":"CONNECTED" ... "metadata":{"sessionId":"<SESSION_ID>","resumed":false}`
- Each socket subscribes only its own session's bus (`server.ts:273`, `sessionBus.subscribe(sessionId, …)`).

**Therefore `selectWorkingNow(events)` can only ever surface the console's OWN session's task.** The builder's own module doc states this accurately. The premise in the brief is correct.

### 1.2 Why (a) fails

§4 S5 says "**the roster shows working agents**" (plural, third-party). What ships renders *at most one row — always and only the viewer's own task*. That is not a partial implementation of the specified feature; it is a **different feature** (a self-liveness indicator) rendered under a label that reads as a roster. §2 forbids the surface from rendering anything not sourced from the wire; it does not, on its own, forbid a *label* that implies more than the data supports — but §14 T-12's no-fabrication principle and §2's "never a fabricated state" intent plainly do. A9's mandate is "two separately-labeled sections"; the labels must also be *honest about what they contain*.

### 1.3 Why (b) is not this slice's work — and its disclosure analysis

A `principalId` broadcast is the right *eventual* shape, but it is a wire-shape change to a disclosure-sensitive frame and must go through its own gate. Recorded here so the follow-on starts from analysis rather than reinventing it:

**Who learns what about whom (S5b disclosure analysis):**

1. **Self-disclosure (safe, and the actual near-term need).** Broadcasting *the connection's own* resolved `principalId` on its own CONNECTED frame discloses to a subject only a fact about **itself**. Under §2a's controlling invariant — "a surface renders only what its authenticated subject may see" — a subject is always entitled to its own identity. This is the minimal change, it carries **no third-party disclosure**, and it is sufficient to let the console *label* its own "working now" row correctly and to identity-match that row against the Members list. **This is what S5b should be scoped to.**
2. **Third-party presence (NOT authorized by this analysis).** Showing *other* principals' tasks requires a cross-session task registry that does not exist, and it crosses the two-lattice rule: the **gateway seat** gates the command *class*, while the **substrate subject** is the connection's resolved collab principal. A task registry is *gateway* truth keyed by `sessionId`; channel membership is *substrate* truth keyed by `principal_id`. Joining them to answer "which channel members are working" would let a channel member infer another principal's **execution activity** — telemetry that membership alone never entitled anyone to. §4 S5 already CUT the v0.1 mirroring design partly for exactly this reason ("a telemetry-to-members disclosure path"). Any future third-party presence therefore needs its **own** entitlement rule, not an incidental join.
3. **Correlation risk to note for S5b:** even self-only `principalId` on the wire means a compromised/logged client transcript now ties a `sessionId` to a stable `principal_id`. That is acceptable (the subject already holds both), but it should be a conscious call, and `principal_id` values are peppered hashes — S5b must not accidentally publish anything that widens beyond the subject's own row.

### 1.4 What is REQUIRED to clear (c)

The UI must stop implying a multi-agent roster it cannot populate. **The minimal, honest fix is a label change — no new wire data needed:**

- Rename the section from **"Working now"** to something scoped to the subject, e.g. **"This console's task"** / **"Your session"**, or
- Retain the heading and add a visible caption in the same honest register the builder already used for Members — e.g. *"this session only — other agents' work is not on the wire yet"*.

The empty state must match: **"Nothing running right now."** currently reads as *nobody anywhere is working*, which is an assertion the console cannot make. It should read as *this session* is idle.

**Precedent the builder should have followed and already knew:** §16 records that `PresenceCard`'s own docstring says it is honest presence for *"the ONE agent the console watches … there is no roster here to populate."* S5 renders the same single-agent truth but drops that honesty from the label.

### 1.5 Is A9 vacuous?

**No — but it is weaker than it reads, and the verdict file should say so.**

A9's clause "a fixture with a working non-member proves presence never implies membership" is **not** vacuous as *implemented*, because the property it pins is a **render-independence** property, and that property is real and mutable: the test (`tests/channels-panel.test.tsx:1247-1276`) proves the "working now" section renders **in full while Members is real-empty**, i.e. neither section filters or gates the other. A future refactor that made the roster render `members.filter(m => m.principalId === workingNow.principalId)` would break it. That is a genuine invariant with a genuine failure mode.

What *is* misleading is the PRD's wording. Because no other principal's presence can ever appear, the fixture's "working non-member" is **necessarily** a non-member — the test cannot distinguish "the code correctly refuses to imply membership" from "the code has no identity to compare in the first place." The property is proven **structurally rather than semantically**. That is worth recording explicitly so a later reader does not over-credit A9 as an identity-join guarantee. **Non-blocking (NB-1); fix by amending A9's wording when S5b lands.**

---

## 2. BLOCKER

### B-1 — A5's zero-writes proof is VACUOUS: it counts a database no production path can write to

**Severity: BLOCKING.** A5 is the stated spine of S5's central safety claim.

**What the test does.** `tests/collab-presence-a5-zero-writes.test.ts` counts `collab_events` rows in `freshCollabStore()` — `new Database(':memory:')` (line 102), a brand-new in-memory handle created inside the test — before and after driving a real gateway task lifecycle. The lifecycle side is genuinely real (`taskStore.create` / `makeEmitter` / `taskStore.complete`), and the file's header correctly notes the gateway's `storage.ts` never references `collab.db`.

**Why it proves nothing.** The counted handle is a **private in-memory DB local to the test**. It is not the database any mirroring write would target. Production opens the collab DB through `collabIdentity.ts:148`:

```
const path = process.env.TORQCLAW_COLLAB_DB_PATH || join(DATA_DIR, 'collab.db');
```

— a **file on disk**, shared via `getCollabDb()` with `collabSurface.ts`'s `getStore()` (`collabSurface.ts:108-124`). A regression that mirrored task lifecycle into channels would call `store.postChannelMessage(...)` on **that** store and write to **that** file. The test's `:memory:` handle would remain at 0 rows regardless. **The assertion is unfalsifiable by construction.**

**Executed proof (this is the finding, not a hypothesis).** I injected a v0.1-style mirroring write into the RUN phase of the green test — targeting the **production** collab DB via `getCollabDb()`, with the real `collab_events` schema (`migration.ts:109-124`):

```
G1R PROBE: mirroring write to PRODUCTION collab db SUCCEEDED; prod rows now = 1
Test Files  1 passed (1)
      Tests  3 passed (3)
```

**A real mirroring write landed a row in the production collab database and A5 reported GREEN.** This is exactly the "green with and without the guard" pattern that hid V-1.

**Why the existing FALSIFIABILITY test does not rescue it.** The third test (lines 185-205) *does* perform a real `postChannelMessage` and *does* observe the count rise — but it does so against a **different store instance** (`bootstrappedCollabHarness`, its own `freshCollabStore()`), not the handle the zero-writes tests count, and **not** the production handle. It proves "row counting works on a SQLite DB," which was never in doubt. It does **not** prove the zero-writes assertion is wired to the DB under threat.

**Failure scenario.** A future slice (or a revived v0.1 narrative-mirroring design) adds a `postChannelMessage` call into the dispatch/terminal path. It writes to the real `collab.db`, creating exactly the second uncorrectable source of task-state truth §4 S5 CUT — with the telemetry-to-members disclosure path that cut was partly about. **The A5 suite stays green and the PRD's spine criterion reports satisfied.**

**Suggested fix.** Point the assertion at the handle production actually uses:
- Set `TORQCLAW_COLLAB_DB_PATH` into the test's temp dir, drive the lifecycle, then count `collab_events` **through `getCollabDb()`** (or by opening that same file path). The gateway's own module resolves it lazily, so the same `TORQCLAW_DATA_DIR`-before-import discipline the file already uses for `state.db` applies unchanged.
- Then **re-run the mutation**: inject a mirroring write into the RUN phase and confirm the test goes **RED**. Keep that as the standing falsifiability test, replacing the current one — a falsifiability probe must exercise *the same handle the guarded assertion reads*.

**Note (probe hygiene):** my probe wrote only into the suite's temp `TORQCLAW_DATA_DIR`. I verified the operator's real `~/.torqclaw/collab.db` was untouched (`collab_events` = 0 rows, no `probe-chan` rows, mtime unchanged). Both files were restored byte-identical afterward.

---

## 3. NON-BLOCKING

**NB-1 — A9's wording over-reads its own test.** See §1.5. A9 pins render-independence, not an identity join; the "working non-member" fixture is necessarily a non-member. Amend the PRD wording when S5b lands.

**NB-2 — the "Members" undercount caption is honest; the *heading* is the weak point.** The caption *"as loaded so far — earlier pages may add more"* is genuinely good practice and I credit it. But it sits **below** the chips, while the heading says the unqualified word **"Members"**. A reader who scans headings sees a complete roster. The real-empty string **"No members seen yet."** is well-chosen (the "yet" carries the incompleteness). Recommend tightening the heading to `Members (as loaded)` so the qualification survives a scan. **Judgment: honest, not misleading — but only just, and it depends on a 9px caption.** Related dead weight: `ChannelMemberEntry.since` is computed and never rendered anywhere (`grep` for `m.since` returns nothing); either render it or drop the field.

---

## 4. ATTACK RESULTS — mutation probes (all RED reproduced, all restored)

Each probe mutated source, ran the suite, and confirmed a genuine failure. **A test that passes identically with and without the guard enforces nothing** — these do not.

| # | Probe | Mutation | Result | Evidence |
|---|---|---|---|---|
| P1 | **T-11 rogue dispatch button** | Injected `<button onClick={() => __rogue({action:'SUBMIT_PROMPT'})}>` into the member chip | **RED reproduced** | `1 failed | 61 passed` — `T-11: the roster renders zero buttons/links…` |
| P2 | **Epoch anchoring** | Replaced `selectTurnStartMs(events, requestId)` with `Date.now()` (mount-time counter) | **RED reproduced (2 tests)** | `2 failed | 60 passed` — remount test + `selectWorkingNow` anchor test |
| P3 | **"Invalid Date" guard** | Deleted `if (Number.isNaN(d.getTime())) return raw;` | **RED reproduced** | `1 failed | 61 passed` — timestamps test |
| P4 | **A5 mirroring write** | Real `INSERT` into the **production** collab DB (`getCollabDb()`) during the RUN phase | **GREEN — FAILED TO CATCH → B-1** | `prod rows now = 1`, `3 passed` |

P1–P3 are real enforcement. P4 is the blocker.

### Findings on the remaining attack surface

**Dispatch affordances: NONE found.** `RosterSection` (`ChannelsPanel.tsx:1306-1372`) takes exactly two props, both plain data (`ChannelMemberEntry[] | null`, `WorkingNowEntry | null`) — zero function-typed fields, therefore no callback is even *in scope* to wire a control to. Rendered elements are `div`/`h3`/`p`/`ul`/`li`/`span` only. No `button`, `a`, `onClick`, `href`, or form control anywhere in the block. The T-11 test additionally asserts `queryAllByRole('button').length === 0` and `link === 0` within the roster subtree and clicks through it. **Structural, not merely tested.**

**"Invalid Date" NEVER reaches the DOM: confirmed.** `formatOccurredAt` (`:516-518`) parses, returns `raw` verbatim on `NaN`, else formats. Tests feed malformed values and assert `queryByText(/Invalid Date/)` absent; P3 proves the guard load-bearing. Malformed `member_added` missing `principalId` is skipped by the `typeof principalId !== 'string'` guard (`:447`) — test asserts no crash and no `"undefined"` in the DOM.

**T-10 four honest states: satisfied.** `null` = loading (roster renders nothing — riding the timeline's own Loading state), `[]` = real-empty (`"No members seen yet."`), plus the panel's existing `sendFailed`/`timeout` renders, tested as distinguishable. A malformed frame leaves last-good data visible (existing S2/S4 behaviour, unchanged by S5).

**A6/T-9 not-applicable: CORRECT — verified, not accepted.** `git status packages/` is **empty** — zero changes under `packages/contracts` or `packages/gateway`. `git diff` of the panel adds **no** `sendCommand(` call and no `action:` literal. Both selectors are pure functions over the existing `events` prop, consumed via `useMemo`. **No new ClientCommand variant, no new GatewayEvent field ⇒ A6/T-9 have no command to grade.** Declaration is sound.

**S4 coalescing: INTACT — no V-1 regression.** Both re-read effects (hint-triggered `:790-810`, reconnect-triggered `:822-833`) check `refetchInFlightRef.current[selectedChannelId]` and set `refetchDirtyRef` rather than firing a second request. S5 adds **no** re-read path — its selectors are pure `useMemo` over already-received props and issue no commands — so the guard is untouched by construction. The V-1 comment-vs-code divergence is not reintroduced.

---

## 5. GATES RUN

| Gate | Result |
|---|---|
| `npx vitest run tests/channels-panel.test.tsx tests/collab-presence-a5-zero-writes.test.ts` | **PASS** — 65/65 (62 + 3) |
| `npx vitest run` (full suite) | **PASS after stale-dist rebuild** — 2148 passed / 1 failed → the single failure was `tests/collab-c1-flag-off-identity.test.ts` from a **stale `packages/collab/dist`** (`does not provide an export named 'canonicalJson'`), **not S5**. After `pnpm --filter @torqclaw/collab build` it passes. Effective: **2149/2149**. |
| `npx tsc --noEmit -p apps/console/tsconfig.json` | **PASS** — exit 0, zero diagnostics |
| `pnpm reachability` | **PASS** — 120 modules reachable from 6 entry points; 3 declared-dormant (all pre-existing AUTH-005 CLI entrypoints) |
| Known flake `tests/failover/controller-timeout.test.ts` | Passed (7/7); not chased |

---

## 6. WHAT WOULD FLIP THIS VERDICT

**B-1 flips on one change:** repoint the A5 assertion at the `getCollabDb()`/`TORQCLAW_COLLAB_DB_PATH` handle and demonstrate the mutation goes RED. That is a contained test-only fix; **no production code change is required**, and nothing else in the slice is blocked behind it.

**(c) flips on a label change** — no wire data, no new command. Rename/caption "Working now" so it states it is this session's own task, and scope the empty state to match.

If both land, S5 is approvable as the correct final shape for this slice, with **S5b (self-only `principalId` on CONNECTED)** filed as the follow-on carrying the §1.3 disclosure analysis.

---

## 7. CREDIT WHERE DUE

The builder escalated the right question at the right boundary rather than quietly changing a disclosure-sensitive frame, and the module documentation states the limitation precisely and truthfully — including that the enforcement is structural rather than an identity join. The four-state honesty discipline, the null-vs-`[]` convention, the no-fabrication posture (no invented role, display name, or online status), and the zero-function-typed-props structural boundary are all correctly applied. Three of the four probes I ran were caught by tests the builder wrote. **The defect is that the one criterion the PRD calls the spine is aimed at the wrong database — and that the honesty present in the comments never reached the label the operator will actually read.**

---

*Tree state: source restored byte-identical (`diff` clean against pre-probe copies; `git diff --stat` = 525 insertions / 9 deletions across exactly 2 files, matching the pre-review state). No commits. No files modified outside this verdict document.*
