# Independent Verification — PRD-TCLAW-COLLAB-PRESENCE-UI-005 S4 (hint-then-refetch)

**Seat:** G1R independent verifier.
**Model:** `claude-opus-5`. The routing profile names Opus 5 for this seat and I *am* Opus 5 — **no substitution applies.**
**Scope:** slice S4, committed `cc95499`, diff range `c404a24..1776938`.
Changed by S4 proper (`cc95499`): `apps/console/src/components/ChannelsPanel.tsx`, `tests/channels-panel.test.tsx`.
**Date:** 2026-08-17. **Thread:** fresh, no authoring context.
**Method:** two independently-authored adversarial probe files (19 probes) driving the real component through its real test seam, plus one source mutation to isolate a root cause. Probe files deleted; source mutation reverted; `git diff --stat` empty afterward.

**Relationship to the G2A re-audit** (`G2A-OPUS48-COLLAB-PRESENCE-UI-005-S3-REAUDIT.md`): that audit found and correctly characterized much of S4. This is the independent pass that was skipped, not a ratification. I re-derived every load-bearing claim by execution. **One finding below is new and was not seen by G2A.**

---

## VERDICT: **REJECT** — one blocker (V-1)

S4's *rendered truth* is correct everywhere I could attack it: contiguity holds, no gap or duplicate is producible, the no-delivery-guarantee discipline is real, and the A6/T-9 not-applicable declaration is accurate. G2A's coalescing verdict is correct **for the paths it drove**.

But the load-bearing claim as written in the source header — *"at most ONE `GET_CHANNEL_TIMELINE` is in flight per selected channel at any time"* — is **false on the single most common path in the product**: the operator sending a message. Each ack fires **two** concurrent reads, and the extra read is **one per ack, unbounded** — not one of NB-RA-2's bounded edge leaks. I proved the mechanism by mutation and confirmed the existing 82-test suite is blind to it **in both directions**.

This is the repo's recurring unenforced-claim pattern: the invariant is stated in a mandatory-sounding comment block, tested by a test that only exercises the hint path, and violated by the ack path sitting fifteen lines away.

---

## BLOCKER

### V-1 — the coalescing invariant is violated on the self-send path, once per ack, unbounded

**The claim.** `ChannelsPanel.tsx:63-69`, verbatim: *"COALESCING IS MANDATORY (Cycle-2 NB-3 / A4): at most ONE `GET_CHANNEL_TIMELINE` is in flight per selected channel at any time."* PRD §4 S4: *"one in-flight re-read per channel."*

**The defect.** There are **three** call sites that fire a re-read for the selected channel:

| effect | line | checks `refetchInFlightRef`? |
|---|---|---|
| hint effect | `:628-648` | **YES** — `:635` |
| reconnect effect | `:660-673` | **YES** — `:667` |
| **S3 post-ack effect** | **`:818-849`** | **NO — `:848` calls `requestTimeline` unconditionally** |

A `collabMessagePosted` ack for the operator's own send satisfies **both** `selectLatestPostAck` (`:213`, key-correlated) **and** `selectLatestHintEventId` (`:247`, key-agnostic by design — its docstring says so explicitly). Both effects have `[events, selectedChannelId]` in their dependency arrays, so a single ack frame runs both in the same commit. The hint effect fires first and sets `refetchInFlightRef = true`; the ack effect then ignores that flag entirely and fires a second `GET_CHANNEL_TIMELINE` — **same channel, same cursor, concurrently.**

Note the two effects cannot suppress each other by dedup: they keep *separate* dedup ledgers (`lastHintEventIdRef` vs `requestedAckEventIds`), each of which correctly admits the ack once.

**Measured (probe Q2), one send, one ack:**
```
[Q2] reads = 2; args = [
  {"action":"GET_CHANNEL_TIMELINE","channelId":"chan-1","cursor":"0","limit":50},
  {"action":"GET_CHANNEL_TIMELINE","channelId":"chan-1","cursor":"0","limit":50}]
```

**Measured (probe Q1) — the part that makes this a blocker, not a note.** Four sends, acks landing one per batch (the realistic case):
```
[Q1] after ack 0: reads = 1
[Q1] after ack 1: reads = 2
[Q1] after ack 2: reads = 3
[Q1] after ack 3: reads = 4
```
Wait — read that against the baseline: reads grow **+1 per ack** and each ack contributes one *extra* read beyond the coalesced budget of one. This is **linear in ack count with no ceiling**, which is categorically different from NB-RA-2's two paths, each capped at one extra read for the lifetime of the condition (proven bounded below).

**Root cause proven by mutation.** I added the same guard the other two effects use, immediately before `:848`:
```ts
if (refetchInFlightRef.current[selectedChannelId]) {
  refetchDirtyRef.current[selectedChannelId] = true;
  return;
}
```
Result:
```
[Q1] after ack 0: reads = 1   [Q2] reads = 1
[Q1] after ack 1: reads = 1
[Q1] after ack 2: reads = 1
[Q1] after ack 3: reads = 1
```
5 reads → 1, and 2 → 1. The mutation was reverted with `git checkout --`; tree confirmed byte-clean.

**The suite is blind in BOTH directions — this is the enforcement failure.**
- With the defect present: `npx vitest run tests/channels-panel.test.tsx tests/collab-surface-post.test.ts` → **82/82 GREEN**.
- With my fix applied: **82/82 GREEN**.

A test that passes identically with and without the guard enforces nothing about it. The S4 coalescing test (`"A4: coalescing — N hints arriving WHILE a re-read is in flight..."`) drives only `hintFrame()` with keys that match no pending send, so the ack effect's `pendingSends.find(...)` returns undefined and it returns early at `:835`. **The one path the test never drives is the one that breaks.** G2A's probe R2 removed `isNewFrame` and got a RED — which proves the *hint* guard has teeth, not that the invariant holds.

**Failure scenario (why this matters beyond tidiness).** §4 S4's stated purpose for coalescing is verbatim *"so a busy channel cannot thundering-herd the store."* An operator or agent posting in a burst — exactly the busy-channel case the clause exists for — issues 2N reads where the design budgets N. Worse, the two concurrent reads share **one** `timelineTimer` ref (`:508`): `requestTimeline` unconditionally clears it at `:542` and re-arms it, so the second read's timer overwrites the first's. If the first read is the one that never returns, its timeout is silently disarmed and `timelinePhase` is governed by the second — a real timeout can be masked. That is an honest-state risk, not only a load one.

**Suggested fix.** Route the ack effect's re-read through the same coalescing guard as the other two (the three-line mutation above), and add a test that drives the **self-send** path and asserts the call count is 1, not 2. Note the guard alone is not sufficient for the invariant as stated unless the test pins it — per this repo's own unenforced-claim record, the test is the load-bearing half.

---

## Coalescing probe results (my own runs)

| scenario | expected | actual | pass |
|---|---|---|---|
| P1: 2 hints during one in-flight read | 1 | 1 | ✅ |
| P1: 5 hints during one in-flight read | 1 | 1 | ✅ |
| P1: 20 hints during one in-flight read | 1 | 1 | ✅ |
| P1: after resolve, exactly one follow-up (N=2/5/20) | 2 total | 2 | ✅ |
| P2: 5 hints during the **follow-up itself** | 2 | 2 | ✅ |
| P2: second resolve → one more, third (clean) → none | 3 then 3 | 3 then 3 | ✅ |
| P3: hint for a **non-selected** channel | 0 | 0 | ✅ |
| P3: 6 hints interleaved chan-1/chan-2 while in-flight | 1 (chan-1 only) | 1 | ✅ |
| P7: mid-flight second CONNECTED coalesces | 1, then 2 after resolve | 1 → 2 | ✅ |
| Q5: hints during socket death; owed follow-up honoured on recovery | 2 | 2 | ✅ |
| **Q2: ONE self-ack (operator sends a message)** | **1** | **2** | ❌ **V-1** |
| **Q1: four self-acks, one per batch** | **1 per ack** | **2 per ack (linear)** | ❌ **V-1** |

The hint and reconnect paths are genuinely well-coalesced — G2A's finding there is confirmed independently. The invariant fails only where nothing guards it.

---

## NB-RA-2 — G2A's two leaks, characterized and judged

I drove both. **Both are genuinely bounded; G2A's "bounded" judgement is correct.**

### (a) Reselect race — `selectChannel :688` deletes `lastTimelineFrameIdRef[channelId]`
**Bounded: TRUE.** Probe P4: re-selecting the same channel while its old frame is still newest in `events`, then landing a hint → **2 total reads** (the select's own read plus one). The mechanism is as G2A described: `timelineByChannelId` (`:468-474`) still finds the old frame, the deleted ref makes it look new, and the resolved arm clears the just-armed in-flight flag. It cannot compound: `selectChannel` also sets `refetchInFlightRef[channelId] = false` and `refetchDirtyRef[channelId] = false` (`:686-687`), so each reselect resets to a known state rather than accumulating. Bounded at one extra read **per reselect action**, and a reselect is a deliberate user click.

### (b) Timeout-with-dirty — the timeout arm `:560-570` clears in-flight but leaves `dirty` set
**Bounded: TRUE, and I tried specifically to unbound it.** Probe P5: hint → read in flight; second hint → dirty; timeout at 6s → in-flight cleared, dirty **not** flushed; a later unrelated frame lands → **+1 stale follow-up**. Then five more frames land → **no further growth** (`reads after 5 more frames = 2`).

Probe P6 attacked it directly with four repeated hint-hint-timeout cycles:
```
[P6] cycle 0: reads=1 delta=1
[P6] cycle 1: reads=1 delta=0
[P6] cycle 2: reads=1 delta=0
[P6] cycle 3: reads=1 delta=0
[P6] final after resolution = 2
```
Delta collapses to zero after the first cycle. **`refetchDirtyRef` is a boolean, so it saturates** — repeated setting cannot accrue debt, and the single owed follow-up is consumed exactly once at `:598-601`. I could not construct a sequence that unbounds either path. Neither affects rendered truth (merge dedups by event id, `:494-499`).

**Judgement: both leaks are correctly classified as bounded non-blocking.** They are also materially *less* severe than V-1, which G2A did not see.

---

## NB-RA-1 — reproduced, and the "self-heals" claim is qualified

**Reproduced: TRUE.** Probe P9 — two sends, both acks in **one render batch**, then the re-read returns both committed:
```
[P9] AFTER TIMEOUT pending rows: ["no response — retryretrymsg A"]
[P9] 'msg A' occurrences in DOM: 2
[P9] NB-RA-1 REPRODUCED = true
```
"msg A" renders **twice simultaneously**: once as a real committed timeline row, and once as a dashed pending row reading *"no response — retry"*. The user sees their message both sent and failed at the same time. Mechanism confirmed as G2A described: `selectLatestPostAck` (`:217`) returns only the **newest** keyed ack per effect run; the older ack in the same batch is never processed, and the effect's deps don't change again to give it a second chance.

**On "self-heals via idempotent retry" — TRUE but only with a user action, and it is not free.** Probe Q3:
```
[Q3] retry dispatched 1 POST(s); key reused = true
[Q3] AFTER RETRY: 'msg A' rendered 1x -- SELF-HEALED = true
```
The retry does reuse the same `idempotencyKey` (B-3 honoured), the server dedups, and the display converges to one row. But this is **user-initiated recovery of a false failure**, not automatic healing: absent a click, the contradictory dual render persists indefinitely. §13 S3's rule is *"a pending row may render as visibly pending, but never as sent"* — here the same message is rendered as **both**, which is a stronger inconsistency than the rule anticipates.

**Judgement: non-blocking, consistent with G2A**, because the failure direction is safe (false failure, never silent success) and no message is lost or duplicated in the store. Recorded because "self-heals" overstates it slightly. Fix direction: iterate all unprocessed keyed acks rather than taking only the latest.

---

## Reconnect recovery (attack 4) — PASS

Probe P7, all assertions green:
- A **new** CONNECTED id re-reads from cursor `'0'` exactly once: `{"cursor":"0"}` ✅
- The **same** CONNECTED id re-rendered 5× fires **nothing further** ✅
- A **second, genuinely new** CONNECTED landing **mid-flight** coalesces (1 read, dirty set), then exactly one follow-up on resolve ✅ — in-flight/dirty state is not corrupted.

**One characterization worth recording (non-blocking).** `lastConnectedIdRef` (`:528`) is a **single global ref**, not keyed by channel, unlike every other coalescing ref in the file. Probe P8: reconnect on chan-1, then switch to chan-2 while that CONNECTED is still newest → the reconnect effect does **not** re-fire for chan-2. This is **correct behavior and not a defect**: `selectChannel` unconditionally issues its own from-`'0'` read (`:690`), so the newly selected channel gets full store-backed recovery through the select path regardless. I note it only because the asymmetry is undocumented and a future reader could "fix" it into a duplicate read.

The follow-up read after a coalesced reconnect uses `found.cursor` (`:600`), not `'0'` — correct, since the resolved read already delivered everything up to that cursor and the wire pages forward.

---

## Contiguity / A4 (attack 5) — PASS, no gap or duplicate producible

- **Probe P12 (duplicate attempt):** page `[1,2]` held, then a reconnect re-read from `'0'` returns the overlapping full history `[1,2,3,4]`. Result: 4 rendered rows, `'one'` count = **1**, order indices `[0,1,2,3]` strictly ascending. The merge (`:494-499`) dedups by `event.id` and sorts by numeric cursor. ✅
- **Probe P13 (gap attempt):** only event 1 held (cursor `'1'`), then a hint for event 5 while 2–4 were never seen. The re-read correctly issues `cursor: '1'` — **not** the hint's cursor `'5'` — so the server returns the dense range 2..5. Rendered: 5 contiguous rows, each exactly once. ✅

The design detail that makes the gap impossible: the re-read cursor comes from `timelineSnapshots[channelId].cursor` (the console's own high-water mark), never from the hint's cursor field. A hint carrying a far-future cursor cannot cause the console to skip forward. This is correct and worth preserving explicitly.

`Number(a.cursor) - Number(b.cursor)` at `:498` is safe for the cursors the wire admits (`^(0|[1-9][0-9]*)$`, `safeCursor :333-336`); a cursor beyond `Number.MAX_SAFE_INTEGER` would sort imprecisely, but that is S1's residue (already enumerated in S1's T-9 matrix), not S4's.

---

## No-delivery-guarantee (attack 2) — PASS

Swept every comment, test name, and rendered string.

**Rendered strings: clean.** The only word-hits in the file are:
- `:55, :61` — comments that *disclaim* delivery (*"does not claim, test, or imply that a hint frame is guaranteed to arrive"*; *"not because the socket promises delivery"*).
- `:846` — the comment `"hint rather than a live-delivery hint"`, describing the mechanism, not a claim.
- `:1038` / `:1042` — `"Live byte budget"`, a comment on the composer's character counter. Not a delivery claim.

No `"delivered"`, no `"✓"`, no checkmark, no `"live"` reaches the DOM. The existing sweep test asserts this on `container.textContent` and I confirmed it is a real assertion, not a title.

**Test names: clean.** No test asserts a hint *will* arrive, is retried, or is queued if missed. Every S4 test drives a hint frame already present in props and asserts the resulting re-read — the same "frame observed in props" shape used throughout the file. The test file's own header states this explicitly. **This is the correct discipline and v0.1's withdrawn overclaim has not crept back.**

**deliveryLanguageFound: none.**

---

## A6 / T-9 not-applicable declaration (attack 3) — VERIFIED CORRECT

Independently checked, not taken on the header's word:

- `git diff --stat cc95499~1..cc95499` → exactly two files: `ChannelsPanel.tsx` + `channels-panel.test.tsx`. **No gateway, no contracts, no schema.**
- `git diff c404a24..1776938 -- apps/console/.../ChannelsPanel.tsx | grep '^\+.*action:'` → **zero** new `action:` literals. The only dispatches S4 adds are `GET_CHANNEL_TIMELINE` (existing S1 command) at the hint and reconnect call sites.
- `git diff --stat c404a24..1776938 -- packages/contracts/` → **empty.** No contract change, no new frame shape.
- The consumed frame is S3's existing `collabMessagePosted` publishOnly ack (`collabSurface.ts:353-361`), whose handler-totality coverage was graded under S3's own T-9 matrix.

**Does S3's existing coverage genuinely govern what S4 does with it?** Yes, with one honest boundary: S4 reads only `metadata.channelId` and `metadata.eventId`, both guarded by `typeof === 'string'` at `:250` before use, and `selectLatestHintEventId` returns `null` on any non-conforming frame — so a malformed hint degrades to "no hint", never a throw. A6's totality unit is the gateway's `socket.on('message')` path, which S4 does not touch at all. **The declaration is accurate, and the residue is netted by the console's own type guards.**

**t9ApplicabilityCorrect: true.**

---

## D-1 interaction (attack 7) — PASS

- **Probe P10 — a hint must not clear a pending send.** Operator has a send in flight; a **foreign** post arrives (different `idempotencyKey`); the re-read returns only the foreign message. Result: the operator's pending row is **still visible** and **still `border-dashed`** ✅. The hint path (`selectLatestHintEventId`, key-agnostic) and the confirm path (`selectLatestPostAck`, key-correlated at `:833`) are correctly separated — the hint triggers a re-read and touches no pending state.
- **Probe P11b — an ack must not be double-counted as both confirm and hint.** One self-ack: the pending row transitions to `awaitingConfirm`, the re-read returns the committed event, the pending row clears, and `'mine'` renders **exactly once** ✅. No double-count in *rendered state*.

**However** — this is precisely where V-1 lives. The ack **is** double-counted as a *dispatch trigger* (2 reads) even though it is not double-counted as *state*. G2A verified the state half, which is why the defect survived: the rendered outcome is correct, only the request count is wrong. Attack 7 passes on its own terms; V-1 is filed separately.

---

## Gate results — my own runs

| gate | result |
|---|---|
| `npx vitest run tests/channels-panel.test.tsx tests/collab-surface-post.test.ts` | **PASS — 82/82** (and 82/82 **with V-1 fixed**, which is the enforcement failure) |
| `npx vitest run` (full suite) | **2123 passed, 4 skipped, 0 test failures.** One suite-level failure, `tests/collab-c1-built-artifact.test.ts`: `Gateway build failed; timeout=true; spawnError=ETIMEDOUT; lockPath=.torqclaw-collab-build-lock`. **Environmental** — my probe runs held the build lock concurrently. **Re-run in isolation: 4/4 PASS.** Not a code defect. |
| `npx tsc --noEmit -p apps/console/tsconfig.json` | **PASS** (exit 0) |
| `node ops/reachability.mjs` | **PASS** — 120 modules reachable from 6 entry points; 3 declared dormant |
| `tests/failover/controller-timeout.test.ts` | known flake, not chased per brief |

---

## Tree state

Clean. Two probe files created and deleted; one source mutation applied to `ChannelsPanel.tsx` and reverted via `git checkout --`. `git diff --stat` empty; `git status --short` shows no change to `apps/console/`, `packages/`, or either S3/S4 test file. This verdict file is the only artifact created. Nothing committed.

---

## Bottom line

S4's product behavior is right: contiguity, reconnect recovery, gap/duplicate resistance, honest states, and the no-delivery discipline all survived direct attack, and the A6/T-9 not-applicable declaration is accurate rather than a convenient omission. G2A's audit was substantially correct.

What it got wrong is the same thing this repo keeps getting wrong: **the invariant everyone agrees on is guarded on two of its three paths and pinned by a test that only exercises one.** The unguarded path is the ordinary one — an operator sending a message — and the cost is linear, not bounded. Fixing it is three lines; the test that makes the fix stick is the part that matters, because right now the suite cannot tell the two versions apart.

**REJECT** pending V-1. Recommend the guard plus a self-send coalescing assertion, then a short re-verify of the call-count claims only.
