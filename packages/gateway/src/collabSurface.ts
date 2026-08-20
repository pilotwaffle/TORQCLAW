/**
 * PRD-TCLAW-COLLAB-PRESENCE-UI-005 S1 + S3 — Wire surface (gateway + contracts).
 *
 * S1: LIST_CHANNELS and GET_CHANNEL_TIMELINE (read-only). S3:
 * POST_CHANNEL_MESSAGE (the only mutation this PRD's surface adds -- §5).
 * All three are issued from an operator SEAT but executed with the
 * connection's resolved collab PRINCIPAL as the substrate's CallerContext
 * (§2a). The two lattices are never conflated:
 *
 *   - The gateway seat (authz.ts's `Role`) decides only whether a
 *     connection may use this command CLASS at all.
 *   - The substrate subject of every call here is the connection's
 *     server-derived collab principal, established at CONNECT from a
 *     verified `tq1_` surface credential (collabIdentity.ts). There is NO
 *     operator bypass, NO seat-level read entitlement, NO principal
 *     synthesis -- a connection with no resolved principal is refused
 *     COLLAB_IDENTITY_REQUIRED, never substituted or widened to "the
 *     operator principal" or an unscoped listing.
 *
 * Gated behind TORQCLAW_COLLAB_SURFACE_COMMANDS, a DEDICATED narrowing flag
 * that additionally requires TORQCLAW_COLLAB_ENABLED (collabEnabled()) --
 * so turning the surface off can never revert the C0/C1 identity
 * hardening, and turning collab off elsewhere always turns this off too.
 * When either flag is off, every command here answers with the SAME
 * terminal ERROR frame shape as any other absent-deny action (server.ts).
 *
 * S1 is read-only: SELECT via CollaborationStore's read-lock path,
 * publishOnly SYSTEM response frames (the LIST_APPROVALS pattern) -- zero
 * writes. S3 is the sole exception (§5's "S3 is the only new mutation" --
 * postChannelMessage persists a message_posted event and fans it out);
 * the author is ALWAYS server-stamped from callerFor's resolved principal
 * -- the wire command carries no author field to spoof (A3).
 *
 * G2A D-1 / A6: every handler here is TOTAL -- no store throw may escape
 * any of them. There is no enclosing try/catch around the dispatch switch
 * in server.ts's async socket.on('message') handler, so an uncaught throw
 * here would become an unhandled rejection and (Node 22 default) terminate
 * the gateway process. Every throw is mapped to a returned
 * CollabSurfaceError; the COLLAB_NOT_FOUND arm is preserved
 * byte-identically (T-2) and unexpected failures are mapped to the generic
 * COLLAB_UNAVAILABLE without leaking internal detail.
 */

import { randomUUID } from 'node:crypto';
import {
  CollaborationStore,
  nodeRandomSource,
  type CallerContext,
  type BootstrapDb,
  type DeliverySink,
} from '@torqclaw/collab';
import { publishOnly } from './events.js';
import { collabEnabled } from './principalBridge.js';
import { getCollabDb, getPrincipalKind, getPrincipalPepper } from './collabIdentity.js';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * The dedicated narrowing flag (§4 S1, adopted G1R non-blocking finding).
 * Read per-call, never captured at import -- same discipline as
 * collabEnabled() (principalBridge.ts), for the same reason: a module-level
 * constant would make the flag untestable without a module reload.
 */
export function collabSurfaceCommandsEnabled(): boolean {
  if (!collabEnabled()) return false;
  return TRUTHY.has((process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS ?? '').trim().toLowerCase());
}

/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S1's own narrowing flag. Additionally
 * requires collabSurfaceCommandsEnabled() (which itself requires
 * collabEnabled()), so this can NEVER re-enable a surface 005's flags
 * turned off -- it only ever narrows further, matching the house pattern
 * collabSurfaceCommandsEnabled() itself already established over
 * collabEnabled(). Read per-call, never captured at import, for the same
 * stale-module-constant reason as its sibling above.
 */
export function agentParticipationEnabled(): boolean {
  if (!collabSurfaceCommandsEnabled()) return false;
  return TRUTHY.has((process.env.TORQCLAW_AGENT_PARTICIPATION ?? '').trim().toLowerCase());
}

/**
 * S1: the exact predicate server.ts uses to decide whether a just-connected
 * caller's binding may become this connection's agentCollabPrincipalId.
 * Pulled out as a small, named, directly-unit-testable function (rather than
 * inlined in server.ts's connect closure) specifically so its ONE
 * discriminating case -- a C1 'automation_surface' caller, which shares
 * role:'node' with a real agent but must NOT gain write access here -- can
 * be pinned by a fast unit test without booting a full gateway subprocess
 * and provisioning a live C1 surface projection end-to-end.
 *
 * `authClass === 'agent_surface'` is produced by collabIdentity.ts in
 * exactly two places (the C1 branch when ctx.surfaceRole === 'agent', and
 * the C0.1 legacy branch when principalKind !== 'operator') -- both already
 * required principalKind/surfaceRole to be the agent case before returning
 * it, so this performs no additional DB read (see server.ts's connect-path
 * comment for why a second read would be untestable dead redundancy).
 */
export function isAgentSurfaceCaller(authClass: string, binding: unknown): boolean {
  return authClass === 'agent_surface' && binding != null;
}

/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3: injected, never imported directly.
 * autoReplyDispatcher.ts imports getStore/callerFor/getCollabDbForAutoReply
 * FROM this module, so this module cannot import autoReplyDispatcher.ts
 * back without a circular import -- the same injection pattern this
 * codebase already uses for setToolAdmissionCheck (ollama.ts) and
 * setCancelCheck (ollama.ts). server.ts wires the real implementation at
 * boot; the default is a no-op so this module stays independently
 * importable (e.g. by tests that never call the wiring function) with S3
 * behaving as fully absent, matching every other injected-seam default in
 * this codebase.
 */
export type AutoReplyTrigger = (params: {
  channelId: string; channelSeq: number; eventId: string; actorPrincipalId: string;
}) => void | Promise<void>;
let autoReplyTrigger: AutoReplyTrigger = () => {};
export function setAutoReplyTrigger(fn: AutoReplyTrigger): void {
  autoReplyTrigger = fn;
}
/** Fire-and-forget by construction: the injected function itself is async
 *  (onChannelMessageCommitted), and this wrapper deliberately does not
 *  await it -- a human's POST_CHANNEL_MESSAGE ack must not wait on however
 *  many downstream agent turns the post triggers. Any rejection is caught
 *  here so a trigger failure can never become an unhandled rejection that
 *  terminates the gateway process (the same A6(b) totality discipline this
 *  file's own module doc requires of every handler).
 *
 *  Exported (S3) so collabAgentTools.ts's post_message tool handler -- the
 *  OTHER commit path a message_posted event can come from -- fires the
 *  identical trigger after ITS OWN commit, under the name
 *  triggerAutoReplyForAgentPost. Both commit paths call the exact same
 *  underlying wrapper; there is no second, divergent trigger
 *  implementation. */
export function triggerAutoReply(params: {
  channelId: string; channelSeq: number; eventId: string; actorPrincipalId: string;
}): void {
  try {
    const result = autoReplyTrigger(params);
    // The injected fn may return a Promise (it does in production); guard
    // against an unhandled rejection without assuming the return type.
    if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
      (result as unknown as Promise<unknown>).catch((err) => {
        console.warn(`[gateway] auto-reply trigger failed (${err?.message ?? err})`);
      });
    }
  } catch (err: any) {
    console.warn(`[gateway] auto-reply trigger failed (${err?.message ?? err})`);
  }
}

let storeOverride: CollaborationStore | null = null;
let defaultStore: CollaborationStore | null = null;

// S3 (CO-1): the DB handle backing WHICHEVER store getStore() last returned
// -- kept alongside the store itself so callerFor's principals.kind lookup
// reuses the SAME handle the store runs against, rather than opening an
// independent connection. This matters for two reasons: (1) correctness --
// a test fixture's store is backed by an in-memory DB with no relation to
// the production getCollabDb() singleton, so a second independent call
// would silently look up the WRONG database and always miss; (2) safety --
// getCollabDb() lazily opens (and migrates) a real collab.db file on disk
// under TORQCLAW_DATA_DIR the FIRST time it's called. A production-path
// call from callerFor with no store override in play is fine (it's the
// same handle getStore() would open anyway), but calling it a SECOND,
// INDEPENDENT time here was observed to open a stray collab.db under the
// operator's real ~/.torqclaw during an unrelated unit test run that never
// set TORQCLAW_DATA_DIR -- exactly the class of side effect vitest.config.ts's
// "Pure-logic unit tests only — no network, no DB" header promises tests
// don't have. Threading the same handle through removes the second open
// entirely.
let storeDb: BootstrapDb | null = null;

/** Test-only override of the CollaborationStore instance. Production never calls this. */
export function setCollabSurfaceStoreForTest(store: CollaborationStore | null): void {
  storeOverride = store;
  storeDb = null; // test callers wire kind-lookup DB access separately (setCollabDbForTest)
}

/**
 * Lazily construct the production store, sharing the exact migrated
 * collab.db handle and principal pepper collabIdentity.ts already uses
 * (getCollabDb/getPrincipalPepper) -- no second DB connection, no
 * duplicated SecretStore selection.
 *
 * Exported (PRD-TCLAW-AGENT-PARTICIPATION-007 S2) so the in-process collab
 * MCP tool server (packages/gateway/src/collabAgentTools.ts) can reuse the
 * SAME store singleton and error taxonomy this module's own handlers use,
 * rather than constructing a second store instance or re-deriving the
 * CollabError -> structured-error mapping -- the T-2 byte-identity
 * guarantee (a hidden channel indistinguishable from a nonexistent one)
 * depends on there being exactly one mapping, not two that could drift.
 */
export function getStore(): CollaborationStore | null {
  if (storeOverride) return storeOverride;
  const pepper = getPrincipalPepper();
  if (!pepper) return null; // same fail-closed posture as the connect path
  if (!defaultStore) {
    const db = getCollabDb() as unknown as BootstrapDb;
    storeDb = db;
    defaultStore = new CollaborationStore({
      db,
      clock: { next: () => new Date().toISOString() },
      uuids: { next: () => randomUUID() },
      rng: nodeRandomSource,
      principalPepper: pepper,
    });
  }
  return defaultStore;
}

/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3: expose the SAME db handle storeDb
 * tracks (set by getStore()) so autoReplyDispatcher.ts's watermark/STOP
 * reads and writes run against the identical collab.db connection the
 * store itself uses -- never a second, independent connection (the exact
 * reuse discipline getStore()'s own doc comment establishes for
 * collabAgentTools.ts, extended here to the auto-reply dispatcher). Callers
 * must call getStore() first (directly or transitively) so storeDb is
 * populated; if it is not, this returns null and the caller's own
 * fail-closed handling (no store => do nothing) applies identically.
 */
export function getCollabDbForAutoReply(): BootstrapDb | null {
  // Ensure the store (and therefore storeDb) has been resolved at least
  // once -- getStore() is idempotent and side-effect-free on repeat calls.
  getStore();
  return storeDb;
}

export type CollabSurfaceError = {
  code:
    | 'COLLAB_IDENTITY_REQUIRED'
    | 'COLLAB_NOT_FOUND'
    | 'COLLAB_UNAVAILABLE'
    | 'COLLAB_INVALID_REQUEST'
    | 'COLLAB_CHANNEL_ARCHIVED'
    | 'COLLAB_IDEMPOTENCY_CONFLICT';
  detail?: unknown;
};

/** Refusal shared by both handlers when the connection has no resolved
 *  collab principal (§2a: refuse, never substitute or synthesize). */
export const COLLAB_IDENTITY_REQUIRED: CollabSurfaceError = { code: 'COLLAB_IDENTITY_REQUIRED' };

/**
 * S3 (CO-1 fix): `kind` is derived from the connection's own resolved
 * principal via a real DB read (collabIdentity.ts's getPrincipalKind),
 * never hardcoded. The substrate re-reads `principals.kind` from its own DB
 * for every security-relevant check and never trusts `caller.kind`
 * (Cycle-3 NB-3, grep-verified against store.ts -- `caller.kind` is read
 * nowhere there), so this value is still advisory plumbing, not an
 * authorization input -- but S3 is the first WRITE path this surface
 * exposes, and a write path must not hand the store a CallerContext that
 * *claims* a kind unrelated to the caller's real one. A lookup failure
 * (unknown principal, closed handle) falls back to 'agent' -- the LESS
 * privileged of the two literal kind values -- never 'operator', so a
 * lookup failure can only ever narrow what a caller.kind read would imply,
 * never widen it. This is belt-and-suspenders: assertChannelVisible (the
 * only predicate POST_CHANNEL_MESSAGE's predicate slot calls) ignores
 * caller.kind entirely, so this fallback choice is not reachable as a live
 * escalation today, and is chosen for future-proofing only.
 * Exported (S2) for the same reuse reason as getStore() above.
 */
export function callerFor(principalId: string): CallerContext {
  return { principalId, kind: resolvePrincipalKindForCaller(principalId) };
}

/**
 * Reuses `storeDb` -- the SAME handle getStore() resolved (production) or
 * whatever a test wired via setCollabDbForTest (test-only override, applies
 * when storeOverride is in play) -- rather than opening an independent
 * connection. `storeDb` is null exactly when no store has been resolved yet
 * (getStore() failed closed on a missing pepper) or a test override supplied
 * no DB, in which case this falls back to 'agent' without touching the
 * filesystem at all.
 */
function resolvePrincipalKindForCaller(principalId: string): 'operator' | 'agent' {
  const db = storeDb ?? testKindLookupDb;
  if (!db) return 'agent';
  try {
    return getPrincipalKind(db, principalId) ?? 'agent';
  } catch {
    return 'agent';
  }
}

let testKindLookupDb: BootstrapDb | null = null;

/**
 * Test-only: wire the DB callerFor's kind lookup reads, independent of
 * whatever store setCollabSurfaceStoreForTest installed (a throwing-store
 * fixture, for instance, has no real DB to read from at all). Production
 * never calls this -- storeDb (set by getStore()) is always the source
 * there.
 */
export function setCollabSurfaceKindLookupDbForTest(db: BootstrapDb | null): void {
  testKindLookupDb = db;
}

/**
 * LIST_CHANNELS handler body. Read-only: SELECT + publishOnly, zero writes.
 * `principalId` is the CONNECTION's server-derived resolved collab
 * principal, or null when unresolved -- in which case this returns the
 * COLLAB_IDENTITY_REQUIRED refusal instead of listing anything.
 */
export async function handleListChannels(
  sessionId: string,
  principalId: string | null,
  limit: number,
): Promise<CollabSurfaceError | null> {
  if (principalId === null) return COLLAB_IDENTITY_REQUIRED;
  const store = getStore();
  if (!store) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    const result = await store.listChannels(callerFor(principalId), {
      afterChannelId: null,
      limit,
      includeArchived: false,
    });
    publishOnly(sessionId, {
      message: 'Channels listed',
      metadata: { collabChannels: true, channels: result.channels },
    });
    return null;
  } catch (err: any) {
    // G2A D-1: this handler must be total -- there is no enclosing
    // try/catch around the dispatch switch in server.ts's async
    // socket.on('message') handler, so an escaping throw here becomes an
    // unhandled rejection that terminates the gateway process (Node 22
    // default). Same house pattern as CANCEL_TASK (server.ts) and the
    // widened catch below in handleGetChannelTimeline.
    if (err?.code === 'INVALID_REQUEST') {
      return { code: 'COLLAB_INVALID_REQUEST', detail: err.message };
    }
    // Unexpected/unclassified failure: never leak internal detail -- a
    // hidden channel must not become distinguishable through an error
    // message, so this arm stays generic regardless of what store threw.
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}

export interface ChannelLiveSubscription {
  subscriptionId: string;
  /** Connection-scoped subscription owner key (NOT the durable gateway session id), so one socket's close cannot deregister another live socket sharing that session. */
  ownerSessionId: string;
  credentialId: string;
  sink: DeliverySink;
  /** server.ts's non-throwing per-socket bookkeeping hook; invoked only after subscribeChannel succeeds. */
  onRegistered: (subscriptionId: string) => void;
}

/**
 * GET_CHANNEL_TIMELINE handler body. Read-only: SELECT + publishOnly, zero
 * writes. Membership/visibility scoping is entirely the substrate's
 * (assertChannelVisible) -- this function passes the caller through
 * UNMODIFIED and never inspects or rewrites the resulting COLLAB_NOT_FOUND.
 *
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S5: when `live` is supplied by
 * server.ts's per-socket lifecycle, a successful read ALSO registers the
 * substrate subscription that makes fanoutToChannel reachable for this
 * channel. The subscribe afterCursor is the read's own highWaterCursor (not
 * the page cursor), so a paged read does not replay unread history as hints,
 * while an event committing between the read and this registration is still
 * delivered through subscribeChannel's backlog window. The sink is expected
 * to translate delivery frames into seq-less invalidation hints only; §19's
 * real backpressure/delivery guarantee remains owed and is not claimed here.
 */
export async function handleGetChannelTimeline(
  sessionId: string,
  principalId: string | null,
  channelId: string,
  cursor: string,
  limit: number,
  live?: ChannelLiveSubscription,
): Promise<CollabSurfaceError | null> {
  if (principalId === null) return COLLAB_IDENTITY_REQUIRED;
  const store = getStore();
  if (!store) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    const result = await store.getChannelTimeline(callerFor(principalId), {
      channelId,
      afterCursor: cursor,
      limit,
    });
    if (live) {
      try {
        await store.subscribeChannel(
          callerFor(principalId),
          {
            channelId,
            afterCursor: result.highWaterCursor,
            sessionId: live.ownerSessionId,
            credentialId: live.credentialId,
            sink: live.sink,
          },
          live.subscriptionId,
        );
        live.onRegistered(live.subscriptionId);
      } catch {
        // Live delivery is an invalidation hint, never the source of truth
        // (005 S4 / 007 S5: §19 backpressure remains owed). A read that was
        // authorized must not fail because the best-effort subscription lost
        // a race after the read (e.g. membership revoked in the read ->
        // subscribe gap). Clean up any partially-registered subscription so it
        // cannot leak, then still return the page below. This cleanup is
        // owner-scoped, so on this rare failure path it can also close THIS
        // socket's other hint subscriptions; that only downgrades advisory
        // hints for this socket, never the durable cursor re-read, and never
        // a sibling socket sharing the session.
        try {
          await store.closeSubscriptionsForSession(live.ownerSessionId, 'unsubscribed');
        } catch {
          /* cleanup is best-effort; the read response remains authoritative */
        }
      }
    }
    publishOnly(sessionId, {
      message: 'Channel timeline read',
      metadata: {
        collabTimeline: true,
        channelId,
        events: result.events,
        cursor: result.nextCursor,
        hasMore: result.hasMore,
      },
    });
    return null;
  } catch (err: any) {
    if (err?.code === 'COLLAB_NOT_FOUND') {
      // T-2 byte-identity: this arm is UNCHANGED from before the D-1 fix --
      // same code, same detail source, same shape -- so the hidden-channel
      // vs nonexistent-channel payloads stay byte-identical.
      return { code: 'COLLAB_NOT_FOUND', detail: err.message };
    }
    // G2A D-1: widen instead of re-throwing. store.parseCursor throws
    // CollabError('INVALID_REQUEST', ...) for a malformed or out-of-range
    // cursor; CURSOR_OUT_OF_RANGE (thrown by other store methods on the
    // same cursor family) is handled by the same generic arm below. There
    // is no enclosing try/catch around the dispatch switch in server.ts's
    // async socket.on('message') handler -- an escaping throw here becomes
    // an unhandled rejection that terminates the gateway process (Node 22
    // default), exactly the CANCEL_TASK house pattern this mirrors.
    if (err?.code === 'INVALID_REQUEST') {
      return { code: 'COLLAB_INVALID_REQUEST', detail: err.message };
    }
    // Unexpected/unclassified failure: never leak internal detail here --
    // keeping this arm generic prevents any future thrown code from
    // becoming a distinguishing signal on the hidden-vs-absent channel
    // paths above.
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}

/**
 * POST_CHANNEL_MESSAGE handler body (S3). Write path: store.postChannelMessage
 * (store.ts:1422) validates+persists+fans-out; this function's job is purely
 * to translate every reachable outcome into a structured CollabSurfaceError
 * or a success result -- NEVER to let anything escape as a throw.
 *
 * A6(b)/T-9 totality: `store.postChannelMessage`'s full throw taxonomy on
 * this call path (verified by direct source read, store.ts):
 *   - CollabError('INVALID_REQUEST', ...)         <- normalizeMessageText
 *     (text.ts:110) fails; store.ts:1428-1431 converts the text.ts return
 *     value into this throw BEFORE the sequencer/predicate ever runs.
 *   - CollabError('COLLAB_NOT_FOUND', ...)         <- assertChannelVisible
 *     (store.ts:2032), the predicate slot: absent, hidden, or non-member
 *     channelId. Byte-identical message across all three causes (T-2).
 *   - CollabError('CHANNEL_ARCHIVED', ...)         <- store.ts:1455, thrown
 *     INSIDE the fn slot, only reachable AFTER assertChannelVisible has
 *     already passed (an archived channel is still visible to a member).
 *   - CollabError('IDEMPOTENCY_CONFLICT', ...)     <- runKeyedCommand
 *     (store.ts:2219): same (principalId, command, idempotencyKey) replayed
 *     with a DIFFERENT request_hash (a caller reusing a UUID for a genuinely
 *     different message). T-9 part-3's "domain error carrying some OTHER
 *     code" class is exercised by this arm in the T-9 matrix.
 *   - A plain (non-CollabError) `Error`, or a non-Error throw (string,
 *     null, undefined, number) -- unreachable from any *wire-admissible*
 *     input today (every store-side rejection above is a CollabError), but
 *     handled defensively by the final generic `catch` arm below exactly
 *     like handleListChannels/handleGetChannelTimeline: `err?.code` on a
 *     non-object throw is `undefined`, which falls through every `===`
 *     check here and lands on the generic COLLAB_UNAVAILABLE arm rather
 *     than escaping.
 *
 * Everything this function calls happens INSIDE this try/catch: the
 * fanoutToChannel call (store.ts:1497, awaited before postChannelMessage
 * resolves) and the publishOnly call below are both covered. Per A6(b)'s
 * "whole socket.on('message') path" scope, the ONLY code that executes
 * for this command OUTSIDE this function's own try/catch is server.ts's
 * dispatch arm itself (cmd.data field reads only, no throwing call -- see
 * server.ts) and sendErr's JSON.stringify/socket.send (netted identically
 * to every other collab command's error path -- see server.ts module doc).
 */
export async function handlePostChannelMessage(
  sessionId: string,
  principalId: string | null,
  channelId: string,
  text: string,
  idempotencyKey: string,
): Promise<CollabSurfaceError | null> {
  if (principalId === null) return COLLAB_IDENTITY_REQUIRED;
  const store = getStore();
  if (!store) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    const result = await store.postChannelMessage(
      callerFor(principalId),
      { channelId, text },
      idempotencyKey,
    );
    publishOnly(sessionId, {
      message: 'Channel message posted',
      metadata: {
        collabMessagePosted: true,
        channelId,
        // G2A D-1: the ack MUST carry the key it is acking. Without it the
        // console can only correlate by channelId, so with two sends in
        // flight on one channel the surviving ack stamps BOTH -- and a
        // rejected sibling is cleared as sent (a silent drop, forbidden by
        // §13 S3 / A8). This is the only field that makes the ack
        // attributable to a specific send.
        idempotencyKey,
        eventId: result.eventId,
        cursor: result.cursor,
        occurredAt: result.occurredAt,
      },
    });
    // PRD-TCLAW-AGENT-PARTICIPATION-007 S3: fire the auto-reply trigger
    // AFTER the message has committed (result resolved successfully above)
    // and AFTER the human-facing ack has been published -- never before.
    // Fire-and-forget deliberately: a human posting a message must not wait
    // on however many agent turns that post triggers. Failures inside the
    // trigger must never surface as a failure of the POST itself (the
    // message is already durably committed regardless).
    triggerAutoReply({
      channelId, channelSeq: Number(result.cursor), eventId: result.eventId, actorPrincipalId: principalId,
    });
    return null;
  } catch (err: any) {
    if (err?.code === 'COLLAB_NOT_FOUND') {
      // T-2 byte-identity: same code, same message-derivation as the S1
      // arms -- a non-member posting to a hidden/nonexistent channel must
      // stay indistinguishable from the read-path denial.
      return { code: 'COLLAB_NOT_FOUND', detail: err.message };
    }
    if (err?.code === 'INVALID_REQUEST') {
      // Covers BOTH the contract-admitted-but-substrate-rejected text cases
      // (A6 residue: JSON-encoded-byte overflow, post-NFC byte underflow,
      // disallowed control chars) -- text.ts's real bounds, which this
      // contract's coarser char-length grammar cannot fully express.
      return { code: 'COLLAB_INVALID_REQUEST', detail: err.message };
    }
    if (err?.code === 'CHANNEL_ARCHIVED') {
      return { code: 'COLLAB_CHANNEL_ARCHIVED', detail: err.message };
    }
    if (err?.code === 'IDEMPOTENCY_CONFLICT') {
      return { code: 'COLLAB_IDEMPOTENCY_CONFLICT', detail: err.message };
    }
    // Unexpected/unclassified failure (including any non-CollabError throw,
    // where err?.code is undefined and every branch above is skipped):
    // never leak internal detail, never let it escape as a rejection.
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}

/**
 * ACK_CHANNEL_CURSOR handler body (PRD-TCLAW-COLLAB-PRESENCE-UI-005 S6).
 * Write path, but a naturally-idempotent one: store.ackChannelCursor
 * (store.ts) upserts collab_cursors with max(existing,submitted) computed in
 * SQL, so a replayed or backwards ack is a substrate no-op, never an error.
 * The subject is the CONNECTION's resolved collab principal (§2a) -- this is
 * a per-principal read-state row, so the 005 wire surface subject
 * (connectionAuth.principalId) is used, never agentCollabPrincipalId.
 *
 * A6(b)/T-9 totality: `store.ackChannelCursor`'s full throw taxonomy on this
 * call path (verified by direct source read, store.ts):
 *   - CollabError('COLLAB_NOT_FOUND', ...)      <- assertChannelVisible:
 *     absent, hidden, or non-member channelId. Byte-identical message across
 *     all three causes (T-2), preserved byte-identically below.
 *   - CollabError('INVALID_REQUEST', ...)       <- store.parseCursor on a
 *     malformed cursor (unreachable from a wire-admissible frame -- the
 *     contract's regex rejects those first -- but covered defensively).
 *   - CollabError('CURSOR_OUT_OF_RANGE', ...)   <- submitted cursor exceeds
 *     the caller-visible bound (greatest committed channel_seq, or
 *     rejoined_seq). Mapped to COLLAB_INVALID_REQUEST like the other
 *     caller-correctable cursor rejections.
 *   - Anything else (non-CollabError throw, closed handle, etc.): the
 *     generic COLLAB_UNAVAILABLE arm, no internal detail leaked.
 */
export async function handleAckChannelCursor(
  sessionId: string,
  principalId: string | null,
  channelId: string,
  cursor: string,
): Promise<CollabSurfaceError | null> {
  if (principalId === null) return COLLAB_IDENTITY_REQUIRED;
  const store = getStore();
  if (!store) return { code: 'COLLAB_UNAVAILABLE' };
  try {
    const result = await store.ackChannelCursor(callerFor(principalId), { channelId, cursor });
    publishOnly(sessionId, {
      message: 'Channel cursor acknowledged',
      metadata: {
        collabCursorAcked: true,
        channelId,
        acknowledgedCursor: result.acknowledgedCursor,
      },
    });
    return null;
  } catch (err: any) {
    if (err?.code === 'COLLAB_NOT_FOUND') {
      // T-2 byte-identity: same code, same detail source, same shape as the
      // S1/S3 arms -- a hidden or non-member channel must stay
      // indistinguishable from a nonexistent one on the ack path too.
      return { code: 'COLLAB_NOT_FOUND', detail: err.message };
    }
    if (err?.code === 'INVALID_REQUEST' || err?.code === 'CURSOR_OUT_OF_RANGE') {
      return { code: 'COLLAB_INVALID_REQUEST', detail: err.message };
    }
    // Unexpected/unclassified failure: never leak internal detail, never let
    // it escape as a rejection (A6/T-9 -- no enclosing try/catch in
    // server.ts's dispatch switch).
    return { code: 'COLLAB_UNAVAILABLE' };
  }
}
