/**
 * PRD-TCLAW-COLLAB-PRESENCE-UI-005 S1 — Wire read surface (gateway + contracts).
 *
 * LIST_CHANNELS and GET_CHANNEL_TIMELINE, issued from an operator SEAT but
 * executed with the connection's resolved collab PRINCIPAL as the
 * substrate's CallerContext (§2a). The two lattices are never conflated:
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
 * so turning the read surface off can never revert the C0/C1 identity
 * hardening, and turning collab off elsewhere always turns this off too.
 * When either flag is off, both commands answer with the SAME terminal
 * ERROR frame shape as any other absent-deny action (server.ts).
 *
 * Read-only: SELECT via CollaborationStore's read-lock path, publishOnly
 * SYSTEM response frames (the LIST_APPROVALS pattern) -- zero writes,
 * nothing here can reach a mutation.
 *
 * G2A D-1: both handlers are TOTAL -- no store throw may escape either one.
 * There is no enclosing try/catch around the dispatch switch in server.ts's
 * async socket.on('message') handler, so an uncaught throw here would become
 * an unhandled rejection and (Node 22 default) terminate the gateway
 * process. Every throw is mapped to a returned CollabSurfaceError; the
 * COLLAB_NOT_FOUND arm is preserved byte-identically (T-2) and unexpected
 * failures are mapped to the generic COLLAB_UNAVAILABLE without leaking
 * internal detail.
 */

import { randomUUID } from 'node:crypto';
import {
  CollaborationStore,
  nodeRandomSource,
  type CallerContext,
  type BootstrapDb,
} from '@torqclaw/collab';
import { publishOnly } from './events.js';
import { collabEnabled } from './principalBridge.js';
import { getCollabDb, getPrincipalPepper } from './collabIdentity.js';

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

let storeOverride: CollaborationStore | null = null;
let defaultStore: CollaborationStore | null = null;

/** Test-only override of the CollaborationStore instance. Production never calls this. */
export function setCollabSurfaceStoreForTest(store: CollaborationStore | null): void {
  storeOverride = store;
}

/**
 * Lazily construct the production read-path store, sharing the exact
 * migrated collab.db handle and principal pepper collabIdentity.ts already
 * uses (getCollabDb/getPrincipalPepper) -- no second DB connection, no
 * duplicated SecretStore selection.
 *
 * The store's `uuids`/`rng` fields are required by CollaborationStoreEnv's
 * type but are never read by the two read-path methods this module calls
 * (listChannels/getChannelTimeline take no idempotencyKey and mint no
 * credential) -- nodeRandomSource plus a UUID source are supplied only to
 * satisfy the constructor, matching the "production RandomSource" already
 * exported for exactly this purpose.
 */
function getStore(): CollaborationStore | null {
  if (storeOverride) return storeOverride;
  const pepper = getPrincipalPepper();
  if (!pepper) return null; // same fail-closed posture as the connect path
  if (!defaultStore) {
    defaultStore = new CollaborationStore({
      db: getCollabDb() as unknown as BootstrapDb,
      clock: { next: () => new Date().toISOString() },
      uuids: { next: () => randomUUID() },
      rng: nodeRandomSource,
      principalPepper: pepper,
    });
  }
  return defaultStore;
}

export type CollabSurfaceError = {
  code: 'COLLAB_IDENTITY_REQUIRED' | 'COLLAB_NOT_FOUND' | 'COLLAB_UNAVAILABLE' | 'COLLAB_INVALID_REQUEST';
  detail?: unknown;
};

/** Refusal shared by both handlers when the connection has no resolved
 *  collab principal (§2a: refuse, never substitute or synthesize). */
export const COLLAB_IDENTITY_REQUIRED: CollabSurfaceError = { code: 'COLLAB_IDENTITY_REQUIRED' };

function callerFor(principalId: string): CallerContext {
  // kind is never asserted by the gateway -- the substrate reads
  // principals.kind from its own DB for every security-relevant check
  // (assertOperatorCaller/assertChannelOwner/assertChannelVisible). This
  // gateway-side value is advisory plumbing only, required by the
  // CallerContext type; it cannot escalate anything.
  return { principalId, kind: 'operator' };
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

/**
 * GET_CHANNEL_TIMELINE handler body. Read-only: SELECT + publishOnly, zero
 * writes. Membership/visibility scoping is entirely the substrate's
 * (assertChannelVisible) -- this function passes the caller through
 * UNMODIFIED and never inspects or rewrites the resulting COLLAB_NOT_FOUND.
 */
export async function handleGetChannelTimeline(
  sessionId: string,
  principalId: string | null,
  channelId: string,
  cursor: string,
  limit: number,
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
