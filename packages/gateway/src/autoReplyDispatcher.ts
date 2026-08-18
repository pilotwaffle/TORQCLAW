/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — the auto-reply dispatcher.
 *
 * This is the ONE place a committed `message_posted` event turns into a new
 * agent task. It is called from exactly two commit paths (both already
 * inside the store's own committed-write flow, never before commit):
 *   - collabSurface.ts's handlePostChannelMessage (human/operator posts)
 *   - collabAgentTools.ts's post_message tool handler (an agent posts)
 * Both call `onChannelMessageCommitted` with the SAME narrow argument shape
 * below -- never the event row, never the message text.
 *
 * INV-T1 (G1R B-3a) -- enforced, not asserted:
 *   1. STRUCTURAL: resolveEligibleAgents (packages/collab/src/autoReply.ts)
 *      takes (db, channelId, actorPrincipalId, seq) -- it cannot receive
 *      content_json because no parameter carries it. This dispatcher's own
 *      entry point mirrors that narrowing (see OnChannelMessageCommittedParams
 *      below): it does NOT accept `text` or `kind`.
 *   2/3. The differential-content probe and the source-level assertion live
 *      in tests/agent-participation-s3.test.ts, against this file and
 *      autoReply.ts together.
 *
 * ANTI-STORM MECHANISMS (§4 S3, all four; G1R confirmed 1/3/4 hold as
 * specified, gaps closed in S-5/S-6 below):
 *   1. No self-reply: resolveEligibleAgents excludes actorPrincipalId.
 *   2. No double-reply: claimAgentTurn's PRIMARY KEY on
 *      (channel_id, agent_principal_id, channel_seq) is the durable
 *      idempotency mechanism -- survives a process restart, closing G1R
 *      S-5's gap (see recoverStrandedAgentTurns below for the other half).
 *   3. No interleaving garbage: the substrate already totally orders
 *      channel_seq (store.ts); the dispatch-layer half (one in-flight turn
 *      per (agent, channel), dirty-flag coalescing) is `inFlight`/`dirty`
 *      below.
 *   4. A turn that fails does not silently retry: resolveAgentTurn marks a
 *      dispatch failure 'terminated', never re-queued automatically.
 *
 * S-5 (G1R B-3b) -- the watermark's write point and crash semantics:
 *   claimAgentTurn INSERTs a 'dispatched' row BEFORE the GatewayRequest is
 *   dispatched (this is the "write point"). A crash after the claim but
 *   before the turn resolves leaves the row 'dispatched' -- indistinguishable
 *   from an in-flight turn UNTIL `dispatched_at` ages past the grace window.
 *   recoverStrandedAgentTurns (called at gateway boot, mirroring
 *   server.ts's existing revokeInertGrants sweep) finds every such row and
 *   RE-DISPATCHES it -- never silently drops it, never replays an
 *   already-resolved one (the WHERE state='dispatched' guard on every write
 *   makes a completed/no_post/terminated row immune to the sweep).
 *
 * S-6 (G1R B-3c) -- membership removed mid-turn:
 *   Eligibility is evaluated ONCE at trigger time (this file, on commit).
 *   A dispatched turn's own collab__post_message call re-checks membership
 *   at the substrate (assertChannelVisible) independently -- if the agent
 *   was removed between dispatch and its own post attempt, that call
 *   returns COLLAB_NOT_FOUND. runAgentTurn's own post-dispatch check
 *   (agentIsActiveMember, below) re-reads the SAME collab_members ground
 *   truth resolveEligibleAgents itself trusts -- never a model-visible
 *   tool-error string -- and marks the turn 'terminated' when the agent is
 *   no longer active. The branch ends at the GATEWAY, never left to model
 *   judgment (a model receiving a tool error could otherwise retry with a
 *   different channelId).
 *
 * STOP (R-3a): isAutoreplyStopped is checked BEFORE every new claim, both
 * at the initial trigger point and again by the dirty-flag coalescing
 * follow-up dispatch -- so STOP prevents any NEW dispatch immediately,
 * while an already-dispatched in-flight turn completes (G1R N-2's ruling on
 * N>2 fan-out: "in-flight turns complete but their posts do not re-trigger"
 * -- guaranteed because the completing turn's own post re-enters THIS same
 * commit hook, which re-checks STOP before dispatching anything further).
 */

import { randomUUID } from 'node:crypto';
import type { ComputeTier, GatewayRequest, RouterDiagnostics } from '@torqclaw/contracts';
import { router } from '@torqclaw/router';
import { predictTools } from '@torqclaw/bridge';
import {
  resolveEligibleAgents,
  claimAgentTurn,
  attachDispatchRequestId,
  resolveAgentTurn,
  findStrandedAgentTurns,
  reclaimStrandedAgentTurn,
  isAutoreplyStopped,
  type CallerContext,
} from '@torqclaw/collab';
import { resolveProfile } from './profileResolver.js';
import { dispatch } from './dispatch.js';
import { db as stateDb } from './storage.js';
import { getStore, callerFor, agentParticipationEnabled, getCollabDbForAutoReply } from './collabSurface.js';
import { buildAnchorWindowContext } from './autoReplyContext.js';
import { agentAutoreplyEnabled } from './autoReplyFlags.js';

/** INV-T1 mechanism 1 (structural): this is the ENTIRE shape a commit path
 *  may hand to the trigger. There is no `text` field, no `kind` field, no
 *  `content_json` field -- widening this type to carry any of them is a
 *  visible, reviewable diff to this file, never a quiet internal change. */
export type OnChannelMessageCommittedParams = {
  channelId: string;
  channelSeq: number;
  eventId: string;
  actorPrincipalId: string;
};

/** One in-flight turn per (agent, channel); a trigger arriving during an
 *  in-flight turn sets the dirty flag for exactly one follow-up evaluation
 *  after it completes (anti-storm mechanism 3's dispatch-layer half). */
const inFlight = new Set<string>();
const dirty = new Set<string>();
function turnKey(channelId: string, agentPrincipalId: string): string {
  return channelId + ':' + agentPrincipalId;
}

/** Test-only hook: replace the dispatch function so a test can observe a
 *  claimed turn without booting a full LOCAL_EDGE/FRONTIER execution. */
let dispatchOverride: typeof dispatch | null = null;
export function setAutoReplyDispatchForTest(fn: typeof dispatch | null): void {
  dispatchOverride = fn;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The commit-path entry point. Called AFTER a message_posted event has
 * committed (never before -- triggering on committed substrate truth, never
 * socket delivery, is the same load-bearing S5 design constraint the PRD
 * names for delivery; it applies with equal force here, since a rolled-back
 * write must never have triggered a turn).
 */
export async function onChannelMessageCommitted(params: OnChannelMessageCommittedParams): Promise<void> {
  if (!agentParticipationEnabled() || !agentAutoreplyEnabled()) return;
  const store = getStore();
  if (!store) return;
  const db = collabDbHandle();
  if (!db) return;

  if (isAutoreplyStopped(db, params.channelId)) return;

  // Mechanism 1 (structural) + Corollary A: only channelId, actorPrincipalId,
  // and seq cross this boundary -- resolveEligibleAgents cannot see text.
  const eligible = resolveEligibleAgents(db, params.channelId, params.actorPrincipalId, params.channelSeq);

  for (const agentPrincipalId of eligible) {
    await triggerOrCoalesce(store, db, params.channelId, agentPrincipalId, params.channelSeq, params.eventId);
  }
}

async function triggerOrCoalesce(
  store: NonNullable<ReturnType<typeof getStore>>,
  db: ReturnType<typeof collabDbHandle>,
  channelId: string,
  agentPrincipalId: string,
  channelSeq: number,
  eventId: string,
): Promise<void> {
  const key = turnKey(channelId, agentPrincipalId);
  if (inFlight.has(key)) {
    dirty.add(key);
    return;
  }
  await dispatchOneTurn(store, db!, channelId, agentPrincipalId, channelSeq, eventId);
}

async function dispatchOneTurn(
  store: NonNullable<ReturnType<typeof getStore>>,
  db: NonNullable<ReturnType<typeof collabDbHandle>>,
  channelId: string,
  agentPrincipalId: string,
  channelSeq: number,
  eventId: string,
): Promise<void> {
  // Anti-storm mechanism 2: the PRIMARY KEY on collab_agent_turns is the
  // real enforcement. claimAgentTurn returns false if this triple was
  // already claimed (by this process or a prior one, including a
  // crash-recovered claim from the sweep).
  const claimed = claimAgentTurn(db, {
    channelId, agentPrincipalId, channelSeq, triggerEventId: eventId, nowIso: nowIso(),
  });
  if (!claimed) return;

  const key = turnKey(channelId, agentPrincipalId);
  inFlight.add(key);
  try {
    // runAgentTurn can throw deliberately (the §5A structural-defect
    // assertion above): this repo's gateway has NO unhandledRejection net
    // (packages/gateway/src/server.ts), so a throw escaping this await would
    // kill the whole process, not just this turn. The throw is caught HERE
    // -- one level up from where the turn is already resolved 'terminated'
    // -- so the loud failure stays loud (console.error already fired inside
    // runAgentTurn; this is a second, generic net) without taking the
    // gateway down. Mirrors collabSurface.ts's existing
    // catch-and-console.warn discipline for this exact trigger path.
    await runAgentTurn(store, db, channelId, agentPrincipalId, channelSeq);
  } catch (err: any) {
    console.error(`[gateway] agent turn failed unexpectedly (${err?.message ?? err})`);
  } finally {
    inFlight.delete(key);
    // Coalescing: exactly one follow-up evaluation, using the LATEST
    // channel state (re-resolve eligibility + highest seq at the current
    // moment) rather than the stale seq that triggered this turn.
    if (dirty.has(key)) {
      dirty.delete(key);
      // STOP re-checked here (per this file's header): an in-flight turn
      // completes, but its own coalesced follow-up must not fire if STOP
      // landed while it was running.
      if (!isAutoreplyStopped(db, channelId)) {
        const latestSeq = latestChannelSeq(db, channelId);
        if (latestSeq !== null) {
          await dispatchOneTurn(store, db, channelId, agentPrincipalId, latestSeq, `coalesced:${randomUUID()}`);
        }
      }
    }
  }
}

function latestChannelSeq(db: NonNullable<ReturnType<typeof collabDbHandle>>, channelId: string): number | null {
  const row = db
    .prepare('SELECT COALESCE(MAX(channel_seq), 0) AS m FROM collab_events WHERE channel_id = ?')
    .get(channelId) as { m: number };
  return row.m > 0 ? row.m : null;
}

async function runAgentTurn(
  store: NonNullable<ReturnType<typeof getStore>>,
  db: NonNullable<ReturnType<typeof collabDbHandle>>,
  channelId: string,
  agentPrincipalId: string,
  channelSeq: number,
): Promise<void> {
  const caller: CallerContext = callerFor(agentPrincipalId);

  // Anchor + window context (G1R N-1) -- reused verbatim, never a raw
  // channel dump.
  let contextText: string;
  try {
    const ctx = await buildAnchorWindowContext(store, caller, channelId);
    contextText = ctx.text;
  } catch (err: any) {
    // S-6 (membership removed between claim and context read): the
    // substrate's own visibility check fires here first, before any
    // GatewayRequest is even built. Terminate the branch at the gateway.
    if (err?.code === 'COLLAB_NOT_FOUND') {
      resolveAgentTurn(db, { channelId, agentPrincipalId, channelSeq, state: 'terminated', nowIso: nowIso() });
      return;
    }
    resolveAgentTurn(db, { channelId, agentPrincipalId, channelSeq, state: 'terminated', nowIso: nowIso() });
    return;
  }

  // G1R COLLAB-WRITE-PROFILE ruling PART 3. `taskType='SUMMARIZATION'` is
  // RETAINED deliberately -- TOOL_ROUTING_MAP.SUMMARIZATION (toolFilter.ts)
  // is what carries the `collab__` prefix that makes collab tools RENDER to
  // the model at all. Admission (below) does NOT make a tool render; if this
  // now-vestigial-looking line is ever "cleaned up", the tool silently
  // disappears from the model's list again -- same silent failure, new
  // cause. The stale claim this comment replaces ("read_only admits the
  // free-speech post_message tool") was made false by 7c0a4af (G1R V-S2-1)
  // and is exactly the kind of comment-only fix this ruling says is
  // necessary but insufficient -- comments cannot be gated, code must be.
  const taskType = 'SUMMARIZATION' as const;
  // Both requestedProfile AND sessionDefaultProfile are set to the SAME
  // profile so requestedId === sessionId inside resolveProfile -- the
  // broader/incomparable guard at profileResolver.ts's resolveProfile is
  // therefore never engaged (agent_conversation IS incomparable to
  // read_only: different namespaces, collab_write not in read_only's
  // allowedSideEffects). Passing requestedProfile ALONE would throw on
  // EVERY auto-turn, converting yesterday's silent failure into today's
  // dispatcher crash-loop. operatorAuthorized stays false: no authority is
  // fabricated, because none is needed once the two ids are made equal.
  const effectiveProfile = resolveProfile({
    taskType,
    requestedProfile: 'agent_conversation',
    sessionDefaultProfile: 'agent_conversation',
    operatorAuthorized: false,
  }).profile;
  // Derived from the SAME predictTools the model's rendered tool list comes
  // from (toolFilter.ts) -- never a parallel reimplementation that could
  // drift from it. That drift is a recorded failure mode in this program
  // (the "mirroring-validator" class): a check that mirrors its source of
  // truth instead of calling it is a second copy that can silently diverge.
  const requiredTools = predictTools(taskType, effectiveProfile, agentPrincipalId);

  // G1R COLLAB-WRITE-PROFILE ruling §5A -- THE STRUCTURAL FIX, the primary
  // deliverable of this ruling. A turn that structurally cannot post is a
  // POLICY DEFECT, not a silent 'no_post'. A3-f (below) makes silence a
  // valid MODEL choice; it must never also be reachable as a valid
  // STRUCTURAL outcome -- those two must never be able to look alike. This
  // assertion fires BEFORE any GatewayRequest is minted (no model call has
  // happened yet), so it is T-2-clean by placement: there is no model
  // transcript for this message to leak into. The needed/provided detail
  // goes to the OPERATOR-facing log only, per the ruling's T-2 split --
  // NEVER add this detail to profilePolicy.ts's assertOperationAllowed
  // throw, which DOES reach a model transcript mid-turn and must stay
  // exactly as opaque as it is today.
  if (!requiredTools.includes('collab__post_message')) {
    resolveAgentTurn(db, { channelId, agentPrincipalId, channelSeq, state: 'terminated', nowIso: nowIso() });
    console.error(
      `[gateway] agent turn cannot post: 'collab__post_message' not admitted by effective ` +
      `profile '${effectiveProfile.profileId}' (needed side-effect 'collab_write'; profile ` +
      `provides [${effectiveProfile.sideEffectClasses.join(', ')}]) -- agentPrincipalId=` +
      `${agentPrincipalId} channelId=${channelId} channelSeq=${channelSeq}`,
    );
    throw new Error(
      `agent turn cannot post: 'collab__post_message' not admitted by effective profile ` +
      `'${effectiveProfile.profileId}'`,
    );
  }

  const prompt =
    `You are participating in a channel conversation as agent principal ${agentPrincipalId}. ` +
    `A new message was posted. Read the channel with collab__read_channel if you need more ` +
    `detail than the context below, and reply with collab__post_message ONLY if you have ` +
    `something to add. Staying silent (posting nothing) is a valid, expected outcome when you ` +
    `have nothing useful to say -- do not post just to acknowledge.\n\n${contextText}`;

  const sessionId = mintAutoTurnSession(agentPrincipalId);

  const request: GatewayRequest = {
    id: randomUUID(),
    sessionId,
    sourceChannel: 'agent-autoreply',
    receivedAt: nowIso(),
    payload: {
      prompt,
      assembledContext: undefined,
      contextSize: Math.ceil(prompt.length / 4),
      requiredTools,
      taskType,
      grantedTools: [],
      // The dispatch-time binding S2 left open: THIS is where an agent
      // task's collab identity is finally bound, from gateway state (the
      // resolver's output), never from task input or model output (§2.1).
      callerCollabPrincipalId: agentPrincipalId,
    },
    constraints: {
      latencySensitivity: 'LOW',
      containsSensitiveData: false,
      executionMode: 'AUTO',
    },
    enrichment: {
      classifierUsed: 'DEFAULT',
      classifierConfidence: 1,
      classifierLatencyMs: 0,
      estimatedTokens: Math.ceil(prompt.length / 4),
      memoryUsed: false,
    },
    effectiveProfile,
  };

  // FRONTIER auto-turns are refused for the same reason a granted FRONTIER
  // run is refused (S0/dispatch.ts's frontierGrantFenced): the engine's
  // pre_tool_call hook grants by NAME only, so it cannot satisfy the
  // exact-action invariant, and this program has already ruled that
  // unattended execution must not run under a mechanism that cannot prove
  // argv identity. An auto-turn is FORCED to LOCAL_EDGE unconditionally --
  // never routed to FRONTIER regardless of what the router would otherwise
  // pick for this prompt/profile, because FRONTIER's approval posture for
  // an agent-authored, unattended prompt has not been evaluated and must
  // not be reached by accident.
  const diag: RouterDiagnostics = { ...router.evaluateRequest(request), tier: 'OLLAMA_LOCAL' as ComputeTier };

  attachDispatchRequestId(db, { channelId, agentPrincipalId, channelSeq, dispatchRequestId: request.id });

  await runDispatchAndWait(request, diag);

  // Determine outcome by REAL committed-row evidence (§7.5 discipline: never
  // infer from an emitted event, always check the actual side effect),
  // scoped to whether THIS agent posted during THIS turn.
  const postedByThisAgent = countAgentPostsSince(db, channelId, agentPrincipalId, channelSeq);
  if (postedByThisAgent > 0) {
    resolveAgentTurn(db, { channelId, agentPrincipalId, channelSeq, state: 'completed', nowIso: nowIso() });
  } else if (!agentIsActiveMember(db, channelId, agentPrincipalId)) {
    // S-6: the GROUND TRUTH for "was this agent removed mid-turn" is the
    // membership row itself, re-read here at the gateway -- never inferred
    // from a model-visible tool-error string (a model's collab__post_message
    // failure is fed back into the chat transcript, not persisted as a
    // distinct gateway signal, so that path cannot be reconstructed
    // reliably after the fact). Checking the same table
    // resolveEligibleAgents itself reads (collab_members) means this
    // decision uses the same source of truth INV-T1 already trusts.
    resolveAgentTurn(db, { channelId, agentPrincipalId, channelSeq, state: 'terminated', nowIso: nowIso() });
  } else {
    // A3-f: silence is a first-class, documented, non-error outcome.
    resolveAgentTurn(db, { channelId, agentPrincipalId, channelSeq, state: 'no_post', nowIso: nowIso() });
  }
}

async function runDispatchAndWait(req: GatewayRequest, diag: RouterDiagnostics): Promise<void> {
  const fn = dispatchOverride ?? dispatch;
  fn(req, diag);
  // dispatch() is fire-and-forget (returns immediately; the real terminal
  // is a taskStore write). Poll the task row for a terminal state rather
  // than adding a second completion channel -- bounded by a generous
  // timeout so a stuck provider cannot hang this hook forever.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const row = stateDb.prepare('SELECT state FROM tasks WHERE request_id = ?').get(req.id) as
      | { state: string }
      | undefined;
    if (row && row.state !== 'running') return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function agentIsActiveMember(
  db: NonNullable<ReturnType<typeof collabDbHandle>>,
  channelId: string,
  agentPrincipalId: string,
): boolean {
  const row = db
    .prepare(`SELECT state FROM collab_members WHERE channel_id = ? AND principal_id = ?`)
    .get(channelId, agentPrincipalId) as { state: string } | undefined;
  return row?.state === 'active';
}

function countAgentPostsSince(
  db: NonNullable<ReturnType<typeof collabDbHandle>>,
  channelId: string,
  agentPrincipalId: string,
  sinceSeq: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM collab_events
        WHERE channel_id = ? AND actor_principal_id = ? AND channel_seq > ? AND kind = 'message_posted'`,
    )
    .get(channelId, agentPrincipalId, sinceSeq) as { n: number };
  return row.n;
}

function mintAutoTurnSession(agentPrincipalId: string): string {
  const sessionId = randomUUID();
  stateDb.prepare(
    'INSERT INTO sessions (id, role, client_name, principal_id, surface_id) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, 'node', 'agent-autoreply', agentPrincipalId, null);
  return sessionId;
}

function collabDbHandle(): ReturnType<typeof getCollabDbForAutoReply> {
  // Reuse the SAME collab DB handle the store singleton opened -- never a
  // second independent connection (mirrors collabSurface.ts's own
  // storeDb-reuse discipline and its documented reason).
  return getCollabDbForAutoReply();
}

/**
 * Boot-time recovery sweep (G1R B-3b's required recovery). Mirrors
 * server.ts's existing revokeInertGrants call: run unconditionally, before
 * the listener opens traffic, so no client ever observes a
 * half-recovered state. Flag-gated the SAME way the rest of S3 is (if
 * auto-reply is off, there is nothing to recover into -- but a row from a
 * PRIOR run with the flag on must still be swept so it does not linger
 * forever once the flag is re-enabled).
 */
export async function recoverStrandedAgentTurns(graceSeconds = 30): Promise<number> {
  const db = collabDbHandle();
  if (!db) return 0;
  const store = getStore();
  if (!store) return 0;
  const stranded = findStrandedAgentTurns(db, nowIso(), graceSeconds);
  let recovered = 0;
  for (const turn of stranded) {
    const reclaimed = reclaimStrandedAgentTurn(db, {
      channelId: turn.channelId, agentPrincipalId: turn.agentPrincipalId,
      channelSeq: turn.channelSeq, nowIso: nowIso(),
    });
    if (!reclaimed) continue; // lost the race to a legitimate completion
    recovered += 1;
    const key = turnKey(turn.channelId, turn.agentPrincipalId);
    if (inFlight.has(key)) {
      // Already running in THIS process (should not happen for a truly
      // stranded row, but guards against a double-sweep race) -- coalesce
      // instead of double-dispatching.
      dirty.add(key);
      continue;
    }
    inFlight.add(key);
    void (async () => {
      try {
        // See dispatchOneTurn's identical catch for why this cannot be a
        // bare try/finally: runAgentTurn's §5A assertion can throw, and this
        // repo's gateway has no unhandledRejection net.
        await runAgentTurn(store, db, turn.channelId, turn.agentPrincipalId, turn.channelSeq);
      } catch (err: any) {
        console.error(`[gateway] recovered agent turn failed unexpectedly (${err?.message ?? err})`);
      } finally {
        inFlight.delete(key);
      }
    })();
  }
  return recovered;
}
