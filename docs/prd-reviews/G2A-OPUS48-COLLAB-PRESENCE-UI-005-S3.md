# G2A Final Audit — PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3 (composer / POST_CHANNEL_MESSAGE)

**Seat:** G2A final verifier.
**Model:** `claude-opus-4-8`. CLAUDE.md §2 names Claude Opus 4.8 for this seat and I *am* Opus 4.8 — **no substitution applies.**
**Scope:** commit `c404a24` (DIFF_RANGE `72b4d36..c404a24`), branch `phase1-server-owned-authority`.
**Independent verifier's verdict read:** `docs/prd-reviews/VERIFY-OPUS-COLLAB-PRESENCE-UI-005-S3.md` (APPROVE_WITH_CONDITIONS, one condition C-1). Read in full; **not deferred to** — it missed one real defect (D-1 below).
**Date:** 2026-08-17. **Method:** full diff read, live mutation probes with recorded RED output, and a scratch component test driving a scenario neither the builder nor G1R exercised. Scratch probe file was deleted after use; the tree is byte-identical to HEAD afterward.

---

## VERDICT: **REJECT** — one blocker (D-1), two non-blocking findings (NB-1, NB-2)

The slice is otherwise the strongest in this program so far: the dual byte bound is exact (NFC-before-count, both bounds, proven by G1R's adversarial corpus and confirmed by my source read), A6 totality holds across the whole `socket.on('message')` path, A3 is structural, CO-1 is genuinely fixed and now *pinned* (I reproduced its RED), and every T-9 probe I ran personally went RED. But the composer's ack-correlation logic has a hole that turns a server-rejected message into a **silent drop** — the precise failure mode §13 S3 and A8 exist to forbid, on the first write path this surface has ever shipped. That is a blocker under this PRD's own criteria.

---

## Defects

### D-1 (BLOCKER) — Concurrent sends: a sibling's ack silently clears a server-rejected pending send

**Where:**
- `apps/console/src/components/ChannelsPanel.tsx:565` — the post-ack effect maps **every** `phase === 'sending'` entry for the selected channel to `{ phase: 'awaitingConfirm', ackedEventId: ack.eventId }`, stamping them all with the *latest* ack's eventId.
- `apps/console/src/components/ChannelsPanel.tsx:586` — the confirm effect then removes **any** entry whose stamped `ackedEventId` appears in the re-read snapshot.
- Root cause upstream: `packages/gateway/src/collabSurface.ts:353-362` — the ack's `publishOnly` metadata carries `channelId`, `eventId`, `cursor`, `occurredAt` — **no `idempotencyKey`**, so per-message correlation is impossible and the effect correlates by channel alone (`selectLatestPostAck`, `ChannelsPanel.tsx:159`).

**Failure scenario (reproduced by execution, not reading):** operator sends message A, then immediately message B in the same channel. Both entries are `'sending'`. The server commits A and **rejects** B (see trigger below), emitting an ERROR frame that the console drops by design (CO-S3-1, pre-existing). A's ack arrives → the effect stamps **both** entries with A's `eventId` → the ack-triggered re-read returns a snapshot containing A only → the confirm effect matches both entries' `ackedEventId` and **clears both**. B's row disappears: no `'sendFailed'`, no `'timeout'` (its timer was cleared when it left `'sending'`), no retry affordance, and the draft was already cleared at send time. The user's message is gone with no trace.

**Realistic trigger for the server rejection:** the composer budget checks only the two byte bounds — it does **not** check the C0/C1 control-character rule (`text.ts:146-157`), and neither does the contract's `z.string().min(1).max(16384)`. Pasting text containing a NUL or BEL (`"hello\x07world"`) passes the client budget and the contract, and the substrate rejects it `INVALID_REQUEST`. Two quick messages — one clean, one pasted with a control char — is an ordinary usage pattern, not an adversarial construction. Membership revocation or archival between sends hits the same path.

**Evidence:** scratch component test (created, run, deleted): two sends, ack for A only, confirming timeline containing only `ev-a` →

```
PROBE RESULT: B still rendered = false
AssertionError: expected false to be true
```

i.e. the rejected message was silently cleared. Honest behavior would be: B stays pending and degrades to `'timeout'` → "no response — retry" (which is what happens when B is sent *alone* — that path is correctly implemented and tested).

**Violates:** §13 S3 "Send failure is explicit — … never a silent drop" and §14 A8 "a send failure is surfaced, never silent."

**Suggested fix (small, in-slice):** add `idempotencyKey` to the ack metadata in `handlePostChannelMessage`'s `publishOnly` (the server knows it), and in the ack effect stamp only the entry whose key matches — leaving un-acked siblings in `'sending'` to time out honestly. A component test for the two-sends-one-rejected interleaving should pin it.

**Severity:** blocker. Narrow window, but it is a silent-drop honesty violation on the PRD's flagship guarantee, and this is the slice where the write-path honesty machine is established.

---

## Non-blocking findings

### NB-1 — A test whose name overclaims what it asserts
`tests/channels-panel.test.tsx` ("Send is disabled for empty text and for whitespace/newline-only text …"): the body asserts the empty case, then types `'   \n\t  '` and asserts **nothing** — the trailing comment concedes the byte-based `empty` check does not block whitespace-only input. The composer's actual behavior (whitespace-only *is* sendable; the substrate persists it byte-identical per `text.ts:105`) is a defensible reading of §13 S3's "declines to send empty content," but the test *name* claims a behavior nothing pins — the repo's recurring unenforced-claim pattern in miniature. Rename the test or assert the real behavior.

### NB-2 — T-9 falsifiability evidence is mis-cited in the test file header
`tests/collab-surface-post.test.ts:16-20` states the "four RED/GREEN pairs are recorded in this file's own describe block at the bottom." They are not — the bottom of the file is T-9 part 4, and no RED excerpts appear anywhere in the file. G1R's verdict records RED excerpts for its three composer-side probes, and the commit message records the C-1 RED; the four gateway-matrix parts had **no recorded builder-side RED excerpts at all**. Per §8 T-9 ("a probe reported without its RED output is not a discharged probe") these were formally undischarged until I ran them myself — see below. Fix the header comment to point at where the evidence actually lives.

---

## A6(a) citation audit — per free-form field

| field | cited validator | correct? | reachable? |
|---|---|---|---|
| `text` | `text.ts:110` `normalizeMessageText`; bounds `:122` (raw UTF-8) / `:137` (JSON-encoded), NFC at `:115`; called from `store.ts:1428` | **yes** — verified by direct read: `:122`/`:137` are the byte-count lines feeding unconditional `if` checks at `:123`/`:129`/`:138` inside the function body; NFC at `:115` runs before both | **yes** — no guard gates either bound; invoked before the sequencer/predicate |
| `channelId` | `store.ts:2032` `assertChannelVisible` as the `runKeyedCommand` predicate slot | **yes** | **yes** — predicate runs before the idempotency lookup, on every call including replays; both NOT_FOUND arms byte-identical (and I proved the byte-identity test has teeth — Probe 5) |
| `idempotencyKey` | honest negative claim: nothing in the substrate validates its shape (`migration.ts:137` is `TEXT NOT NULL`, no CHECK); `z.uuid()` in the contract is the sole enforcement | **yes** — the negative claim is accurate, and `z.uuid()` is genuinely enforced at the emitted-schema boundary (Probe 1) | n/a |

No field is graded green on an uncited validator. The contract comment's "intentionally coarser in the safe direction" argument for `max(16384)` *characters* vs the byte bounds is sound: residue is enumerated (T-9 part 2) and resolves to structured `COLLAB_INVALID_REQUEST` (Probe 2 proves that arm is pinned).

## A6(b) totality — whole `socket.on('message')` path

Traced independently. Inside the handler's try/catch: `store.postChannelMessage` (all four CollabError arms mapped; generic catch nets plain `Error` and non-`Error` throws — Probe 3) and `publishOnly` (netted by the same try/catch). Outside it, in the dispatch arm (`server.ts:650-671`): flag check (pure env reads), four field reads on an already-validated discriminated-union member, the awaited handler, `sendErr`. `sendErr`'s `JSON.stringify`/`socket.send` exposure is the pre-existing shared risk across every command, unchanged by S3. I found no wire-admissible input that throws; G1R's 16-hostile-input live drive (incl. the lone surrogate through `publishOnly`'s validator) stands.

## T-9 audit — probes run by ME, RED output recorded

All mutations via structured edits (no `python3`); contracts `dist` rebuilt before probe 1 and after restore; each restored to a byte-identical tree (`git diff HEAD --stat` empty afterward).

| # | guard reverted | observed RED | discharged |
|---|---|---|---|
| 1 | `z.uuid()` → `z.string()` (commands.ts) + rebuild | `Tests 4 failed | 35 passed (39)` — malformed-idempotencyKey cases now parse | **yes** (also proves the suite tests the rebuilt artifact, not stale dist) |
| 2 | INVALID_REQUEST arm deleted (collabSurface.ts) | `FAIL … resolves this residue case to a structured COLLAB_INVALID_REQUEST` — `1 failed | 38 passed` | **yes** |
| 3 | generic catch → `throw err` | `7 failed | 32 passed` — all throw-class totality cases incl. string/null/undefined/number | **yes** |
| 4 | C-1 fallback `?? 'agent'` → `?? 'operator'` | `C-1 REGRESSION … expected 'operator' to be 'agent'` — `1 failed | 38 passed` | **yes** — matches the commit message's recorded RED verbatim |
| 5 | NOT_FOUND detail injected with `[${channelId}]` | `FAIL … BYTE-IDENTICAL COLLAB_NOT_FOUND` — `1 failed | 38 passed` (hidden vs absent now distinguishable) | **yes** — T-2/no-oracle has teeth |

Builder-side RED excerpts for the four gateway-matrix parts were **not recorded anywhere** (NB-2); the probes above discharge them from this seat.

## Other criteria

- **Dual byte bound (client):** `computeMessageByteBudget` normalizes NFC *before* counting and applies both bounds (`overCap: rawBytes > MAX || jsonBytes > MAX`), matching `text.ts:115/122/137`. Send is disabled over-cap; the 16,384-newlines residue case is pinned by a dedicated test. G1R's adversarial corpus (incl. NFC-grow Devanagari) found zero client/server mismatches; my source read concurs.
- **CO-1:** caller built from the connection's resolved principal via a real DB read through the store's own handle; null principal → `COLLAB_IDENTITY_REQUIRED` as the handler's first statement, nothing posted; no operator bypass (channel/node seats explicitly denied in authz; substrate visibility enforced by `assertChannelVisible`). C-1's spy-store pin is real (Probe 4).
- **A3:** emitted schema has exactly `{action, channelId, text, idempotencyKey}`, `additionalProperties: false`; a smuggled `author`/`principalId` is stripped at parse (test at collab-surface-post.test.ts:404). Structural, not behavioral.
- **Optimistic echo:** forbidden structurally — pending entries clear only via real-snapshot `confirmedIds` match; asserted on the DOM (dashed-border class, occurrence counts). Correct — **except** that the same confirm path is the vehicle for D-1 when the stamped eventId belongs to a sibling.
- **Idempotency:** key minted per draft, retry reuses it unchanged, new message gets a new key, never text-derived; server-side T-4 tests prove one event per key and conflict on key-reuse-with-different-text.
- **No test weakened:** the `DANGEROUS_ACTIONS` removal is not a loosening — the strict two-element `READ_ONLY_ALLOWLIST` assertion still excludes `POST_CHANNEL_MESSAGE` and runs first; S3 T-11 uses `S3_ALLOWLIST` per §14's explicit carve-out. `auth-v2-phase1.test.ts` changed only the SHA pin + comment; recomputed hash matches `authz.ts` byte-exactly (G1R verified, I confirmed the diff).
- **Scope discipline:** 12 files, all S3-required (contract + dual schema emit targets, gateway handler/dispatch/authz/identity, composer, two test files, the frozen-hash re-pin, the verdict doc). No unrelated content bundled.
- **Contracts rebuild:** performed by me twice during probing; emitted 8 schemas to both targets; tree clean afterward (no stale-dist false green).

## Gate results — my own runs

| gate | result |
|---|---|
| `pnpm --filter @torqclaw/contracts build` | PASS — 8 schemas → both targets |
| `npx vitest run tests/collab-surface-post.test.ts tests/channels-panel.test.tsx` | PASS — **73/73** |
| `npx vitest run tests/authz.test.ts tests/collab-identity.test.ts tests/connection-auth.test.ts tests/collab-connect-dataflow.test.ts` | PASS — **60/60** on a clean tree. (An earlier background run of the same command showed `1 failed | 59 passed` — it overlapped my Probe-1 contract edit mid-flight; the clean re-run is green and the failure is attributed to my own contamination, not the slice.) |
| `npx tsc --noEmit -p packages/gateway/tsconfig.json` | PASS (exit 0) |
| `npx tsc --noEmit -p apps/console/tsconfig.json` | PASS (exit 0) |
| `pnpm reachability` | PASS — every substantial module reachable or declared dormant |
| `git diff --stat 72b4d36..c404a24` | 12 files, 1853+/110- |

The known `tests/failover/controller-timeout.test.ts` flake was not chased, per the brief.

## What the independent verifier missed

**D-1** — the concurrent-send ack misattribution. G1R verified the optimistic-echo prohibition and the single-send failure paths thoroughly, but never drove two in-flight sends through one ack. The `requestedAckEventIds` guard, the channel-scoped stamp, and the missing `idempotencyKey` in the ack metadata combine into a silent drop that every existing test misses because they all exercise one pending send at a time. (Also NB-1's hollow test name and NB-2's mis-cited evidence location, both minor.)

## Tree state afterward

Clean. All five probe mutations restored; `git diff HEAD --stat` over `packages/ apps/ tests/ engines/` is empty; the scratch probe test file was deleted. The only file I created is this verdict.

---

**Bottom line:** fix D-1 (per-key ack correlation; one metadata field + one effect clause + one component test), address NB-1/NB-2 in passing, and this slice is approvable. Everything else — the byte budget, A6 totality, CO-1, A3, T-9 — survives adversarial execution from the chain's only non-Opus-5 seat.
