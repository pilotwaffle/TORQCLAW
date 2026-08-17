# Independent Verification — PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3 (composer / POST_CHANNEL_MESSAGE)

**Seat:** G1R independent verifier
**Model:** `claude-opus-5` — the routing profile names Opus 5 for this seat and I *am* Opus 5. **No substitution applies.**
**Branch:** `phase1-server-owned-authority` · HEAD `72b4d36` · work UNCOMMITTED in the working tree
**Date:** 2026-08-17
**Method:** verification by execution — mutation probes, adversarial string construction, live-handler hostile-input driving. Not by reading.

---

## VERDICT: **APPROVE_WITH_CONDITIONS**

The slice is substantively correct. The dual byte bound — the heart of S3 — is **provably exact**: I constructed adversarial strings across every class named in the review brief and the composer's client-side budget agreed with the substrate's server-side decision on **every single one, with zero mismatches**. A6 totality holds across the whole `socket.on('message')` path: I drove the real handler with hostile `channelId` and `text` inputs the contract still admits and **nothing threw**. A3 is structurally enforced, not merely ignored. All eight gates are green.

One condition, non-blocking but real: **the `callerFor` 'agent' fallback is unpinned.** I flipped it to `'operator'` and the entire 38-test suite stayed green. The behavior the builder disclosed is true in the source as written; nothing prevents a future edit from silently reversing it. Detail in C-1 below.

---

## Builder's three disclosures — independently verified

### 1. "ERROR frames never reach the console's events array" — **TRUE, and genuinely pre-existing**

Verified by execution, not inspection:

```
sendErr frame parses? false
missing: id, requestId, sessionId, tier, message, timestamp
```

`sendErr` (`packages/gateway/src/server.ts:183-184`) emits `{type:'ERROR', code, detail}`. `GatewayEventSchema` (`packages/contracts/src/events.ts:19-29`) requires `id`, `requestId`, `sessionId`, `tier`, `message`, `timestamp` — six required fields, all absent. `useGatewayStream.ts:45-49` runs `GatewayEventSchema.safeParse` and `return`s on failure with a `console.warn`. The frame is dropped.

**Pre-existing confirmed:** `sendErr` predates this slice entirely — it is the shared error path for `MALFORMED_JSON`, `AUTH_FAILED`, `ROLE_MISMATCH`, and the committed S1 arms (`df49276`). Every ERROR frame from every command has always been dropped client-side. This is not S3's regression and is correctly out of scope.

**Does the composer's honesty machine misrepresent rejection as timeout?** It degrades to `'timeout'` after `TIMEOUT_MS` with the label `"no response — retry"`. That is *literally accurate* — no response did arrive, because the frame was dropped. It does not claim success, does not render the message as sent, and offers retry with the same idempotency key. This is no worse than S1/S2's precedent and is arguably the most honest available rendering given the transport. Not a blocker; recorded as carried obligation CO-S3-1.

### 2. "callerFor falls back to 'agent', never 'operator'" — **TRUE in source, UNPINNED by tests**

Source reads correctly (`collabSurface.ts` `resolvePrincipalKindForCaller`): all three exits — no-DB, lookup-miss (`?? 'agent'`), and throw (`catch`) — return the less-privileged literal. No path yields `'operator'` for a non-operator principal.

**But:** I mutated all three to `'operator'` and ran the suite:

```
Test Files  1 passed (1)
Tests  38 passed (38)
```

**Green.** The test at line 212 is *named* `"CO-1: callerFor derives kind='agent' ... verified via a lookup-failure fallback probe"` but asserts only that the call succeeds — which is true for either literal. The test file itself concedes this at line 247-249 ("succeeds regardless of the kind lookup miss"). This is the repo's recurring **unenforced-claim pattern**: the invariant is real, believed, correctly implemented, and pinned by nothing.

Severity is genuinely low — `caller.kind` is read nowhere in `store.ts` (I confirmed by grep), so this is not a live escalation. But the builder's own comment explains the value exists *precisely* so a future security-relevant read doesn't inherit a lie, and the test named after that guarantee does not enforce it.

### 3. "auth-v2-phase1 hash re-pin is mechanical" — **TRUE, verified byte-exactly**

```
current authz.ts sha256: cb2b76b454cd55a36c569b3cf06359bf7f633c8c2f76f9643d456d412623cb27
test pins:               cb2b76b454cd55a36c569b3cf06359bf7f633c8c2f76f9643d456d412623cb27
```

Exact match. The `authz.ts` change adds one `case 'POST_CHANNEL_MESSAGE':` falling through to `DENY_NOT_PERMITTED` plus a doc-comment entry. **It grants nothing** — it is a deny arm on the non-operator switch, and the frozen-path assertion, the `not.toContain('export function checkResumeRole')` marker, and every surrounding assertion retain full strength.

---

## The dual byte bound — adversarial construction

The composer computes `overCap = rawBytes > 16384 || jsonBytes > 16384` on `raw.normalize('NFC')`, matching `text.ts:115` (NFC first), `text.ts:122` (raw bound), `text.ts:137` (JSON bound). I built my own adversarial corpus and compared the client decision against the server decision case by case:

| case | chars | rawB | jsonB | server rejects | client blocks | mismatch |
|---|---|---|---|---|---|---|
| newline ×16384 | 16384 | 16384 | 32768 | yes | yes | — |
| backslash ×16384 | 16384 | 16384 | 32768 | yes | yes | — |
| quote ×16384 | 16384 | 16384 | 32768 | yes | yes | — |
| backslash ×8192 | 8192 | 8192 | 16384 | no | no | — |
| backslash ×8193 | 8193 | 8193 | 16386 | yes | yes | — |
| tab ×8192 / ×8193 | — | 8192/8193 | 16384/16386 | no/yes | no/yes | — |
| CJK ×5461 / ×5462 | — | 16383/16386 | same | no/yes | no/yes | — |
| emoji ×4096 / ×4097 | — | 16384/16388 | same | no/yes | no/yes | — |
| ascii ×16384 / ×16385 | — | 16384/16385 | same | no/yes | no/yes | — |
| NFC-shrink (e+combining acute) ×8192 | 16384 | 16384 | 16384 | no | no | — |
| **NFC-grow devanagari U+0958 ×2731** | 2731 | 16386 | 16386 | yes | yes | — |
| NFC-grow devanagari ×3000 | 3000 | 18000 | 18000 | yes | yes | — |
| empty / space-only / single combining | — | 0/3/2 | — | yes/no/no | yes/no/no | — |

**Zero mismatches across every case.** The live budget never tells the user "within budget" for text the server would reject.

The NFC-grow case is the strongest evidence: `U+0958` decomposes *upward* under NFC (3 bytes → 6 bytes), so 2,731 characters — a sixth of the character cap — exceeds the byte cap. The composer catches it because it normalizes before counting. A naive counter would not.

**`Math.max(rawBytes, jsonBytes)` is provably `jsonBytes`:** I exhaustively swept all 1,112,064 valid codepoints and found none where JSON encoding shrinks a string. The `Math.max` is therefore correct but redundant — harmless, and defensively correct if JSON escaping semantics ever changed.

**On the contract's `z.string().max(16384)` character bound:** it is a *character* count where the substrate enforces *bytes*, so it is deliberately coarser. Critically, it is coarse in the **safe direction** — it can never admit something the byte bound would reject *without the substrate also rejecting it*, because any string ≤16,384 characters that exceeds 16,384 bytes is caught server-side and returned as a structured `COLLAB_INVALID_REQUEST` (I proved all eleven such cases resolve, never throw). The residue is real, enumerated in T-9 part 2, and correctly handled. Not a gap.

---

## A6 totality — whole-path trace, driven live

I drove the real handler through a live in-memory store with every hostile input the contract still admits:

**Hostile `channelId`** (contract admits any non-empty string — verified: SQL injection, `__proto__`, `constructor`, 100k chars, NUL byte all parse successfully): every one resolved to `COLLAB_NOT_FOUND`. **Zero throws.** SQLite parameter binding means the injection string is inert data; `__proto__`/`constructor` are ordinary bound strings, not property lookups.

**Hostile `text`** (11 classes): every one resolved to either `COLLAB_INVALID_REQUEST` or acceptance. **Zero throws.**

```
NUL byte => COLLAB_INVALID_REQUEST      16384 newlines => COLLAB_INVALID_REQUEST
BEL => COLLAB_INVALID_REQUEST           16384 backslashes => COLLAB_INVALID_REQUEST
RTL override => ACCEPTED                16384 quotes => COLLAB_INVALID_REQUEST
line separator => ACCEPTED              CJK 5462 => COLLAB_INVALID_REQUEST
lone surrogate => ACCEPTED              emoji 4097 => COLLAB_INVALID_REQUEST
                                        devanagari NFC-grow 2731 => COLLAB_INVALID_REQUEST
```

The **lone surrogate** case is the one I most expected to break totality — an unpaired `\uD800` reaching `publishOnly`'s `GatewayEventSchema.parse` and then the session bus. It was accepted and did not throw. (`JSON.stringify` escapes lone surrogates as `\ud800` rather than throwing; only `TextEncoder` would substitute U+FFFD, and that path is byte-counting only.)

**Path outside the handler's try/catch.** The `server.ts` dispatch arm (lines 649-671) contains: a `collabSurfaceCommandsEnabled()` call (pure env reads over a `Set`, no throw), four `cmd.data.*` field reads on an already-validated discriminated-union member, the awaited handler call, and `sendErr`. `publishOnly` — the throwing validator that T-9 part 3 explicitly warns about — sits **inside** `handlePostChannelMessage`'s try/catch, so it is netted. `sendErr`'s `JSON.stringify` receives `{type, code, detail}` where `detail` is a `string | undefined` derived from `err.message`; `socket.send` on a closed socket is the pre-existing shared risk across every command, unchanged by S3.

**I could not find an admitted input that throws.**

---

## A6(a) citation audit — each verified at the line *and* its enclosing branch

| field | cited | points at claim | reachable | note |
|---|---|---|---|---|
| `text` | `text.ts:110` `normalizeMessageText`, bounds `:122`/`:137`, NFC `:115` | **yes** | **yes** | Read the enclosing branches: `:122` is `if (rawBytes > 16384)` inside the function body, unconditional after NFC at `:115`. `:137` is `if (jsonBytes > 16384)`, also unconditional. Called from `store.ts:1428` **before** the sequencer/predicate — confirmed at `store.ts:1427-1431`, converting the return value into `throw new CollabError('INVALID_REQUEST', ...)`. No guard gates either bound. |
| `channelId` | `store.ts:2032` `assertChannelVisible` | **yes** | **yes** | Verified the enclosing condition: it is the **predicate slot** passed to `runKeyedCommand` at `store.ts:1445`, and `runKeyedCommand` calls `predicate(this.env.db)` at line 2205 **before** the idempotency lookup. So it runs on every call, including replays. Both `throw notFound()` arms (absent channel; missing-or-inactive membership) confirmed byte-identical. |
| `idempotencyKey` | **nothing** in substrate; `migration.ts:137` is `TEXT NOT NULL` with no CHECK; `runKeyedCommand` treats it opaquely | **yes — the negative claim is accurate** | n/a | Confirmed: `z.uuid()` is the sole enforcement. **Assessed as sufficient.** The emitted schema carries a canonical UUID pattern; I probed `__proto__`, embedded newlines, NUL bytes, SQL injection, and a 3,600-char repeat — **all rejected at the contract boundary**. The key is used only as a bound SQLite parameter in a 3-column lookup and in a SHA-256 hash comparison. Nothing downstream is poisonable by a valid-UUID-but-hostile key: the accepted set is 32 hex digits plus 4 hyphens, which has no injection, traversal, or prototype surface. Nil and max UUIDs are accepted (correctly — they are canonical); reusing one collides only within the caller's *own* `(principal_id, command, key)` namespace, yielding a structured `IDEMPOTENCY_CONFLICT`. |

**No field is graded green on an uncited validator.**

---

## T-9 probes re-run — RED independently reproduced

I re-ran four mutation probes myself using **structured `Edit` calls only** (no `python3` — which does not exist on this host; no PowerShell `-replace`). Contracts `dist` was rebuilt before probing. Three reproduced RED; one exposed the gap in C-1.

**Probe A — drop the JSON-encoded byte bound** (`overCap: rawBytes > MAX` only): **RED reproduced.**
```
FAIL tests/channels-panel.test.tsx:536
T-9/residue: 16,384 newlines ... expect(screen.getByText(/over limit/))
Tests  1 failed | 33 passed
```

**Probe B — remove NFC normalization** (`const nfcText = raw`): **RED reproduced.** `Tests 1 failed | 33 passed`.

**Probe C — clear pending on ack alone** (drop `confirmedIds.has(...)`, i.e. introduce optimistic echo): **RED reproduced.**
```
× OPTIMISTIC ECHO IS FORBIDDEN: the message renders as SENT only after the
  store commit ack triggers a re-read AND that re-read actually contains it
Tests  1 failed | 33 passed
```

**Probe D — flip `callerFor` fallback to `'operator'` (all three exits): GREEN — RED NOT reproduced.** See C-1.

All mutations reverted; `git diff --stat` confirms the tree is byte-identical to the original 10-file diff.

---

## Optimistic echo — asserted on the DOM, not on intent

The forbidden-echo rule is enforced structurally: the *only* code that removes a `pendingSends` entry is the confirm effect, and its filter requires `confirmedIds.has(p.ackedEventId)` where `confirmedIds` is built from `snap.events` — populated exclusively by `GET_CHANNEL_TIMELINE` responses. The post ack alone moves the entry `'sending' → 'awaitingConfirm'` and triggers a re-read; it never clears.

The tests assert on rendered DOM (`closest('li').className` matching `border-dashed`, occurrence counts, `p.font-reading` presence), not on intent. Probe C proves the assertion has teeth. **Correct.**

## Idempotency lifecycle — driven, not read

Verified by the component tests plus Probe C's driving: a key is minted **per draft** (`useEffect` on null key), retry reuses `p.idempotencyKey` **unchanged**, `resetComposer` mints a **new** UUID after a successful send, and the key comes from `crypto.randomUUID()` — **never derived from text**. The "new message gets a new key" test compares two keys for inequality; the retry test compares for equality. Both are real assertions.

## CO-1 / A3

- **Null principal:** `handlePostChannelMessage` returns `COLLAB_IDENTITY_REQUIRED` as its *first statement*, before `getStore()` — nothing can post. Verified live.
- **No operator bypass:** a non-member principal posting to a channel it cannot see gets `COLLAB_NOT_FOUND`, byte-identical to the nonexistent case. Verified live. The seat lattice cannot reach the substrate: `authz.ts` denies `POST_CHANNEL_MESSAGE` for `channel` and `node` seats explicitly.
- **A3 structural:** the emitted schema carries `additionalProperties: false` and `required: [action, channelId, text, idempotencyKey]`. I submitted `{author, principalId, actorPrincipalId, kind}` alongside a valid command — parse succeeded and the resulting data keys were exactly `['action','channelId','text','idempotencyKey']`. **The contract carries no author field at all.** Spoofing is structurally impossible, not merely ignored.
- **`storeDb` plumbing:** `setCollabSurfaceStoreForTest` nulls `storeDb`, so a test store cannot inherit a production handle. `getStore()` assigns `storeDb` and the store's `db` from the *same* `getCollabDb()` expression — no way to get a divergent handle. `resolvePrincipalKindForCaller` falls back to `'agent'` when `storeDb` is null rather than lazily opening a second DB — this is the fix for the builder's self-caught stray-`collab.db` bug and it is correct.

## No test weakened

`POST_CHANNEL_MESSAGE` was removed from `DANGEROUS_ACTIONS`, which looks like a loosening. **It is not.** The read-only T-11 test (line 179) asserts `READ_ONLY_ALLOWLIST.has(a)` — a strict two-element set that still excludes `POST_CHANNEL_MESSAGE` — *before* the `DANGEROUS_ACTIONS` check at line 180. The allowlist assertion is strictly stronger and unchanged. The new S3 T-11 test uses `S3_ALLOWLIST` per §14's explicit "the composer's post is the only addition to the allowlist". No matcher loosened; no assertion lost strength. `auth-v2-phase1.test.ts` changed only the SHA constant and its comment.

---

## Conditions

### C-1 (condition, non-blocking) — pin the `callerFor` least-privilege fallback

**Detail:** all three fallback exits in `resolvePrincipalKindForCaller` can be flipped to `'operator'` with the full 38-test suite staying green. The test named for this guarantee asserts only call success.

**Failure scenario:** a future refactor "simplifies" the fallback to `'operator'` (a natural mistake — the pre-S3 code hardcoded exactly that). Today it is inert because `caller.kind` is unread in `store.ts`. The moment any future substrate check reads `caller.kind` — which is precisely the eventuality this code was written to guard against — every lookup-failure path silently claims operator authority. No test fails.

**Suggested fix:** export a narrow test seam (or assert via a store spy) capturing the `CallerContext` handed to `postChannelMessage`, and assert `kind === 'agent'` when the kind-lookup DB is pointed at an empty database, and `kind === 'agent'` for an agent principal against the real fixture DB. Two assertions; no production change required.

### C-2 (recorded, no action) — CO-S3-1: ERROR frames are invisible to the console

Pre-existing and out of S3's scope, but it means the composer's `'timeout'` state is currently the *only* rendering for a server rejection. Recommend filing as an explicit carried obligation so it is not rediscovered a fourth time. The fix (give `sendErr` a schema-conformant envelope) is a gateway-wide change and correctly does not belong to this slice.

---

## Gate results — all run by me, none trusted from the report

| gate | result |
|---|---|
| `pnpm --filter @torqclaw/contracts build` | **PASS** — 8 schemas emitted to both targets |
| `npx vitest run tests/collab-surface-post.test.ts tests/channels-panel.test.tsx` | **PASS** — 72/72 |
| `npx vitest run tests/authz.test.ts tests/auth-v2-phase1.test.ts tests/collab-identity.test.ts tests/connection-auth.test.ts` | **PASS** — 108/108 |
| `npx tsc --noEmit -p packages/gateway/tsconfig.json` | **PASS** — exit 0 |
| `npx tsc --noEmit -p apps/console/tsconfig.json` | **PASS** — exit 0 |
| `node ops/reachability.mjs` | **PASS** — 120 modules reachable, 3 declared dormant |

Working tree restored clean — `git diff --stat` byte-identical to the original 10-file diff (1078 insertions, 110 deletions). Temporary probe file deleted. No source file left modified. Stray `~/.torqclaw/collab.db*` files left untouched per instruction.
