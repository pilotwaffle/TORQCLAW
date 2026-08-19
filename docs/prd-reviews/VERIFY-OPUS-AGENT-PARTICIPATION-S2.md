# VERIFY — PRD-TCLAW-AGENT-PARTICIPATION-007 S2 (agent collab MCP tools)

**Seat:** G1R independent verifier.
**Model disclosure:** The routing profile names **Opus 5** for this seat, and I **am**
`claude-opus-5`. **No substitution occurred.**
**Thread:** fresh; no authoring context.
**Repo:** `E:\TorqClaw`, branch `phase1-server-owned-authority`, HEAD `facf19b`.
**Range under review:** `fba9738..facf19b` (`d1abe09` feature, `facf19b` comment-only).

## VERDICT: **APPROVE WITH CONDITIONS** — one blocker (V-S2-1), and it is not in the
mechanism the brief flagged as highest risk.

The `_meta` identity channel — the thing I was told to attack hardest — **holds under
execution**. The blocker is elsewhere: the operator's speech ruling was implemented as
`capability: 'read'`, and `capability` is load-bearing for a **second consumer** the
builder did not evaluate. There, `'read'` is false, and the falsity is not cosmetic —
it lets a substrate-mutating tool into the `read_only` profile, whose entire purpose is
that nothing inside it has side effects. Proven by execution, not by reading.

---

## A. The `_meta` identity channel — VERIFIED SOUND

### A.1 Can anything client-supplied reach `callerCollabPrincipalId`? **NO.**

Full trace, every hop, with enclosing branch conditions:

| Hop | Location | Finding |
|---|---|---|
| Field definition | `packages/contracts/src/routing.ts:60` — `callerCollabPrincipalId: z.string().optional()` on `GatewayRequestSchema.payload` | Present on `GatewayRequest` only |
| ClientCommand surface | `packages/contracts/src/commands.ts:7-18` (`SUBMIT_PROMPT`), `:85-93` (`PREVIEW_ROUTE`) | **No ClientCommand variant carries any identity field.** Exhaustively checked all variants |
| zod strictness | `grep passthrough\|\.loose\|catchall\|strip()` over `packages/contracts/src/*.ts` → **zero hits** | zod v3 default **strips** unknown keys. A client sending `callerCollabPrincipalId` on a SUBMIT_PROMPT frame has it discarded at parse |
| Construction | `packages/gateway/src/enrich.ts:55` — `callerCollabPrincipalId,` inside an explicitly-built `payload: {...}` object literal (`:44`) | Built from `enrichCommand`'s **own 4th parameter**, never spread from `cmd`. Same discipline as `grantedTools: []` at `:52` |
| Live call site | `packages/gateway/src/server.ts:414-416` — `enrichCommand(cmd.data, sid, 'torq-console', agentCollabPrincipalId ?? undefined)` | Argument is `agentCollabPrincipalId`, a **connection-scoped local** (`server.ts:218`, `let ... : string \| null = null`) |
| Origin of that local | `server.ts:301-303`: `if (agentParticipationEnabled() && isAgentSurfaceCaller(caller.authClass, caller.binding)) { agentCollabPrincipalId = caller.binding!.principalId; }` | `caller.binding.principalId` is resolved server-side from a **verified credential** (S1 connection auth), not client-declared. Default when the branch does not fire: stays `null` → `?? undefined` |
| Other `enrichCommand` caller | `packages/gateway/src/preview.ts:48-61` | Passes **only 3 arguments** — 4th is `undefined`. Explicitly-built command literal, `cmd` never spread |
| Re-mint path | `packages/gateway/src/dispatch.ts:104-118` (`mintGrantedRequest`) — `payload: { ...orig.payload, ... }` | Spreads the **stored** `request_json`, which was itself gateway-built and re-validated by `GatewayRequestSchema.parse` (`server.ts:487`). No client input enters |
| Outbound-only parse | `packages/bridge/src/hermesAttempt.ts:284` | Validates a payload the gateway is **sending to** Python. Not an inbound client path |

**Conclusion: `metaIdentityClientInfluencable = false`.**

### A.2 Can a tool argument override or spoof it? **NO — proven by execution.**

`executeTool` (`registry.ts:322-333`) builds the `_meta` object itself:

```
...(callerCollabPrincipalId
  ? { _meta: { [COLLAB_CALLER_META_KEY]: callerCollabPrincipalId } }
  : {}),
```

The spread is conditioned **solely** on `executeTool`'s own 4th parameter. It is a
sibling key to `arguments: args`, not merged into it, so an `args._meta` cannot collide:
they occupy different properties of the `callTool` request object.

I ran three adversarial probes against the **built dist artifacts**:

| Probe | Setup | Result |
|---|---|---|
| S-1 | `callerCollabPrincipalId = undefined`, `args._meta` claims a real agent id, target = channel that agent IS a member of | **`COLLAB_IDENTITY_REQUIRED`**, DB rows before=0 after=0 |
| S-2 | `callerCollabPrincipalId = outsiderAgentId` (not a member), `args._meta` claims `agentId` (a member) — privilege escalation attempt | **`COLLAB_NOT_FOUND`**, rows before=0 after=0. The `_meta` claim was ignored; authority came from the real caller id |
| S-3 | `read_channel`, no caller id, `args._meta` claims agentId | **`COLLAB_IDENTITY_REQUIRED`** |

Re-run under three different orderings (first call in file; after a successful post;
after a failed post) — refusal was **consistent** in all three.

> **Probe-hygiene note against myself:** my first probe iteration reported a spoof
> succeeding. That was **my** bug — my local helper was `post = (args, id = agentId)`,
> so passing `undefined` fell through to the **default** `agentId` and no identity was
> ever actually absent. I caught it by re-running with an explicit isolate. Recording it
> because a verifier's false positive is as costly as a builder's false green.

### A.3 What happens when it is undefined? Is `toolFilter` the real boundary?

`toolFilter` is **defence in depth, not the boundary**. The boundary is the handler.

- `toolFilter.ts:53` (`predictTools`) and `:99` (`getToolsForTask`):
  `(t.sourceServerId !== COLLAB_TOOL_SERVER_ID || callerCollabPrincipalId !== undefined)`
  where `COLLAB_TOOL_SERVER_ID = 'collab'` (`:32`). Default of the param: `undefined`.
- Even bypassing the filter entirely — I called `bridge.executeTool('collab__post_message', ...)`
  **directly** with `undefined` caller id — the handler refuses
  (`collabAgentTools.ts:189-192` / `:239-242`, `principalId === null` arm) and **zero rows commit**.
- **Other task types:** `TOOL_ROUTING_MAP` now lists `collab__` for all five task types,
  so task type is not a gate; identity is. This is honest — the builder documented it at
  `toolFilter.ts:13-18` — and correct, since the handler refuses regardless.
- **FRONTIER:** not reachable. `executeTool` has exactly **one** production caller,
  `packages/inference/src/ollama.ts:394` (LOCAL_EDGE), which always forwards
  `req.payload.callerCollabPrincipalId`. FRONTIER uses Hermes's own toolsets and never
  consults the bridge registry for user loops (`toolFilter.ts:92`, `t.sourceServerId !== 'hermes'`).

---

## B. BLOCKER V-S2-1 — `capability: 'read'` lies to `sideEffectFor`, and `read_only` admits a substrate write

**`readClassificationMisleadsOtherConsumers = true`.**

### B.1 The RED is real — re-verified by my own mutation

I removed `post_message: 'read'` from `COLLAB_AGENT_TOOL_CAPABILITIES`
(`collabAgentTools.ts:153-156`), rebuilt `@torqclaw/gateway`, and re-ran:

```
× registration (OQ-6 mechanism proof) > connectInProcessServer registers ...
  → expected 'send' to be 'read'
× toolFilter identity gating (A2-d) > getToolsForTask: the RENDERED openAITools list ...
  → expected true to be false
× live boot, real server.ts registration call site > the SHIPPED server.ts call ...
  → expected 'send' to be 'read'
Tests  3 failed | 11 passed (14)
```

Capability falls through to `'send'` (write-class) and `requiresApproval` flips to `true`,
exactly as the builder reported. **The explicit entry is load-bearing and the tests are
not vacuous.** Restored; `git diff` clean.

### B.2 The consumer the builder did not evaluate

`packages/bridge/src/profilePolicy.ts:40-48`:

```
function sideEffectFor(tool: RegisteredTool): SideEffectClass {
  if (tool.capability === 'read') return 'none';        // <-- line 41
  if (tool.capability === 'exec') return 'process';
  if (tool.capability === 'send') return 'network_send';
  const namespace = namespaceOf(tool.name);
  if (namespace === 'filesystem') return 'filesystem_write';
  if (namespace === 'browser' || namespace === 'playwright') return 'browser_mutation';
  return 'process';                                      // default arm
}
```

`capability: 'read'` short-circuits at **line 41** to side-effect class `'none'`. This
is a **second, independent** meaning of the field, distinct from
`isWriteClass`/`requiresApproval`. Here `'none'` asserts *this tool mutates nothing* —
which for `collab__post_message` is **false**: it commits a row to `collab_events`.

That claim then feeds profile admission at `profilePolicy.ts:56-62`:

```
const allowed = tools.filter((tool) =>
  isNamespaceAllowed(tool, definition.allowedNamespaces) &&
  definition.allowedCapabilities.includes(tool.capability as CapabilityClass) &&
  definition.allowedSideEffects.includes(sideEffectFor(tool)),
);
```

And `read_only` (`packages/contracts/src/profile.ts:67-76`) is defined as:

```
allowedNamespaces: ['*'],        // <-- wildcard: 'collab' matches
allowedCapabilities: ['read'],   // <-- 'read' matches
allowedSideEffects: ['none'],    // <-- sideEffectFor() returned 'none', matches
scopes: { path: 'none', network: 'none' },
approvalRequirements: { write: false, exec: false, send: false },
```

All three filters pass. **`read_only` is the repo's most restrictive profile.**

### B.3 Proven by execution against the built artifacts

```
R-1 allowedOperationIds   = ["collab__post_message","collab__read_channel"]
R-1 operationCapabilities = {"collab__post_message":"read", ...}
R-1 operationSideEffects  = {"collab__post_message":"none", ...}   <-- FALSE claim
R-1 operationApprovals    = {"collab__post_message":false, ...}
R-1 sideEffectClasses     = ["none"]

R-2 executeTool('collab__post_message', {...}, resolveEffectiveProfile('read_only'), agentId)
R-2 outcome = RESOLVED
R-2 rows before= 0 after= 1  => COMMITTED? true          <-- a write under read_only

R-4 getToolsForTask('SUMMARIZATION','LOCAL_EDGE', read_only, agentId)
R-4 rendered = ["collab__read_channel","collab__post_message"]   <-- offered to the model
```

`assertOperationAllowed` **passes** it — correctly, per its own logic — because
`isOperationAllowed` (`profilePolicy.ts:118-129`) only checks that the profile snapshot's
recorded capability/side-effect **agree with the registry entry**. They agree. Both are
wrong in the same direction, so the consistency check cannot catch it.

`browser_research` correctly excludes it (`R-3 allowedOperationIds = []`) — but only
because its `allowedNamespaces` is `['browser','playwright','websearch']`, i.e. by
namespace accident, not by side-effect reasoning.

### B.4 Why this is a blocker and not a note

- The operator ruled **posting is free of *approval***. The operator did **not** rule that
  posting has **no side effect**. The implementation conflates the two because one field
  carries both meanings. `requiresApproval: false` is faithful to the ruling;
  `sideEffect: 'none'` is an unratified extra claim.
- `read_only`'s contract to a user selecting it is "nothing here mutates anything." That
  contract is now false, silently, for any task with a bound agent principal.
- **No existing test covers it.** I searched `tests/` for any assertion that `read_only`
  excludes a mutating tool — `profile-conformance-*.test.ts`, `profile-policy.test.ts`,
  `collab-c2-*.test.ts` — none assert this property. The gap is uncovered, not merely unfixed.
- It is the exact defect class this program has hit **seven** times: a claim asserted in
  one place and enforced (or believed) in another. Here the claim is `sideEffect: 'none'`
  and the believer is `read_only`.

### B.5 Suggested fix (operator's call — do not let a builder pick)

The clean separation is to stop overloading `capability`. Options, cheapest first:

1. **Special-case in `sideEffectFor`** — add, before line 41, a branch returning a truthful
   side-effect class for the `collab` namespace (e.g. a new `'substrate_write'` member of
   `SideEffectClassSchema`), then add it to whichever profiles should admit agent speech.
   `read_only` would then correctly exclude `collab__post_message` while keeping
   `collab__read_channel`. Preserves the operator's approval ruling exactly
   (`requiresApproval` stays driven by `capability: 'read'`), and fixes only the false claim.
2. **Split the field** — give `RegisteredTool` an explicit `sideEffect` set at registration
   rather than derived from `capability`. Structurally correct, wider blast radius, and it
   touches `policyHash` inputs (`profilePolicy.ts:82-96`) — needs its own review.

Either way the acceptance test must be: *`resolveEffectiveProfile('read_only').allowedOperationIds`
does not contain `collab__post_message`, and executing it under that profile commits zero rows* —
asserted against the built artifact, with a paired positive control on a profile that
should admit it.

---

## C. The seven OQ-6 protections

| # | Protection | Holds | Evidence |
|---|---|---|---|
| 1 | `assertOperationAllowed` runs | **YES** | `registry.ts:296-299`, inside `if (effectiveProfile)`. In-process entry is a normal `RegisteredTool` and passes through it. Confirmed live: R-2 executed it. **Caveat: it passes the tool — see V-S2-1. The protection *runs*; the data it evaluates is wrong.** |
| 2 | Path scope is a no-op **by evaluation** | **YES** | `registry.ts:314-320`: `if (entry.pathScope) { const mode = scopeModeFor(entry.capability); for (const p of extractPaths(args, entry.pathArgKeys)) { checkPath(...) } }`. Neither collab entry sets `pathScope`/`pathArgKeys` (asserted at `agent-participation-s2.test.ts:211-212`), so the loop body is skipped **because the machinery evaluated and found nothing**, not because the check was removed. `registry.ts:305-313`'s profile-path admissibility arm also still runs. Under `read_only` (`scopes.path: 'none'`) R-2 did not trip `:307` because `extractPaths` returned `[]` — correct |
| 3 | `requiresApproval` from the same expression | **YES** | `registry.ts:163` in the **shared** `registerFromConnectedClient` tail: `isWriteClass(cap) \|\| patterns.some((p) => p.test(t.name))`. Never hand-set. My mutation flipped it to `true` purely by changing `cap` — proving it is computed, not asserted |
| 4 | Capability is an EXPLICIT config decision | **YES** | `COLLAB_AGENT_TOOL_CAPABILITIES` (`collabAgentTools.ts:153-156`) passed at `server.ts:791-795`. Falsified by my mutation: omission → `'send'`, not `'read'` (`capability.ts:172` fail-closed default is `'write'`; name tokenisation to `post`→`P4_SEND` fires first). **Explicit, not by omission — as ruled.** Whether `'read'` is the *right* value is V-S2-1 |
| 5 | `toolFilter` gating, deny wins | **YES** | `collab__` added explicitly to all five `TOOL_ROUTING_MAP` entries (`toolFilter.ts:20-26`) — no silent-invisibility reliance. Plus the identity gate at `:53`/`:99`. Mutation-verified: deleting the identity gate turns both A2-d tests RED |
| 6 | Tool-error opacity (T-2) | **YES** | `mapStoreErrorToToolErrorText` (`collabAgentTools.ts:124-143`) returns `COLLAB_NOT_FOUND: ${message}` with the substrate's own message, unelaborated; the `default:` arm returns a bare `'COLLAB_UNAVAILABLE'` so no internal detail leaks. Verified live: hidden-channel and nonexistent-channel arms both produced `COLLAB_NOT_FOUND: Request could not be completed`, and my S-2 probe (outsider → member channel) got the **identical** string. Neither arm contains "member" |
| 7 | B-2 — in-process not user-configurable | **YES, BOTH LAYERS** | **Runtime:** `serverConfig.ts:12-23` `discriminatedUnion` admits exactly `stdio`/`streamable-http`; a `{"type":"in-process"}` file fails `safeParse` and `loadServerConfigs` returns `[]`. **Compile-time — I executed the mutation:** adding a third union member produced `packages/bridge/src/serverConfig.ts(106,64): error TS2339: Property 'url' does not exist on type '... \| { type: "in-process"; }'` and `(106,88)` for `token`, `EXIT=2`. **`facf19b`'s claim that the ternary is load-bearing is TRUE** — widening the schema cannot ship without a build failure at that expression. Restored |

---

## D. A6 / T-9 — wire-surface totality

### D.1 Field-by-field validators, with enclosing branch and defaults

| Field | Tool | Validator (`file:line`) | Enclosing branch / default | Reachable |
|---|---|---|---|---|
| `channelId` | both | `collabAgentTools.ts:179` / `:230` — `z.string().min(1)` | Required, **no default**; MCP SDK validates pre-handler | YES |
| `channelId` (semantic) | both | `packages/collab/src/store.ts` predicate chain → `notFound()` | Reached only after schema pass; returns `COLLAB_NOT_FOUND` for both hidden and absent | YES |
| `afterCursor` | read | `collabAgentTools.ts:180-182` — `z.string().default('0')` | **Default `'0'`**; substrate re-validates: `COLLAB_INVALID_REQUEST: Cursor must be an unsigned base-10 integer without leading zeroes` / `Cursor out of representable range` | YES |
| `limit` | read | `collabAgentTools.ts:183-185` — `z.number().int().min(1).max(100).default(50)` | **Default `50`**; `0`, `10000`, `1.5` all rejected pre-handler with MCP `-32602` | YES |
| `text` | post | `collabAgentTools.ts:231` — `z.string().min(1).max(65536)` (`MESSAGE_TEXT_SCHEMA_MAX_LENGTH = 16384*4`, `:108`) | Required, no default. **Coarse pre-check only** | YES |
| `text` (raw UTF-8 bound) | post | `packages/collab/src/text.ts:122` — `if (rawBytes > 16384)` after `nfcText = raw.normalize('NFC')` (`:115`) | Post-NFC. Verified: `'€'.repeat(5462)` = 16,386 raw bytes → `COLLAB_INVALID_REQUEST` | YES |
| `text` (JSON-encoded bound) | post | `packages/collab/src/text.ts:137` — `if (jsonBytes > 16384)` | Post-NFC, **after** the raw check | YES — see D.2 |
| `text` (control chars) | post | `text.ts:145-157` — C0/C1 except TAB/LF/CR | Verified: `'\u0000bad'` → `COLLAB_INVALID_REQUEST: ... U+0000` | YES |
| `idempotencyKey` | post | **Not in the schema at all** (`:229-236`); minted at `:255` via `crypto.randomUUID()` | Model has no argument to influence it. Asserted at test `:340-343` | N/A — correctly absent |

### D.2 The dual byte bound — tested specifically, as instructed

`'\n'.repeat(16384)`: raw UTF-8 = 16,384 bytes → **passes** `text.ts:122`. JSON-encoded
(each `\n` becomes the two characters `\` `n`) = 32,768 bytes → **fails** `text.ts:137`.

Executed against the built artifact:

```
D1 threw= true
   msg= COLLAB_INVALID_REQUEST: Message text must not exceed 16,384 bytes when JSON-encoded (after normalization)
```

**Both bounds are reachable and both are enforced.** The residue is correctly enumerated
in `collabAgentTools.ts:97-107` and correctly stated as *not* expressible in the JSON
Schema grammar.

### D.3 Totality hunt — can any admitted input throw out of the handler?

I fired malformed inputs at both tools through `executeTool` against the built dist:

| Input | Outcome |
|---|---|
| `{channelId: 123, text:'x'}` | MCP `-32602` validation error (mapped, no crash) |
| `{channelId: <valid>, text: null}` | MCP `-32602` |
| `{channelId: <valid>}` (missing `text`) | MCP `-32602` |
| `{}` | MCP `-32602` |
| `{... text:'x', limit:'abc'}` (extra unknown key) | **RESOLVED** — extra key ignored, post committed. Correct: unknown args are stripped, not fatal |
| `{... text: '\u0000bad'}` | `COLLAB_INVALID_REQUEST: ... U+0000` |
| `{... text: 'a'.repeat(70000)}` | MCP `-32602` (schema maxLength) |
| `afterCursor: 'not-a-number' / '-5' / '9999…'` | `COLLAB_INVALID_REQUEST`, mapped |
| `limit: 0 / 10000 / 1.5` | MCP `-32602` |
| caller id = unknown principal | `COLLAB_NOT_FOUND: Request could not be completed` |
| caller id = `''` (empty string) | `COLLAB_IDENTITY_REQUIRED` — `:112`'s `v.length > 0` treats empty as absent. Correct fail-closed |

**`totalityHoles = []`.** Every handler path is wrapped in `try/catch` returning
`isError: true` (`collabAgentTools.ts:207-215`, `:265-267`), the catch is total
(`mapStoreErrorToToolErrorText`'s `default:` arm handles non-`CollabError` and non-`Error`
throws), and `executeTool:334-337` converts `isError` into a thrown `Error` that
`ollama.ts`'s existing tool-call `try` already handles. **No unhandled rejection path
found** — which matters, because a gateway handler throw kills the process.

---

## E. The disclosed residual — runaway poster

**Builder's claim VERIFIED, in all three parts:**

1. **The only rate limiter governs auth attempts.** `packages/collab/src/ratelimit.ts` —
   `AuthRateLimiter` (`:249`), credential/address buckets, `ConnectOutcome` includes
   `'rate_limited'` (`observability.ts:11`). It is a **connect-time** control.
2. **Serialization is ordering, not rate.** `store.ts:1436-1437` —
   `withReadThenSequencer(() => this.mutex.withLock(...))`. A mutex serialises; it does
   not throttle.
3. **Nothing else exists.** Grepping `rateLimit|throttle|RateLimit` across
   `packages/collab/src` and `packages/gateway/src` returns only `ratelimit.ts` (auth) and
   the builder's own honest comment. **No per-principal or per-channel post-rate limiter.**

What actually bounds a runaway poster today: the 16,384-byte per-post ceiling, and nothing else.

### Ruling: **ship as-is** (`shipAsIs = true`), conditioned on the blocker being fixed first.

Reasoning:
- **S2 has no production trigger.** `executeTool`'s only production caller is
  `ollama.ts:394`, which forwards `req.payload.callerCollabPrincipalId` — and **nothing in
  this repo sets that field**. `server.ts:414` passes `agentCollabPrincipalId`, which is
  `null` on every connection that can reach `SUBMIT_PROMPT`, because `authz.ts` denies
  `SUBMIT_PROMPT` to role `node` (the only seat an agent connection can hold). The only
  caller today is a test harness. This is documented, not discovered — `routing.ts:52-58`
  and `enrich.ts:19-23` both say so plainly.
- The operator ruled turn caps out **on cost grounds** (R-2). A rate limit is not a cost
  control; it is an abuse/usefulness control, so R-2 does not pre-empt it.
- **The bound belongs with S3, not S2**, and S3 already owes a STOP control (R-3a). Adding
  a rate limiter now would bound a loop that cannot yet run, while S3 must ship the human
  control regardless.

**Condition on S3, recorded here so it is not lost:** S3 must not ship the auto-reply loop
until *either* the STOP control (R-3a) *or* a per-principal post-rate bound exists. S2's
residual is acceptable **only** because S2 cannot be triggered. The moment S3 supplies a
dispatch-time binding, this residual becomes live and unmitigated.

---

## F. The seven-instance pattern — every new test checked

**Would each new test fail against unfixed code?** I verified by mutation, not by reading.

| Test | Fails against unfixed code? | Evidence |
|---|---|---|
| `s2: connectInProcessServer registers ... (OQ-6 mechanism proof)` | **YES** | Capability mutation → `expected 'send' to be 'read'` |
| `s2: A2-a member ONE row / non-member ZERO` | **YES** | Paired positive control **in the same test** — a universally-broken tool fails the positive arm. This is the correct construction |
| `s2: T-2 byte-identical COLLAB_NOT_FOUND` | **YES** | Asserts both arms match `/^COLLAB_NOT_FOUND:/` **and** that neither contains "member". An enriched error fails it |
| `s2: A2-c two events, distinct keys` | **YES** | Asserts `parsed1.eventId !== parsed2.eventId` **and** DB count `before + 2`. A text-derived key collapses both |
| `s2: COLLAB_IDENTITY_REQUIRED on undefined` | **YES** | Independently reproduced (probes S-1/S-3, three orderings) |
| `s2: T-9 residue (€ × 5462)` | **YES** | Real byte-bound crossing; reproduced |
| `s2: throw-class totality (`channelId: ''`)` | **WEAK — see below** | |
| `s2: B-2 servers.json rejects third transport` | **YES** | Independently reproduced: `loadServerConfigs()` → `[]` |
| `s2: B-2 connectServer source-level structural guard` | **PARTIAL — see below** | |
| `s2: A2-b read member / non-member` | **YES** | Both arms asserted, positive control present |
| `s2: outsider agent cannot read member channel` | **YES** | Reproduced as probe S-2 variant |
| `s2: predictTools identity gating` | **YES** | Identity-gate mutation → `expected true to be false` |
| `s2: getToolsForTask rendered list + requiresApproval` | **YES** | Same mutation → RED; also RED under the capability mutation |
| `s2-registration-live: real dist/server.js boot` | **YES** | Capability mutation → `expected 'send' to be 'read'` on the **booted artifact** |
| `profile-conformance-caller-audit` (modified) | **YES** | Pre-existing compiler-API audit; the diff extends its expected-arg list to include the new 4th param. It fails closed on non-forwarding shapes (its own third test proves this) |

**`testsThatPassAgainstUnfixedCode`** — two weak ones, neither a blocker:

1. **`throw-class totality: channelId: ''`** — asserts only `.rejects.toThrow()` with **no
   matcher**. Any throw satisfies it, including a wrong one. It would stay green if the
   handler leaked a raw internal error. *(Note, not blocker: the T-2 test above does pin
   message shape for the codes that matter, so the property is covered elsewhere.)*
   Suggested tightening: assert the message matches the mapped taxonomy.
2. **`B-2 connectServer source-level structural guard`** — a **string search** over
   `dist/registry.js` for `InMemoryTransport`. It is the weaker half of B-2 and would pass
   against several broken refactors (e.g. an aliased import). *(It is however backed by the
   genuinely strong compile-time layer I verified in §C row 7, so the property itself is
   well-defended.)*

**`testsDrivingReplicas` — NONE.** Every S2 test imports the **built dist artifacts**
(`packages/bridge/dist/index.js`, `packages/gateway/dist/collabAgentTools.js`,
`.../collabSurface.js`, `.../collabIdentity.js`), and the live test imports
`dist/server.js` and reads the **real registry**. `registerCollabTools()` calls the real
`connectInProcessServer` over a real `InMemoryTransport`. **B-S0-1 is not repeated.**

---

## G. Gates — all run by me, on this tree

| Gate | Result |
|---|---|
| `pnpm build` | **PASS** — 8/8 tasks. Run **before** any dist-dependent judgement, and again after restoring every mutation |
| `npx vitest run` (targeted five files) | **PASS — 63/63**, 5 files |
| `npx vitest run` (full suite) | **2211 passed, 9 skipped, 1 failed / 3 files failed** — all three failures are `ETIMEDOUT` on the shared gateway **build lock** (`Gateway build failed; timeout=true; spawnError=ETIMEDOUT; lockPath=...`), i.e. cold-start contention, not assertions |
| Re-run of those three files, warm | **PASS — 57/57** (`collab-secret-store-live-wire`, `auth-v2-phase1`, `agent-participation-s1`). **Effective: 2214 pass, 0 real failures** |
| `npx tsc --noEmit -p packages/bridge` | **PASS** (exit 0) |
| `npx tsc --noEmit -p packages/gateway` | **PASS** (exit 0) |
| `npx tsc --noEmit -p packages/contracts` | **PASS** (exit 0) |
| `npx tsc --noEmit -p packages/inference` | **PASS** (exit 0) |
| `pnpm reachability` | **PASS** — "every substantial module is reachable or declared dormant" |
| B-2 compile-time mutation | **PASS** — widening the union fails to compile (`TS2339` ×2, exit 2) |
| Capability-omission mutation | **RED reproduced** — 3 tests fail, incl. live-boot |
| Identity-gate deletion mutation | **RED reproduced** — 2 A2-d tests fail |
| `tests/failover/controller-timeout.test.ts` | Known flake — not chased, per instruction |

**Trap compliance:** `python3` never used (probes were vitest/TypeScript). No PowerShell
`-replace`. All packages rebuilt (`pnpm build`) before every dist-dependent judgement and
after every restore. Every cited line quoted with its enclosing branch condition and each
variable's default.

---

## H. Notes (not blockers)

- **N-S2-1 — `MESSAGE_TEXT_SCHEMA_MAX_LENGTH` comment typo.** `collabAgentTools.ts:104`
  reads "int0entionally". Cosmetic.
- **N-S2-2 — `randomIdempotencyKey`'s comment is self-contradicting.**
  `collabAgentTools.ts:275-279` says a local import "is unnecessary here" while describing
  one; it also uses the `crypto` **global** rather than an import. Works on the supported
  Node, but the comment does not describe the code.
- **N-S2-3 — N-3 (FRONTIER re-routing) is disclosed, not measured.** `toolFilter.ts:16-18`
  names the `TOOL_COUNT_OVERFLOW` risk (`router/src/engine.ts:142`, `requiredTools.length > 3`)
  and claims it is "measured in this slice's own tests". I found **no test asserting a tier
  decision** with collab tools present. The gate is real: `predictTools` now returns 2 extra
  tools for an identity-bound task, and `SUMMARIZATION`'s base list is 1 (`filesystem__`), so
  3 total — **at** the threshold, not over. `ROUTINE_AUTOMATION`/`COMPLEX_CODING` would exceed
  it, but only for a task with a bound principal, which cannot exist today. Real once S3 lands;
  worth an explicit test then.
- **N-S2-4 — the `'collab'` literal is duplicated.** `toolFilter.ts:32` hard-codes
  `COLLAB_TOOL_SERVER_ID = 'collab'` to mirror `collabAgentTools.ts:95`. The comment claims
  "a source-level test pins that this literal matches the gateway-side constant" — I could
  not find that test. Layering rationale (bridge below gateway) is sound; the drift guard
  appears to be missing.

---

## I. Bottom line

The mechanism is right. `InMemoryTransport` + `registerFromConnectedClient` genuinely
produces **one** registration path and **one** dispatch path — I confirmed by mutation that
the shared tail computes capability and approval for the in-process server exactly as for a
remote one. The `_meta` identity channel resists every spoof I could construct, including
privilege escalation with a valid-but-different caller. B-2 holds at **both** layers, and
`facf19b`'s compile-time claim is true. Error opacity holds. Totality holds.

The one real defect is that a single field was asked to carry two meanings, and the second
meaning was never checked. `requiresApproval: false` faithfully implements the operator's
speech ruling. `sideEffect: 'none'` is a claim nobody ruled on, and it is false — with the
concrete consequence that `read_only`, the profile whose whole promise is "nothing here
mutates," now offers the model a tool that writes to a shared substrate, and executing it
commits a row.

Fix V-S2-1, add the missing coverage, and S2 earns approval.
