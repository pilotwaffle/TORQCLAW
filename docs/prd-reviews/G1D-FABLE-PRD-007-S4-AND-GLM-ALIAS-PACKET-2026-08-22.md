# G1D Implementation Packet — PRD-007 S4 Presence + GLM-5.3 alias binding (2026-08-22)

**Author:** Claude Fable 5 (G1D). **Base:** `origin/master` @ `4252a6a` (PR #53). **Profile:** session-scoped Claude-only governed routing; G1R/verifier/G2A seats = fresh `claude-opus-5` threads (substitutes for 4.7/4.8, recorded as such).

**Operator rulings recorded from the directive "finish building what's next until all is completed" (2026-08-22):**
- **OQ-2 — GRANTED by directive:** the "working now" side-channel is an explicit entitlement, **co-members only**, disclosing exactly `{principalId, displayName, working, since}`. G1R must challenge this as a trust-boundary decision.
- **OQ-5 — unchanged:** silence is the model's judgment (A3-f); no gateway-side rule this slice.
- **OQ-1 — already discharged** by `FileSecretStore` (`9b544ee`); no work here.
- **GLM alias — accepted as `env_bound`** (see Item B); the honest label replaces the unobtainable provider attestation.

---

## Item A — S4 Presence: Members (server-side) + working overlay

### Objective
Co-members of a channel can see (1) who is a member, labeled honestly as human/owner vs agent (S6), and (2) which agent members are **working now**, live, without any client-supplied state, without leaking task/prompt/tier/tool/cost, and without writing to `collab_events`.

### Existing system (verified, file:line)
- `collab_members` (`packages/collab/src/migration.ts:98-108`): `(channel_id, principal_id, role∈{owner,agent}, state, membership_epoch, …)`. Agents land with `role='agent'` (S1).
- **No** `LIST_CHANNEL_MEMBERS`/roster read exists in contracts, authz, store, or gateway. `ChannelsPanel.tsx:522-539` rebuilds members client-side from `member_added/removed` timeline events and hardcodes `role:'member'` (`:536`) — self-documented "HONEST INCOMPLETENESS" (`:188-194`). `selectWorkingNow` (`:558-568`) is the console's *own* task only.
- `collab_agent_turns` (`migration.ts:307-320`): `state='dispatched' AND resolved_at IS NULL` is the transactional "currently executing" fact, already scoped to `(channel_id, agent_principal_id)`.
- Live push S5 is wired: `SubscriptionRegistry.register` (`subscriptions.ts:391-397`), `subscribeChannel` (`store.ts:2659`), `fanoutToChannel`, `server.ts:286/937-971`, departure at `server.ts:1089-1101`. (PRD-007 §3 rows 9–12 are stale; note for docs.)
- Authz read commands: `LIST_CHANNELS` (`authz.ts:206`), `GET_CHANNEL_TIMELINE` (`:211`); §2a: NULL principal ⇒ `COLLAB_IDENTITY_REQUIRED`, no seat-level read entitlement.
- A5 zero-writes proof pattern: `tests/collab-presence-a5-zero-writes.test.ts`; real-gateway harness: `tests/helpers/collab-gateway-harness.ts`.

### Controlling invariant
**Membership is entitlement truth from `collab_members`; presence is a read-time derivation from `collab_agent_turns`, filtered by the *caller's own* membership, never persisted, never client-supplied, never consulted by dispatch.** Presence never implies membership; membership never implies presence.

### Scope (Builder may change)
1. **Contracts** `packages/contracts/src/commands.ts`: add `LIST_CHANNEL_MEMBERS { channelId }` (read). Response rides the existing `publishOnly` metadata pattern: `collabMembers: { channelId, members: [{ principalId, displayName, role: 'owner'|'agent', kind: 'human'|'agent', working: boolean, since: string|null }] }`. Run the contracts build; regenerate both schema dirs.
2. **Store** `packages/collab/src/store.ts`: `listChannelMembers(callerPrincipalId, channelId)` → throws the existing not-a-member error unless the caller holds an `active` row; returns active members joined to principals for display name/kind, with `working` = EXISTS `collab_agent_turns` row `state='dispatched' AND resolved_at IS NULL` for that `(channel_id, agent_principal_id)`, `since` = that row's `dispatched_at`. Read-only; no new table, no heartbeat/TTL (A4-d).
3. **Authz** `packages/gateway/src/authz.ts`: `LIST_CHANNEL_MEMBERS` in the same class as `GET_CHANNEL_TIMELINE` (operator + agent surface; `channel`/`node` seats denied; NULL principal ⇒ `COLLAB_IDENTITY_REQUIRED`).
4. **Gateway** `packages/gateway/src/collabSurface.ts`: handler; plus a **live presence push**: when a `collab_agent_turns` row is claimed or resolved (the existing claim/resolve seams in `autoReply.ts`/`store.ts`), publish a `collabPresence { channelId, principalId, working, since }` frame via the S5 `fanoutToChannel` path to subscribed co-members only. The push carries the same four fields and nothing else. No write to `collab_events`.
5. **Console** `apps/console/src/components/ChannelsPanel.tsx`: call `LIST_CHANNEL_MEMBERS` on channel select; render two sections never merged — **Members** (honest labels: `You`/`Owner`/`Agent`) and **Working now** (agents with `working=true`, `since`); apply `collabPresence` pushes live; keep the client-replay path only as a fallback while the command is in flight. Loading/empty/error states.
6. **Tests** (new files; do not weaken existing): `tests/agent-participation-s4.test.ts` — A4-a (seeded non-member running turn is **absent**; exclusion proven, not vacuous), A4-b (key-set equality of each member object against the exact allowed set), A4-c (full lifecycle ⇒ zero `collab_events` writes; reuse the A5 pattern), A4-d (grep-level/structural: no timer/TTL introduced), NULL-principal ⇒ `COLLAB_IDENTITY_REQUIRED`, `channel` seat denied, live push reaches a co-member subscriber and **not** a non-member subscriber, and a booted-gateway round trip via the harness. `tests/channels-panel.test.tsx` additions for labels + sections.

### Non-scope / prohibited (renewed Gate 1 required)
- No `taskId`, prompt, tier, tool, cost, spend, provider, or model in any presence payload — enforced by A4-b key-set equality.
- No presence for *human* principals' tasks (the 005 `tasks ⋈ sessions` design is **not** built; the overlay is agent-turn-derived only — state this honestly in the UI label "Working now (agents)").
- No dispatch-side consumption of presence (`autoReplyDispatcher.ts` must not import it).
- No heartbeat, timer, TTL, or persisted presence table.
- No change to approval semantics, STOP, grants, or S3 loop behavior.

### Failure behavior / concurrency
- Store query is a single read transaction; push is best-effort after the row transition commits (read committed state, never socket delivery, per S5's rule). A missed push is corrected by the next `LIST_CHANNEL_MEMBERS`.
- A turn stuck `dispatched` shows `working=true` until the dispatcher/recovery resolves it — that is truthful, not a bug; S3 recovery owns liveness.

### Acceptance criteria
A4-a, A4-b, A4-c, A4-d verbatim from PRD §4 S4 (`:539-560`); plus **A4-e** honest labels (agent vs owner) rendered from server `role/kind`, not client guesswork; **A4-f** live push co-member-only; **A4-g** booted-gateway round trip.

### Rollback
Additive command + handler + store method + UI section; revert the commit.

---

## Item B — GLM-5.3 alias binding (`env_bound`)

### Objective
The zai `glm-5.3` runtime reaches `connected` and serves agent turns, while the system states **exactly** what it can guarantee about the served model.

### Existing system (verified)
- `exactModelConfig` (`subscriptionAcpRuntime.ts:91-106`) requires `glm-5.3` verbatim among advertised values; the adapter advertises `[default, opus, claude-fable-5[1m], sonnet, haiku]`, `currentValue:'opus'` ⇒ `ACP_MODEL_MISMATCH` ⇒ `unavailable`.
- `buildSafeChildEnv` (`safeSubscriptionProcess.ts:117-126`) under profile `zai-anthropic-glm-5.3-v1` sets `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, `ANTHROPIC_MODEL` and **all** `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` = `glm-5.3`, in a 10-name allowlisted env the ACP client cannot read or write.
- `fingerprint()` (`subscriptionRuntimeCatalog.ts:40-47`) already folds `privateEnvironmentProfileId`.
- **Post-turn served-model proof is NOT obtainable via ACP** (claude-agent-acp v0.64.2 keeps `lastAssistantModel` internal — `dist/acp-agent.js:2548, 2688`; no `model` on `usage_update` or the prompt result). Any claim of provider attestation would be false.

### Controlling invariant
**The model an agent turn is served by is determined by the allowlisted child environment (base URL + every alias pinned to `glm-5.3`), which no client frame, ACP session, or agent can alter; the system never claims adapter/provider attestation it does not have.** Alias acceptance is scoped to exactly one catalog binding.

### Scope
1. `subscriptionRuntimeCatalog.ts`: add `advertisedAlias?: string` and `modelAttestation: 'adapter_verbatim' | 'env_bound'` to the server binding; zai `glm-5.3` gets `advertisedAlias:'opus'`, `modelAttestation:'env_bound'`; fold **both** into `fingerprint()` (version bump to 2); thread through `resolveSubscriptionAcpServer`. Public descriptor JSON must still pass the redaction test (`tests/subscription-runtime.test.ts:90`).
2. `subscriptionAcpRuntime.ts`: `exactModelConfig`/`pinExactModel`/`probeAcpSubscriptionRuntime` accept `advertisedAlias` **only when** the binding carries it **and** `privateEnvironmentProfileId === 'zai-anthropic-glm-5.3-v1'`; pin = `session/set_config_option` to the alias if `currentValue !== alias`, re-validate the echo. All other bindings keep verbatim behavior. Probe/readiness result gains `modelAttestation`.
3. `subscriptionAgentRuntime.ts` / readiness surface / `AgentsPanel.tsx`: carry `modelAttestation` through; the console shows `glm-5.3 · env-bound` (never "verified"). DB-side `externalContextExactModelId === profile.modelId` stays strict.
4. **Pre-turn re-check:** before `session/prompt`, re-read config and assert `currentValue === advertisedAlias`; on mismatch throw `ACP_MODEL_MISMATCH` (maps to `MODEL_MISMATCH`) — before any commit (`dispatch.ts:430`).
5. Tests: alias-shaped `configOptions` fixture (real 5-alias set, no `glm-5.3`); readiness `connected` via alias for zai only; negative: alias-only config against any non-zai binding still `ACP_MODEL_MISMATCH`; fingerprint differs when alias/attestation differ; e2e: pre-turn mismatch ⇒ no `taskStore.complete`, no `RESULT`.

### Non-scope / prohibited
- No text "verified"/"attested" for env-bound runtimes anywhere in UI, receipts, or logs.
- No relaxation for grok/kimi/qwen bindings. No change to `buildSafeChildEnv`'s allowlist or values.
- No sentinel prompts (cost). No ACP fork.

### Acceptance criteria
**B-1** zai readiness probe on the real adapter returns `connected`, `exactModelId:'glm-5.3'`, `modelAttestation:'env_bound'` (live, one probe, no prompt). **B-2** all unit/e2e tests above green. **B-3** redaction test green. **B-4** one live agent turn through zai (single prompt, bounded) produces a committed reply **only after** the pre-turn re-check — evidence: turn row + receipt; if the provider fails, the turn fails closed.

### Rollback
Catalog field defaults (`adapter_verbatim`, no alias) restore prior behavior exactly; revert the commit.

---

## Required gates (both items)
Full vitest, Python suite, `pnpm typecheck --force`, `pnpm build --force`, contracts check, reachability, booted-gateway S4 round trip, live zai probe (+ one turn). Commit partition: S4 · GLM alias · docs (PRD-007 §3 ledger rows 9–12 marked shipped, OQ-2/OQ-5 rulings recorded) — explicit paths only; `.claude/agents/*` and unrelated docs stay report-only.

## Operator stop conditions
Push/merge authorized in-session by the operator; deletion audit must be zero; any G2A REJECT stops the commit.

---

## G1D resolution of G1R findings (round 1 — G1R seat `claude-opus-5` substitute; verdict REJECT)

| # | Disposition | Ruling |
|---|---|---|
| B-1 | **ACCEPTED — slice split** | The "finish all" directive is sequencing, not a §2a entitlement. **The working overlay (`working`/`since`, presence push) is HELD** until the operator states the entitlement in their own words (wording in the G1R record, including that `displayName` is disclosed verbatim). **S4-Members ships now**: `LIST_CHANNEL_MEMBERS` returns `{principalId, displayName, role, kind}` only. The "GRANTED by directive" line above is **withdrawn**. |
| B-2 | **ACCEPTED — binding spec for the held overlay** | When built, every presence delivery runs `readRevalidationSnapshot` + `revalidationPasses` under the read lock before the sink, closes with `authorization_lost` on failure, selects via `registry.forChannel` without the seq filter, never synthesizes `channel_seq`. T-1/T-2 required. Not built this slice. |
| B-3 | **ACCEPTED — env made sovereign; label earned, not asserted** | Amend the Item B prohibition: the zai profile block in `buildSafeChildEnv` **may add** `CLAUDE_CONFIG_DIR` → a gateway-owned empty directory (under `TORQCLAW_DATA_DIR`, created at boot), and the zai interactive spawn **must pass an explicit `cwd`** to an empty gateway-owned directory (no `.claude/`). The allowlist values and the four `ANTHROPIC_*_MODEL` pins are unchanged. The attestation string is **`env_bound` only if T-6 passes against the real spawned binary** (sentinel `model` in `~/.claude/settings.json` and in cwd `.claude/settings.json` must NOT win); otherwise the Builder ships `endpoint_bound` and says so. |
| B-4 | **ACCEPTED** | `advertisedAlias` lives only on a discriminated-union variant whose `privateEnvironmentProfileId` is the literal `'zai-anthropic-glm-5.3-v1'` (compile-time); `'default'` is excluded from acceptable aliases (type + test); T-7 catalog-wide assertion. |
| B-5 | **ACCEPTED — zero blast radius by construction** | **No fingerprint version bump.** `fingerprint()` includes `advertisedAlias`/`modelAttestation` keys **only when present** (omit, don't `?? null`), so every existing non-zai binding's fingerprint is byte-identical and no bootstrapped agent is invalidated; only the zai binding (never `connected` before) changes. T-8 asserts non-zai fingerprints unchanged against a frozen golden. Plus the `console.error` diagnostic at `autoReplyDispatcher.ts:536` ships regardless. |
| N-1 | Recorded | `displayName` disclosed verbatim — goes into the operator's OQ-2 wording. |
| N-2/N-3/N-4/N-5 | Recorded | Store-query comment citing the recovery owner; T-5 structural separation test; cites corrected in the docs commit; live turn (B-4) only after the attestation label is correct. |

**This slice now = S4-Members + GLM alias (env-sovereign).** Working overlay: **BLOCKED on operator wording (OQ-2).**

### OQ-2 — RULED by the operator, 2026-08-23 (explicit, in the operator's own words, selected from the G1R-required wording)

> "I grant the S4 'working now' side-channel as an explicit §2a entitlement: co-members may learn that a co-member agent is executing a turn, disclosed as exactly {principalId, displayName, working, since}. I understand displayName is verbatim and this exceeds channel-message entitlement."

**Consequence:** the working overlay is **UNBLOCKED** and becomes the next bounded build (Builder G) after S4-Members lands, under the B-2 binding spec (per-delivery `revalidationPasses`, `authorization_lost` close, `registry.forChannel` without seq filter, no synthesized `channel_seq`, no `collab_events` write) and tests T-1, T-2, T-9, T-10. Agent-turn-derived only (no human-task presence); UI label "Working now (agents)".
