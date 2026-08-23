/**
 * CollaborationStore identity layer for the Collaboration Substrate.
 *
 * Implements the Slice 1 identity commands: CREATE_AGENT,
 * CREATE_PRINCIPAL_CREDENTIAL, SUSPEND_AGENT, RESTORE_AGENT, REVOKE_AGENT,
 * ROTATE_PRINCIPAL_CREDENTIAL, REVOKE_PRINCIPAL_CREDENTIAL.
 *
 * Every command runs the Section 8.3 atomic protocol:
 *   1. in-process mutex -> BEGIN IMMEDIATE
 *   2. in-transaction predicate revalidation
 *   3. (principal_id,command,idempotency_key) lookup
 *   4. same-hash replay -> return stored redacted result (no mutation)
 *   5. different-hash replay -> IDEMPOTENCY_CONFLICT (rollback)
 *   6. otherwise: mutation + redacted result row, same transaction
 *   7. commit BEFORE one-time secret handoff.
 *
 * (F8) Mutex scope, precisely: `Mutex.withLock`'s `fn` callback IS
 * `runKeyedCommand`'s body, so the mutex is actually held from step 1
 * through the moment `runKeyedCommand` returns its plaintext result to the
 * caller of `createAgent`/etc — i.e. the plaintext `result` value is
 * constructed and returned to the *caller* WHILE the mutex is still held,
 * not released exactly "at commit". This is deliberate and safe: every
 * step from commit through that return is synchronous in-process work with
 * NO socket I/O and no `await` (the DB commit itself, `JSON.parse` of a
 * replay row, and zeroing `pendingSecretBytes` in the `finally`) — there is
 * no fan-out, no network write, and no yield point where another task
 * could observe or extend the critical section. What Section 8.3 step 7
 * actually requires — commit strictly BEFORE any one-time secret HANDOFF
 * (i.e. before the plaintext ever reaches a socket/transport boundary) —
 * still holds unconditionally: handoff to the network happens at the
 * protocol/frame layer, outside this store entirely, and always occurs
 * after `withLock`'s promise resolves, which is always after commit.
 *
 * (H1/F2) request_hash = SHA-256 over canonicalJson of the
 * POST-NORMALIZATION POST-TRIM body — the exact bytes persisted, not the
 * raw request body. The STORE itself performs this normalization (NFC then
 * trim, via text.ts's normalizeName) for every free-text field BEFORE
 * computing request_hash and BEFORE persisting — CREATE_AGENT's
 * displayName is normalized at the top of createAgent(), so the hash
 * always covers exactly the bytes that get written to `principals`, no
 * matter what whitespace/NFC-decomposed variant of the same logical name a
 * caller sends under the same idempotency key.
 * (H3) same-state fresh-key rule applies to suspend-on-suspended,
 * restore-on-active, AND revoke-on-revoked: each commits a new success
 * result recording current state with no epoch increment, no session
 * closure, no audit row.
 * (L2) LAST_OPERATOR_CREDENTIAL guard counts ACTIVE operator credentials
 * INSIDE the transaction after BEGIN IMMEDIATE.
 * Section 9 validations 1, 7, 9 (e-3): every write verifies the invoking
 * principal is the operator at storage level; violations roll back with
 * ZERO row changes.
 * (e-2) audit rows for ALL credential commands (credential_created,
 * credential_revoked) and agent_suspended/agent_restored/agent_revoked —
 * secret-free.
 * (M1) a secret_hmac UNIQUE violation is caught and surfaced as a typed
 * internal invariant error, never an uncaught SQLite exception.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { issueCredential, type CredentialLookup } from './credentials.js';
import { normalizeName, normalizeMessageText } from './text.js';
import { nameKey } from './fold.js';
import type { RandomSource, Clock, UuidSource, BootstrapDb } from './bootstrap.js';
import { AuthLock } from './authlock.js';
import { SubscriptionRegistry, type Subscription, type EpochSnapshot, type SubscriptionCloseReason } from './subscriptions.js';
import {
  runAuthorizationMutation,
  affectedByChannel,
  affectedByPrincipal,
  affectedBySession,
  type AffectedSet,
} from './coordinator.js';
import { fanoutToChannel, type CommittedChannelEvent } from './fanout.js';
import { CollabObservability } from './observability.js';

// ---------------------------------------------------------------------------
// Errors / result codes (Section 7.4 / 7.6 subset relevant to Slice 1 + 2)
// ---------------------------------------------------------------------------

export type CollabErrorCode =
  | 'PRINCIPAL_NOT_FOUND'
  | 'CREDENTIAL_NOT_FOUND'
  | 'INVALID_PRINCIPAL_STATE'
  | 'INVALID_PRINCIPAL_TRANSITION'
  | 'INVALID_REQUEST'
  | 'LAST_OPERATOR_CREDENTIAL'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PERSONA_REVISION_CONFLICT'
  | 'COLLAB_NOT_PERMITTED'
  | 'COLLAB_NOT_FOUND'
  | 'CHANNEL_ARCHIVED'
  | 'CHANNEL_NAME_CONFLICT'
  | 'CURSOR_OUT_OF_RANGE';

/**
 * (C3) COLLAB_NOT_FOUND is byte-identical across every denial cause —
 * absent, hidden, archived-hidden, non-member, and owner-only-by-non-owner.
 * Fixed message text, retryable:false, so no code path may construct this
 * error with a different message string (which would create a distinguishing
 * oracle even though the `code` matches).
 */
const COLLAB_NOT_FOUND_MESSAGE = 'Request could not be completed';

function notFound(): CollabError {
  return new CollabError('COLLAB_NOT_FOUND', COLLAB_NOT_FOUND_MESSAGE);
}

export class CollabError extends Error {
  readonly code: CollabErrorCode;
  constructor(code: CollabErrorCode, message: string) {
    super(message);
    this.name = 'CollabError';
    this.code = code;
  }
}

/**
 * (M1) Thrown when a secret_hmac UNIQUE constraint violation is detected —
 * an injected-RNG collision on the credential secret. This is an internal
 * invariant failure (astronomically unlikely with a real CSPRNG; only
 * reachable in tests with a deliberately reused harness RNG state), not a
 * client-facing protocol error.
 */
export class CredentialHmacCollisionError extends Error {
  readonly code = 'CREDENTIAL_HMAC_COLLISION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CredentialHmacCollisionError';
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PrincipalRow {
  id: string;
  kind: 'operator' | 'agent';
  display_name: string;
  owner_principal_id: string | null;
  status: 'active' | 'suspended' | 'revoked';
  auth_epoch: number;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CredentialRow {
  id: string;
  principal_id: string;
  secret_hmac: Buffer;
  state: 'active' | 'revoked';
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface ChannelRow {
  id: string;
  name: string;
  name_key: string;
  state: 'active' | 'archived';
  owner_principal_id: string;
  channel_epoch: number;
  external_export_policy: 'local_only' | 'operator_confirmed_non_sensitive';
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  channel_id: string;
  principal_id: string;
  role: 'owner' | 'agent';
  state: 'active' | 'removed';
  membership_epoch: number;
  rejoined_seq: number;
  joined_at: string;
  removed_at: string | null;
}

interface EventRow {
  seq: number;
  id: string;
  schema_version: number;
  channel_id: string;
  channel_seq: number;
  actor_principal_id: string;
  kind: string;
  content_json: string;
  created_at: string;
}

interface AgentRuntimeProfileRow {
  agent_principal_id: string;
  provider_account_id: string;
  adapter_id: string;
  model_id: string;
  autostart: 0 | 1;
  external_context_confirmed: 0 | 1;
  external_context_provider_account_id: string | null;
  external_context_model_id: string | null;
  external_context_runtime_fingerprint: string | null;
  external_context_exact_model_id: string | null;
  external_context_persona_revision: number | null;
  external_context_persona_content_sha256: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentPersonaRow {
  agent_principal_id: string;
  icon_id: AgentIconId;
  system_directives: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Command result shapes (Section 7.4)
// ---------------------------------------------------------------------------

export type CredentialProducingResult =
  | { principalId: string; credentialId: string; credential: string; credentialAvailable: true }
  | { principalId: string; credentialId: string; credentialAvailable: false };

export type RotateCredentialResult =
  | (CredentialProducingResult & { replacedCredentialId: string });

export interface AgentLifecycleResult {
  principalId: string;
  status: 'active' | 'suspended' | 'revoked';
  authEpoch: number;
}

export interface RevokeAgentResult extends AgentLifecycleResult {
  revokedCredentialCount: number;
}

export interface RevokeCredentialResult {
  credentialId: string;
  revokedAt: string;
}

// ---------------------------------------------------------------------------
// Command result shapes (Section 7.4 channel commands)
// ---------------------------------------------------------------------------

export interface CreateChannelResult {
  channelId: string;
  name: string;
  externalExportPolicy: 'local_only';
}

export interface ChannelMemberResult {
  channelId: string;
  principalId: string;
  membershipEpoch: number;
}

export interface ChannelArchiveResult {
  channelId: string;
  state: 'active' | 'archived';
  channelEpoch: number;
}

export interface TimelineEventObject {
  cursor: string;
  id: string;
  kind: string;
  actorPrincipalId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface ListChannelsEntry {
  channelId: string;
  name: string;
  state: 'active' | 'archived';
  role: 'owner' | 'agent';
  lastAcknowledgedCursor: string;
  externalExportPolicy: 'local_only' | 'operator_confirmed_non_sensitive';
}

export interface SetChannelExternalExportPolicyResult {
  channelId: string;
  externalExportPolicy: 'local_only' | 'operator_confirmed_non_sensitive';
  updatedAt: string;
}

export interface ListChannelsResult {
  channels: ListChannelsEntry[];
  nextChannelId: string | null;
  hasMore: boolean;
}

export interface GetChannelTimelineResult {
  events: TimelineEventObject[];
  nextCursor: string;
  hasMore: boolean;
  /**
   * PRD-TCLAW-AGENT-PARTICIPATION-007 S5: greatest committed channel_seq
   * observed by THIS read, captured inside the same read command before the
   * result is returned. The gateway's live-subscription seam uses this as
   * the subscribe afterCursor so a paged read (hasMore=true) does not replay
   * the remaining history as hints, while an event committing between the
   * read and SUBSCRIBE registration is still inside subscribeChannel's
   * backlog window (afterCursor < committed seq <= registration highWater).
   */
  highWaterCursor: string;
}

export interface AckChannelCursorResult {
  channelId: string;
  acknowledgedCursor: string;
}

export interface PostChannelMessageResult {
  eventId: string;
  cursor: string;
  occurredAt: string;
}

export interface AgentTurnRuntimeSnapshot {
  providerAccountId: string;
  adapterId: string;
  modelId: string;
  personaRevision: number;
  runtimeFingerprint?: string | null;
  exactModelId?: string | null;
  personaContentSha256?: string | null;
}

export interface AgentPersonaEnvelope {
  version: 1;
  content: string;
  personaRevision: number;
  contentSha256: string;
}

export interface AgentTurnIdentity {
  channelId: string;
  agentPrincipalId: string;
  channelSeq: number;
  triggerEventId: string;
}

export interface ClaimedAgentTurn {
  status: 'claimed' | 'duplicate';
  identity: AgentTurnIdentity;
  personaEnvelope: AgentPersonaEnvelope;
  runtimeProfile: AgentRuntimeProfile;
}

export interface LegacyAgentTurnRefusal {
  status: 'legacy_terminated';
  identity: AgentTurnIdentity;
}

export type AgentTurnClaimResult = ClaimedAgentTurn | LegacyAgentTurnRefusal;

export interface CommitAgentTurnFallbackInput {
  channelId: string;
  agentPrincipalId: string;
  channelSeq: number;
  dispatchRequestId: string;
  recoveryLeaseToken?: string;
  expectedProfile: AgentTurnRuntimeSnapshot;
  personaEnvelope: AgentPersonaEnvelope;
  text: string;
}

export interface CommitAgentTurnFallbackResult extends PostChannelMessageResult {
  outputKind: 'tool' | 'fallback';
  replayed: boolean;
}

export interface CommitAgentTurnOutputInput extends CommitAgentTurnFallbackInput {
  outputKind: 'tool' | 'fallback';
}

export interface AgentRuntimeProfile {
  agentPrincipalId: string;
  providerAccountId: string;
  adapterId: string;
  modelId: string;
  autostart: boolean;
  externalContextConfirmed: boolean;
  externalContextRuntimeFingerprint: string | null;
  externalContextExactModelId: string | null;
  externalContextPersonaRevision: number | null;
  externalContextPersonaContentSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAgentRuntimeProfileInput {
  agentPrincipalId: string;
  providerAccountId: string;
  adapterId: string;
  modelId: string;
  autostart: boolean;
  externalContextConfirmed: boolean;
  externalContextRuntimeFingerprint?: string | null;
  externalContextExactModelId?: string | null;
  externalContextPersonaRevision?: number | null;
  externalContextPersonaContentSha256?: string | null;
}

export interface ProvisionAgentInput extends UpsertAgentRuntimeProfileInput {
  displayName: string;
  channelIds: string[];
}

export interface ProvisionAgentResult extends AgentRuntimeProfile {
  displayName: string;
  status: 'active';
  membershipResults: Array<{ channelId: string; ok: true }>;
}

export const AGENT_ICON_IDS = ['robot', 'brain', 'shield', 'search', 'code', 'spark', 'bolt', 'target'] as const;
export type AgentIconId = typeof AGENT_ICON_IDS[number];

export interface AgentPersona {
  agentPrincipalId: string;
  iconId: AgentIconId;
  systemDirectives: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAgentPersonaInput {
  agentPrincipalId: string;
  iconId: AgentIconId;
  systemDirectives: string;
  expectedRevision: number;
  reconfirmExternalContext?: boolean;
  externalContextRuntimeFingerprint?: string | null;
  externalContextExactModelId?: string | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface CollaborationStoreEnv {
  db: BootstrapDb;
  clock: Clock;
  uuids: UuidSource;
  rng: RandomSource;
  principalPepper: Buffer;
  /**
   * (C2) The writer-preferring authorization RW-lock (Section 8.3). Optional
   * for backward compatibility with Slice 1/2 callers that construct a
   * CollaborationStore without live-slice concerns — when omitted, a fresh
   * per-store AuthLock is created, which is always correct for a single
   * store instance (the lock only needs to be shared across concurrent
   * commands against the SAME store, which happens automatically since it
   * lives on `this`).
   */
  lock?: AuthLock;
  /** In-memory subscription registry (Section 5.5, 8.1-8.3). Optional; defaults to a fresh empty registry. */
  registry?: SubscriptionRegistry;
  /** Section 13 in-memory counters. Optional; defaults to a fresh instance. */
  observability?: CollabObservability;
  /** Injected wall-clock-ms source for lock/latency accounting; defaults to Date.now. Deterministic tests inject a controllable clock. */
  nowMs?: () => number;
}

export interface SubscribeChannelResult {
  subscriptionId: string;
  highWaterCursor: string;
}

export interface UnsubscribeChannelResult {
  subscriptionId: string;
  state: 'closed';
}

/** Minimal caller identity, established by the (not-yet-built) session layer. */
export interface CallerContext {
  principalId: string;
  kind: 'operator' | 'agent';
}

/**
 * Simple in-process mutex (Section 8.3's "sequencer mutex" for this
 * headless slice — full lock-class partitioning across read/write
 * authorization locks lands with the Live slice; Slice 1 needs only the
 * exclusivity guarantee for BEGIN IMMEDIATE ordering). Since Node.js is
 * single-threaded, a promise chain is a correct, simple mutex.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async withLock<T>(fn: () => T): Promise<T> {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const previous = this.tail;
    this.tail = this.tail.then(() => wait);
    await previous;
    try {
      return fn();
    } finally {
      release();
    }
  }
}

export class CollaborationStore {
  async claimAgentTurn(input: AgentTurnIdentity & { nowIso: string }): Promise<AgentTurnClaimResult> {
    const identity: AgentTurnIdentity = {
      channelId: this.normalizeRuntimeIdentifier(input.channelId, 'channelId'),
      agentPrincipalId: this.normalizeRuntimeIdentifier(input.agentPrincipalId, 'agentPrincipalId'),
      channelSeq: input.channelSeq,
      triggerEventId: this.normalizeRuntimeIdentifier(input.triggerEventId, 'triggerEventId'),
    };
    if (!Number.isSafeInteger(identity.channelSeq) || identity.channelSeq <= 0) {
      throw new CollabError('INVALID_REQUEST', 'channelSeq must be a positive safe integer');
    }
    return this.withReadThenSequencer(() => this.mutex.withLock(() =>
      this.runNaturallyIdempotentCommand(identity.agentPrincipalId, 'CLAIM_AGENT_TURN', (tx) => {
        const existing = tx.prepare(`
          SELECT trigger_event_id AS triggerEventId, state,
                 persona_envelope_version AS version, persona_content AS content,
                 persona_revision AS personaRevision, persona_content_sha256 AS contentSha256
            FROM collab_agent_turns
           WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?
        `).get(identity.channelId, identity.agentPrincipalId, identity.channelSeq) as {
          triggerEventId: string; state: string; version: number | null; content: string | null;
          personaRevision: number | null; contentSha256: string | null;
        } | undefined;
        if (existing) {
          if (existing.triggerEventId !== identity.triggerEventId) {
            throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent turn trigger identity changed');
          }
          const absent = existing.version === null && existing.content === null
            && existing.personaRevision === null && existing.contentSha256 === null;
          if (absent) {
            if (existing.state === 'dispatched') {
              tx.prepare(`UPDATE collab_agent_turns SET state = 'terminated', resolved_at = ?
                WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ? AND state = 'dispatched'`)
                .run(input.nowIso, identity.channelId, identity.agentPrincipalId, identity.channelSeq);
            }
            return { status: 'legacy_terminated', identity };
          }
          return {
            status: 'duplicate',
            identity,
            personaEnvelope: this.validatePersonaEnvelope({
              version: existing.version, content: existing.content,
              personaRevision: existing.personaRevision, contentSha256: existing.contentSha256,
            }),
            runtimeProfile: this.runtimeProfileForClaim(tx, identity.agentPrincipalId),
          };
        }
        const runtimeProfile = this.runtimeProfileForClaim(tx, identity.agentPrincipalId);
        const persona = tx.prepare(`SELECT system_directives AS systemDirectives, revision
          FROM collab_agent_personas WHERE agent_principal_id = ?`)
          .get(identity.agentPrincipalId) as { systemDirectives: string; revision: number } | undefined;
        const envelope = this.mintPersonaEnvelope(persona?.systemDirectives ?? '', persona?.revision ?? 0);
        tx.prepare(`INSERT INTO collab_agent_turns(
          channel_id, agent_principal_id, channel_seq, trigger_event_id, state,
          dispatch_request_id, dispatched_at, resolved_at,
          persona_envelope_version, persona_content, persona_revision, persona_content_sha256
        ) VALUES(?, ?, ?, ?, 'dispatched', NULL, ?, NULL, ?, ?, ?, ?)`)
          .run(identity.channelId, identity.agentPrincipalId, identity.channelSeq,
            identity.triggerEventId, input.nowIso, envelope.version, envelope.content,
            envelope.personaRevision, envelope.contentSha256);
        return { status: 'claimed', identity, personaEnvelope: envelope, runtimeProfile };
      }),
    ));
  }

  private readonly env: CollaborationStoreEnv;
  private readonly mutex = new Mutex();

  /**
   * (C2) The writer-preferring authorization RW-lock, layered ABOVE
   * `this.mutex` (the sequencer mutex, retained unchanged beneath it).
   * Every keyed command acquires this lock (read for non-authorization
   * mutations + naturally-idempotent + read-path commands, write for
   * authorization mutations) BEFORE `this.mutex.withLock`, per Section 8.3's
   * three-class lock partition.
   */
  private readonly lock: AuthLock;
  private readonly registry: SubscriptionRegistry;
  private readonly observability: CollabObservability;
  private readonly nowMs: () => number;

  /**
   * (F1) Holds the currently-live, not-yet-zeroed credential secret Buffer
   * for the command in flight, if any. Set the instant `issueCredentialRow`
   * allocates the secret — BEFORE the INSERT, BEFORE the mutation-result
   * row, BEFORE commit — so that a `finally` block wrapped around the
   * entire transaction closure in `runKeyedCommand` can zero it
   * unconditionally, regardless of WHERE between allocation and commit a
   * throw occurs (a later `clock.next()` call, the mutation-result INSERT,
   * even a hypothetical failure inside `fn` after allocation). Cleared
   * (set back to `undefined`) immediately after zeroing so a subsequent
   * command in the same store instance starts from a clean slate.
   */
  private pendingSecretBytes: Buffer | undefined;

  constructor(env: CollaborationStoreEnv) {
    this.env = env;
    this.lock = env.lock ?? new AuthLock();
    this.registry = env.registry ?? new SubscriptionRegistry();
    this.observability = env.observability ?? new CollabObservability();
    this.nowMs = env.nowMs ?? (() => Date.now());
  }

  // -------------------------------------------------------------------
  // Lock-class combinators (Section 8.3 / L1 driver re-slotting)
  //
  //  - withReadThenSequencer: read lock, then this.mutex (sequencer),
  //    for non-authorization mutations AND naturally-idempotent commands
  //    (SUBSCRIBE_CHANNEL, ACK_CHANNEL_CURSOR, UNSUBSCRIBE_CHANNEL).
  //  - withReadOnly: read lock only, no sequencer — LIST_CHANNELS,
  //    GET_CHANNEL_TIMELINE.
  //  - withWriteThenSequencer (coordinator.ts's runAuthorizationMutation):
  //    write lock, then this.mutex, then post-commit sync close+purge,
  //    for the nine authorization mutations (H2: including ADD_CHANNEL_
  //    MEMBER and RESTORE_AGENT — never demoted to read lock).
  // -------------------------------------------------------------------

  private async withReadThenSequencer<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.lock.acquireRead();
    try {
      return await fn();
    } finally {
      this.lock.releaseRead();
    }
  }

  private async withReadOnly<T>(fn: () => T): Promise<T> {
    await this.lock.acquireRead();
    try {
      return fn();
    } finally {
      this.lock.releaseRead();
    }
  }

  private coordinatorDeps() {
    return { lock: this.lock, registry: this.registry, observability: this.observability, nowMs: this.nowMs };
  }

  // -------------------------------------------------------------------
  // Public commands
  // -------------------------------------------------------------------

  async createAgent(
    caller: CallerContext,
    body: { displayName: string },
    idempotencyKey: string
  ): Promise<CredentialProducingResult> {
    // (F2) The store itself normalizes displayName — NFC then trim, via the
    // same normalizeName used by the frame/command layer — BEFORE computing
    // request_hash and BEFORE persisting, so the hash and the persisted
    // bytes are always the exact same normalized form regardless of what
    // whitespace/NFC-decomposed variant the caller passed in. This makes
    // normalization idempotent-safe at the store boundary rather than
    // relying on every caller to have already normalized.
    const normalized = normalizeName(body.displayName);
    if ('error' in normalized) {
      throw new CollabError('INVALID_REQUEST', normalized.message);
    }
    const normalizedBody = { displayName: normalized.name };

    return this.withReadThenSequencer(() =>
      this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'CREATE_AGENT',
        idempotencyKey,
        normalizedBody,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const operator = this.getOperatorOrThrow(tx);

        const agentId = this.env.uuids.next();
        const now = this.env.clock.next();
        tx
          .prepare(
            'INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
          )
          .run(agentId, 'agent', normalizedBody.displayName, operator.id, 'active', 1, null, now, now);

        const cred = this.issueCredentialRow(tx, agentId, now);
        this.insertAudit(tx, 'credential_created', caller.principalId, agentId, {
          principalId: agentId,
          credentialId: cred.credentialId,
        });

        const result: CredentialProducingResult = {
          principalId: agentId,
          credentialId: cred.credentialId,
          credential: cred.token,
          credentialAvailable: true,
        };
        const redacted: CredentialProducingResult = {
          principalId: agentId,
          credentialId: cred.credentialId,
          credentialAvailable: false,
        };
        return { result, redacted, secretBytes: cred.secretBytes };
      })
      )
    );
  }

  /**
   * Atomically provisions a runtime-backed agent. The principal is inserted
   * suspended and the profile with autostart disabled; only after every
   * requested membership and event is committed does the same transaction
   * activate the principal and apply the requested autostart value.
   *
   * The live authority callback is deliberately excluded from the hashed
   * request body and invoked inside the writer transaction immediately before
   * mutation. It must re-read the authoritative gateway grant/epoch.
   */
  async provisionAgent(
    caller: CallerContext,
    body: Omit<ProvisionAgentInput, 'agentPrincipalId'>,
    idempotencyKey: string,
    hasLiveDelegateAuthority: () => boolean,
  ): Promise<ProvisionAgentResult> {
    const normalizedName = normalizeName(body.displayName);
    if ('error' in normalizedName) throw new CollabError('INVALID_REQUEST', normalizedName.message);
    const normalizedBody = {
      displayName: normalizedName.name,
      providerAccountId: this.normalizeRuntimeIdentifier(body.providerAccountId, 'providerAccountId'),
      adapterId: this.normalizeRuntimeIdentifier(body.adapterId, 'adapterId'),
      modelId: this.normalizeRuntimeIdentifier(body.modelId, 'modelId'),
      autostart: body.autostart,
      externalContextConfirmed: body.externalContextConfirmed,
      externalContextRuntimeFingerprint: body.externalContextRuntimeFingerprint ?? null,
      externalContextExactModelId: body.externalContextExactModelId ?? null,
      externalContextPersonaRevision: body.externalContextPersonaRevision ?? null,
      externalContextPersonaContentSha256: body.externalContextPersonaContentSha256 ?? null,
      channelIds: [...new Set(body.channelIds.map((value) => this.normalizeRuntimeIdentifier(value, 'channelId')))],
    };
    if (typeof normalizedBody.autostart !== 'boolean') {
      throw new CollabError('INVALID_REQUEST', 'autostart must be a boolean');
    }
    if (typeof normalizedBody.externalContextConfirmed !== 'boolean') {
      throw new CollabError('INVALID_REQUEST', 'externalContextConfirmed must be a boolean');
    }
    if (normalizedBody.providerAccountId !== 'ollama-local'
      && (normalizedBody.autostart || normalizedBody.externalContextConfirmed)) {
      throw new CollabError(
        'INVALID_REQUEST',
        'External agents must be created inactive and explicitly reconfirmed after profile creation',
      );
    }
    this.validateExternalContextBinding(normalizedBody);
    if (
      normalizedBody.autostart
      && normalizedBody.providerAccountId !== 'ollama-local'
      && !normalizedBody.externalContextConfirmed
    ) {
      throw new CollabError(
        'INVALID_REQUEST',
        'External subscription autostart requires provider/model-specific context export confirmation',
      );
    }

    const committed: CommittedChannelEvent[] = [];
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () => this.mutex.withLock(() => this.runKeyedCommand(
        caller.principalId,
        'PROVISION_AGENT',
        idempotencyKey,
        normalizedBody,
        (tx) => {
          this.assertOperatorCaller(tx, caller);
          if (!hasLiveDelegateAuthority()) {
            throw new CollabError('COLLAB_NOT_PERMITTED', 'Live delegate authority is required to provision agents');
          }
          for (const channelId of normalizedBody.channelIds) {
            const channel = this.assertChannelOwner(tx, caller, channelId);
            if (channel.state === 'archived') {
              throw new CollabError('CHANNEL_ARCHIVED', 'Channel is archived');
            }
          }
        },
        (tx) => {
          const operator = this.getOperatorOrThrow(tx);
          const agentId = this.env.uuids.next();
          const createdAt = this.env.clock.next();
          tx.prepare(
            'INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
          ).run(agentId, 'agent', normalizedBody.displayName, operator.id, 'suspended', 1, null, createdAt, createdAt);

          tx.prepare(`
            INSERT INTO collab_agent_runtime_profiles(
              agent_principal_id, provider_account_id, adapter_id, model_id,
              autostart, external_context_confirmed,
              external_context_provider_account_id, external_context_model_id,
              external_context_runtime_fingerprint, external_context_exact_model_id,
              external_context_persona_revision, external_context_persona_content_sha256,
              created_at, updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            agentId,
            normalizedBody.providerAccountId,
            normalizedBody.adapterId,
            normalizedBody.modelId,
            0,
            normalizedBody.externalContextConfirmed ? 1 : 0,
            normalizedBody.externalContextConfirmed ? normalizedBody.providerAccountId : null,
            normalizedBody.externalContextConfirmed ? normalizedBody.modelId : null,
            normalizedBody.externalContextConfirmed ? normalizedBody.externalContextRuntimeFingerprint : null,
            normalizedBody.externalContextConfirmed ? normalizedBody.externalContextExactModelId : null,
            normalizedBody.externalContextConfirmed ? normalizedBody.externalContextPersonaRevision : null,
            normalizedBody.externalContextConfirmed ? normalizedBody.externalContextPersonaContentSha256 : null,
            createdAt,
            createdAt,
          );

          const membershipResults: Array<{ channelId: string; ok: true }> = [];
          for (const channelId of normalizedBody.channelIds) {
            const channel = this.getChannelOrThrow(tx, channelId);
            const rejoinedSeq = this.getMaxChannelSeq(tx, channel.id);
            const channelSeq = rejoinedSeq + 1;
            const joinedAt = this.env.clock.next();
            tx.prepare(
              'INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES(?,?,?,?,?,?,?,?)',
            ).run(channel.id, agentId, 'agent', 'active', 1, rejoinedSeq, joinedAt, null);

            const eventId = this.env.uuids.next();
            const occurredAt = this.env.clock.next();
            const payload = { channelId: channel.id, principalId: agentId, membershipEpoch: 1 };
            tx.prepare(
              'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?,?,?,?,?,?,?,?)',
            ).run(
              eventId,
              1,
              channel.id,
              channelSeq,
              caller.principalId,
              'member_added',
              canonicalJson(payload),
              occurredAt,
            );
            committed.push({
              channelId: channel.id,
              channelSeq,
              eventId,
              kind: 'member_added',
              actorPrincipalId: caller.principalId,
              occurredAt,
              payload,
            });
            membershipResults.push({ channelId: channel.id, ok: true });
          }

          const activatedAt = this.env.clock.next();
          tx.prepare(
            'UPDATE collab_agent_runtime_profiles SET autostart = ?, updated_at = ? WHERE agent_principal_id = ?',
          ).run(normalizedBody.autostart ? 1 : 0, activatedAt, agentId);
          tx.prepare(
            "UPDATE principals SET status = 'active', updated_at = ? WHERE id = ? AND status = 'suspended'",
          ).run(activatedAt, agentId);

          const provisioned: ProvisionAgentResult = {
            agentPrincipalId: agentId,
            displayName: normalizedBody.displayName,
            status: 'active',
            providerAccountId: normalizedBody.providerAccountId,
            adapterId: normalizedBody.adapterId,
            modelId: normalizedBody.modelId,
            autostart: normalizedBody.autostart,
            externalContextConfirmed: normalizedBody.externalContextConfirmed,
            externalContextRuntimeFingerprint: normalizedBody.externalContextRuntimeFingerprint,
            externalContextExactModelId: normalizedBody.externalContextExactModelId,
            externalContextPersonaRevision: normalizedBody.externalContextPersonaRevision,
            externalContextPersonaContentSha256: normalizedBody.externalContextPersonaContentSha256,
            membershipResults,
            createdAt,
            updatedAt: activatedAt,
          };
          return { result: provisioned, redacted: provisioned };
        },
      )),
      () => ({ subscriptions: [] }),
    );

    for (const event of committed) {
      await fanoutToChannel(
        {
          lock: this.lock,
          registry: this.registry,
          db: this.env.db,
          observability: this.observability,
          nowMs: this.nowMs,
        },
        event,
      );
    }
    return result;
  }

  /** Returns an owned agent's runtime binding without exposing credentials. */
  async getAgentRuntimeProfile(
    caller: CallerContext,
    body: { agentPrincipalId: string },
  ): Promise<AgentRuntimeProfile | null> {
    return this.withReadOnly(() => this.runReadCommand(() => {
      this.assertOperatorCaller(this.env.db, caller);
      this.assertOwnedAgent(this.env.db, caller, body.agentPrincipalId);
      const row = this.env.db
        .prepare('SELECT * FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?')
        .get(body.agentPrincipalId) as AgentRuntimeProfileRow | undefined;
      return row ? this.runtimeProfileFromRow(row) : null;
    }));
  }

  /**
   * Creates or replaces an owned agent's runtime binding. The account field is
   * an opaque catalog reference; secrets remain in the provider/secret layer.
   */
  async upsertAgentRuntimeProfile(
    caller: CallerContext,
    body: UpsertAgentRuntimeProfileInput,
    idempotencyKey: string,
  ): Promise<AgentRuntimeProfile> {
    const normalizedBody: UpsertAgentRuntimeProfileInput = {
      agentPrincipalId: this.normalizeRuntimeIdentifier(body.agentPrincipalId, 'agentPrincipalId'),
      providerAccountId: this.normalizeRuntimeIdentifier(body.providerAccountId, 'providerAccountId'),
      adapterId: this.normalizeRuntimeIdentifier(body.adapterId, 'adapterId'),
      modelId: this.normalizeRuntimeIdentifier(body.modelId, 'modelId'),
      autostart: body.autostart,
      externalContextConfirmed: body.externalContextConfirmed,
      externalContextRuntimeFingerprint: body.externalContextRuntimeFingerprint ?? null,
      externalContextExactModelId: body.externalContextExactModelId ?? null,
      externalContextPersonaRevision: body.externalContextPersonaRevision ?? null,
      externalContextPersonaContentSha256: body.externalContextPersonaContentSha256 ?? null,
    };
    if (typeof normalizedBody.autostart !== 'boolean') {
      throw new CollabError('INVALID_REQUEST', 'autostart must be a boolean');
    }
    if (typeof normalizedBody.externalContextConfirmed !== 'boolean') {
      throw new CollabError('INVALID_REQUEST', 'externalContextConfirmed must be a boolean');
    }
    this.validateExternalContextBinding(normalizedBody);
    if (
      normalizedBody.autostart
      && normalizedBody.providerAccountId !== 'ollama-local'
      && !normalizedBody.externalContextConfirmed
    ) {
      throw new CollabError(
        'INVALID_REQUEST',
        'External subscription autostart requires provider/model-specific context export confirmation',
      );
    }

    return this.withReadThenSequencer(() =>
      this.mutex.withLock(() =>
        this.runKeyedCommand(
          caller.principalId,
          'UPSERT_AGENT_RUNTIME_PROFILE',
          idempotencyKey,
          { ...normalizedBody },
          (tx) => {
            this.assertOperatorCaller(tx, caller);
            this.assertOwnedAgent(tx, caller, normalizedBody.agentPrincipalId);
          },
          (tx) => {
            const existing = tx
              .prepare('SELECT created_at FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?')
              .get(normalizedBody.agentPrincipalId) as { created_at: string } | undefined;
            const now = this.env.clock.next();
            const createdAt = existing?.created_at ?? now;
            let effectivePersonaRevision = normalizedBody.externalContextPersonaRevision ?? null;
            let effectivePersonaContentSha256 = normalizedBody.externalContextPersonaContentSha256 ?? null;
            if (normalizedBody.externalContextConfirmed
              && normalizedBody.providerAccountId !== 'ollama-local') {
              const persona = tx.prepare(`
                SELECT system_directives AS systemDirectives, revision
                  FROM collab_agent_personas WHERE agent_principal_id = ?
              `).get(normalizedBody.agentPrincipalId) as {
                systemDirectives: string;
                revision: number;
              } | undefined;
              const canonicalContent = persona?.systemDirectives ?? '';
              const derivedRevision = canonicalContent === '' ? 0 : persona!.revision;
              const derivedHash = createHash('sha256').update(canonicalContent, 'utf8').digest('hex');
              if (effectivePersonaRevision !== derivedRevision
                || effectivePersonaContentSha256 !== derivedHash) {
                throw new CollabError('INVALID_REQUEST', 'External consent persona binding is stale');
              }
              effectivePersonaRevision = derivedRevision;
              effectivePersonaContentSha256 = derivedHash;
            }

            tx.prepare(`
              INSERT INTO collab_agent_runtime_profiles(
                agent_principal_id, provider_account_id, adapter_id, model_id,
                autostart, external_context_confirmed,
                external_context_provider_account_id, external_context_model_id,
                external_context_runtime_fingerprint, external_context_exact_model_id,
                external_context_persona_revision, external_context_persona_content_sha256,
                created_at, updated_at
              ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(agent_principal_id) DO UPDATE SET
                provider_account_id=excluded.provider_account_id,
                adapter_id=excluded.adapter_id,
                model_id=excluded.model_id,
                autostart=excluded.autostart,
                external_context_confirmed=excluded.external_context_confirmed,
                external_context_provider_account_id=excluded.external_context_provider_account_id,
                external_context_model_id=excluded.external_context_model_id,
                external_context_runtime_fingerprint=excluded.external_context_runtime_fingerprint,
                external_context_exact_model_id=excluded.external_context_exact_model_id,
                external_context_persona_revision=excluded.external_context_persona_revision,
                external_context_persona_content_sha256=excluded.external_context_persona_content_sha256,
                updated_at=excluded.updated_at
            `).run(
              normalizedBody.agentPrincipalId,
              normalizedBody.providerAccountId,
              normalizedBody.adapterId,
              normalizedBody.modelId,
              normalizedBody.autostart ? 1 : 0,
              normalizedBody.externalContextConfirmed ? 1 : 0,
              normalizedBody.externalContextConfirmed ? normalizedBody.providerAccountId : null,
              normalizedBody.externalContextConfirmed ? normalizedBody.modelId : null,
              normalizedBody.externalContextConfirmed ? normalizedBody.externalContextRuntimeFingerprint : null,
              normalizedBody.externalContextConfirmed ? normalizedBody.externalContextExactModelId : null,
              normalizedBody.externalContextConfirmed ? effectivePersonaRevision : null,
              normalizedBody.externalContextConfirmed ? effectivePersonaContentSha256 : null,
              createdAt,
              now,
            );

            const result: AgentRuntimeProfile = {
              ...normalizedBody,
              externalContextRuntimeFingerprint: normalizedBody.externalContextRuntimeFingerprint ?? null,
              externalContextExactModelId: normalizedBody.externalContextExactModelId ?? null,
              externalContextPersonaRevision: effectivePersonaRevision,
              externalContextPersonaContentSha256: effectivePersonaContentSha256,
              createdAt,
              updatedAt: now,
            };
            return { result, redacted: result };
          },
        ),
      ),
    );
  }

  async upsertAgentPersona(
    caller: CallerContext,
    body: UpsertAgentPersonaInput,
    idempotencyKey: string,
    hasLiveDelegateAuthority: () => boolean,
  ): Promise<AgentPersona> {
    const agentPrincipalId = this.normalizeRuntimeIdentifier(body.agentPrincipalId, 'agentPrincipalId');
    const iconId = this.normalizeAgentIcon(body.iconId);
    const systemDirectives = this.normalizeSystemDirectives(body.systemDirectives);
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw new CollabError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer');
    }
    const expectedRevision = body.expectedRevision;
    const reconfirmExternalContext = body.reconfirmExternalContext === true;
    const externalContextRuntimeFingerprint = body.externalContextRuntimeFingerprint ?? null;
    const externalContextExactModelId = body.externalContextExactModelId ?? null;
    if (reconfirmExternalContext
      && (!/^[a-f0-9]{64}$/.test(externalContextRuntimeFingerprint ?? '')
        || !externalContextExactModelId)) {
      throw new CollabError('INVALID_REQUEST', 'External subscription reconfirmation binding is incomplete');
    }
    if (!reconfirmExternalContext
      && (externalContextRuntimeFingerprint !== null || externalContextExactModelId !== null)) {
      throw new CollabError('INVALID_REQUEST', 'Disabled external reconfirmation cannot retain a binding');
    }
    const normalizedBody = {
      agentPrincipalId,
      iconId,
      systemDirectives,
      expectedRevision,
      reconfirmExternalContext,
      externalContextRuntimeFingerprint,
      externalContextExactModelId,
    };

    return this.withReadThenSequencer(() =>
      this.mutex.withLock(() =>
        this.runKeyedCommand(
          caller.principalId,
          'UPSERT_AGENT_PERSONA',
          idempotencyKey,
          normalizedBody,
          (tx) => {
            this.assertOperatorCaller(tx, caller);
            if (!hasLiveDelegateAuthority()) {
              throw new CollabError('COLLAB_NOT_PERMITTED', 'Live delegate authority is required to edit agents');
            }
            this.assertOwnedAgent(tx, caller, agentPrincipalId);
          },
          (tx) => {
            const existing = tx.prepare(
              `SELECT created_at, revision, system_directives
                 FROM collab_agent_personas WHERE agent_principal_id = ?`,
            ).get(agentPrincipalId) as {
              created_at: string;
              revision: number;
              system_directives: string;
            } | undefined;
            const now = this.env.clock.next();
            const createdAt = existing?.created_at ?? now;
            let revision: number;
            if (!existing) {
              if (expectedRevision !== 0) {
                throw new CollabError('PERSONA_REVISION_CONFLICT', 'Agent profile changed; reload it before saving');
              }
              tx.prepare(`
                INSERT INTO collab_agent_personas(
                  agent_principal_id, icon_id, system_directives, revision, created_at, updated_at
                ) VALUES(?,?,?,?,?,?)
              `).run(agentPrincipalId, iconId, systemDirectives, 1, createdAt, now);
              revision = 1;
            } else {
              if (expectedRevision !== existing.revision) {
                throw new CollabError('PERSONA_REVISION_CONFLICT', 'Agent profile changed; reload it before saving');
              }
              const update = tx.prepare(`
                UPDATE collab_agent_personas
                   SET icon_id = ?, system_directives = ?, revision = revision + 1, updated_at = ?
                 WHERE agent_principal_id = ? AND revision = ?
              `).run(iconId, systemDirectives, now, agentPrincipalId, expectedRevision) as { changes: number };
              if (update.changes !== 1) {
                throw new CollabError('PERSONA_REVISION_CONFLICT', 'Agent profile changed; reload it before saving');
              }
              revision = expectedRevision + 1;
            }
            // Every persona mutation advances the claimed snapshot identity.
            // Revoke the old external binding even for icon-only edits, then
            // optionally install one new binding from the just-written
            // canonical persona in this same keyed transaction.
            tx.prepare(`
              UPDATE collab_agent_runtime_profiles
                 SET autostart = 0,
                     external_context_confirmed = 0,
                     external_context_provider_account_id = NULL,
                     external_context_model_id = NULL,
                     external_context_runtime_fingerprint = NULL,
                     external_context_exact_model_id = NULL,
                     external_context_persona_revision = NULL,
                     external_context_persona_content_sha256 = NULL,
                     updated_at = ?
               WHERE agent_principal_id = ? AND provider_account_id <> 'ollama-local'
            `).run(now, agentPrincipalId);
            if (reconfirmExternalContext) {
              const profile = tx.prepare(`
                SELECT provider_account_id AS providerAccountId, model_id AS modelId
                  FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?
              `).get(agentPrincipalId) as { providerAccountId: string; modelId: string } | undefined;
              if (!profile || profile.providerAccountId === 'ollama-local'
                || externalContextExactModelId !== profile.modelId) {
                throw new CollabError('INVALID_REQUEST', 'External subscription reconfirmation target changed');
              }
              const personaRevision = systemDirectives === '' ? 0 : revision;
              const personaContentSha256 = createHash('sha256').update(systemDirectives, 'utf8').digest('hex');
              tx.prepare(`
                UPDATE collab_agent_runtime_profiles
                   SET autostart = 1,
                       external_context_confirmed = 1,
                       external_context_provider_account_id = provider_account_id,
                       external_context_model_id = model_id,
                       external_context_runtime_fingerprint = ?,
                       external_context_exact_model_id = ?,
                       external_context_persona_revision = ?,
                       external_context_persona_content_sha256 = ?,
                       updated_at = ?
                 WHERE agent_principal_id = ? AND provider_account_id <> 'ollama-local'
              `).run(
                externalContextRuntimeFingerprint,
                externalContextExactModelId,
                personaRevision,
                personaContentSha256,
                now,
                agentPrincipalId,
              );
            }
            const result: AgentPersona = {
              agentPrincipalId,
              iconId,
              systemDirectives,
              revision,
              createdAt,
              updatedAt: now,
            };
            return { result, redacted: result };
          },
        ),
      ),
    );
  }

  async createPrincipalCredential(
    caller: CallerContext,
    body: { principalId: string },
    idempotencyKey: string
  ): Promise<CredentialProducingResult> {
    return this.withReadThenSequencer(() =>
      this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'CREATE_PRINCIPAL_CREDENTIAL',
        idempotencyKey,
        body,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
        const target = this.getPrincipalOrThrow(tx, body.principalId);
        if (target.status !== 'active') {
          throw new CollabError('INVALID_PRINCIPAL_STATE', `Principal ${target.id} is not active`);
        }

        const now = this.env.clock.next();
        const cred = this.issueCredentialRow(tx, target.id, now);
        this.insertAudit(tx, 'credential_created', caller.principalId, target.id, {
          principalId: target.id,
          credentialId: cred.credentialId,
        });

        const result: CredentialProducingResult = {
          principalId: target.id,
          credentialId: cred.credentialId,
          credential: cred.token,
          credentialAvailable: true,
        };
        const redacted: CredentialProducingResult = {
          principalId: target.id,
          credentialId: cred.credentialId,
          credentialAvailable: false,
        };
        return { result, redacted, secretBytes: cred.secretBytes };
      })
      )
    );
  }

  async suspendAgent(
    caller: CallerContext,
    body: { principalId: string },
    idempotencyKey: string
  ): Promise<AgentLifecycleResult> {
    let effective = false;
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'SUSPEND_AGENT',
            idempotencyKey,
            body,
            (tx) => this.assertOperatorCaller(tx, caller),
            (tx) => {
              const target = this.getAgentTargetOrThrow(tx, body.principalId);

              if (target.status === 'suspended') {
                // (H3) same-state fresh-key rule: no epoch increment, no session
                // closure, no audit row — just a fresh success result recording
                // current state.
                const sameState: AgentLifecycleResult = {
                  principalId: target.id,
                  status: 'suspended',
                  authEpoch: target.auth_epoch,
                };
                return { result: sameState, redacted: sameState };
              }
              if (target.status !== 'active') {
                throw new CollabError(
                  'INVALID_PRINCIPAL_TRANSITION',
                  `Cannot suspend principal in state ${target.status}`
                );
              }

              const now = this.env.clock.next();
              const newEpoch = target.auth_epoch + 1;
              tx
                .prepare('UPDATE principals SET status = ?, auth_epoch = ?, updated_at = ? WHERE id = ?')
                .run('suspended', newEpoch, now, target.id);

              // Section 5.2: suspend closes all sessions/subscriptions with
              // principal_suspended.
              this.closeSessionsForPrincipal(tx, target.id, 'principal_suspended', now);

              this.insertAudit(tx, 'agent_suspended', caller.principalId, target.id, {
                principalId: target.id,
                authEpoch: newEpoch,
              });

              effective = true;
              const result: AgentLifecycleResult = {
                principalId: target.id,
                status: 'suspended',
                authEpoch: newEpoch,
              };
              return { result, redacted: result };
            }
          )
        ),
      (r) =>
        effective
          ? affectedByPrincipal(this.registry, r.principalId, 'authorization_lost')
          : { subscriptions: [] }
    );
    return result;
  }

  async restoreAgent(
    caller: CallerContext,
    body: { principalId: string },
    idempotencyKey: string
  ): Promise<AgentLifecycleResult> {
    // (H2) RESTORE_AGENT stays write-lock class: it mutates auth_epoch,
    // which per-write revalidation reads, even though in legal flows it
    // closes zero existing subscriptions (suspension already closed them).
    // No demotion to read lock.
    let effective = false;
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'RESTORE_AGENT',
            idempotencyKey,
            body,
            (tx) => this.assertOperatorCaller(tx, caller),
            (tx) => {
              const target = this.getAgentTargetOrThrow(tx, body.principalId);

              if (target.status === 'active') {
                // (H3) same-state fresh-key rule.
                const sameState: AgentLifecycleResult = {
                  principalId: target.id,
                  status: 'active',
                  authEpoch: target.auth_epoch,
                };
                return { result: sameState, redacted: sameState };
              }
              if (target.status !== 'suspended') {
                throw new CollabError(
                  'INVALID_PRINCIPAL_TRANSITION',
                  `Cannot restore principal in state ${target.status}`
                );
              }

              const now = this.env.clock.next();
              const newEpoch = target.auth_epoch + 1;
              tx
                .prepare('UPDATE principals SET status = ?, auth_epoch = ?, updated_at = ? WHERE id = ?')
                .run('active', newEpoch, now, target.id);

              // Section 5.2: an effective restore closes any session bound to
              // the principal (defensive totality — legal flows produce zero
              // such sessions because suspension already closed them and a
              // suspended principal fails BASE) with reason principal_restored.
              this.closeSessionsForPrincipal(tx, target.id, 'principal_restored', now);

              this.insertAudit(tx, 'agent_restored', caller.principalId, target.id, {
                principalId: target.id,
                authEpoch: newEpoch,
              });

              effective = true;
              const result: AgentLifecycleResult = { principalId: target.id, status: 'active', authEpoch: newEpoch };
              return { result, redacted: result };
            }
          )
        ),
      (r) =>
        // Legal flows close zero subscriptions on restore (defensive
        // totality only — see docstring above), so this always resolves to
        // an empty affected set today, but the write lock still serializes
        // this epoch change against any concurrent per-write revalidation.
        effective ? affectedByPrincipal(this.registry, r.principalId, 'authorization_lost') : { subscriptions: [] }
    );
    return result;
  }

  async revokeAgent(
    caller: CallerContext,
    body: { principalId: string },
    idempotencyKey: string
  ): Promise<RevokeAgentResult> {
    let effective = false;
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'REVOKE_AGENT',
            idempotencyKey,
            body,
            (tx) => this.assertOperatorCaller(tx, caller),
            (tx) => {
              const target = this.getAgentTargetOrThrow(tx, body.principalId);

              if (target.status === 'revoked') {
                // (H3) same-state fresh-key rule, extended to REVOKE per G1R H3:
                // no epoch increment, no session closure, no audit row;
                // revokedCredentialCount pinned to 0 on the repeat.
                const result: RevokeAgentResult = {
                  principalId: target.id,
                  status: 'revoked',
                  authEpoch: target.auth_epoch,
                  revokedCredentialCount: 0,
                };
                return { result, redacted: result };
              }

              const now = this.env.clock.next();
              const newEpoch = target.auth_epoch + 1;
              tx
                .prepare(
                  'UPDATE principals SET status = ?, auth_epoch = ?, revoked_at = ?, updated_at = ? WHERE id = ?'
                )
                .run('revoked', newEpoch, now, now, target.id);

              // Revoke also revokes every agent credential (terminal revoke
              // differs from single-credential revoke).
              const activeCreds = tx
                .prepare('SELECT id FROM principal_credentials WHERE principal_id = ? AND state = ?')
                .all(target.id, 'active') as Array<{ id: string }>;
              for (const c of activeCreds) {
                tx
                  .prepare('UPDATE principal_credentials SET state = ?, revoked_at = ? WHERE id = ?')
                  .run('revoked', now, c.id);
              }

              this.closeSessionsForPrincipal(tx, target.id, 'principal_revoked', now);

              // ZOMBIE-SCHEDULE LIFECYCLE (revoke must reach cron).
              //
              // Revoking an agent bumped auth_epoch, revoked credentials and
              // closed sessions -- and touched NO schedule row. The FK on
              // collab_agent_schedules.agent_principal_id has no ON DELETE,
              // and this is an UPDATE anyway, so the FK is inert; there is no
              // reaper and no sweep, and setScheduleState (cron.ts) is
              // operator-manual only.
              //
              // The AUTHORITY check was never the gap: assertScheduleStillAuthorized
              // re-reads principals.status live at every wake and correctly
              // refuses (`principal-inactive`). But refusing is not stopping --
              // the schedule stayed state='active', so findDueSchedules kept
              // returning it, claimScheduleFire kept advancing next_fire_at,
              // and every interval burned a claim + a run row that could only
              // ever resolve 'terminated'. Forever. That is the same
              // "correct refusal, absent lifecycle" residual G1R B-C2 found for
              // archived channels, on the entity whose mistakes re-fire unattended.
              //
              // Scoped to agent_principal_id ONLY -- deliberately NOT
              // created_by_principal_id. A schedule's authority derives from the
              // AGENT's live membership and status (that is exactly what
              // assertScheduleStillAuthorized reads), never from whoever created
              // it, so a revoked creator's schedules legitimately continue.
              // Additionally the creator here can only be the operator, and the
              // schema permits exactly one (principals_single_operator), which
              // getAgentTargetOrThrow refuses to revoke.
              //
              // Reuses the EXISTING 'stopped' state and the same
              // (state, updated_at) column pair setScheduleState writes -- no new
              // state, no new column, so every existing reader (findDueSchedules'
              // state='active' predicate, claimScheduleFire's WHERE, the operator
              // listing) already interprets it correctly.
              //
              // The sqlite_master probe covers a collab DB opened before
              // AGENT_CRON_MIGRATION_ID was applied (migration.ts runs the cron
              // migration as a separate, later step, and CollaborationStore is
              // constructible against a DB that has only run
              // runCollaborationMigration). An existence check rather than a
              // swallowed try/catch, so a real SQL fault still fails the
              // transaction instead of silently leaving zombies behind.
              let stoppedScheduleCount = 0;
              const cronTable = tx
                .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'collab_agent_schedules'")
                .get();
              if (cronTable) {
                const info = tx
                  .prepare(
                    "UPDATE collab_agent_schedules SET state = 'stopped', updated_at = ? WHERE agent_principal_id = ? AND state = 'active'"
                  )
                  .run(now, target.id) as { changes: number | bigint };
                stoppedScheduleCount = Number(info.changes);
              }

              // Same audit row, one more field -- NOT a new audit kind.
              // collab_audit.kind is a closed CHECK enum (migration.ts), so a new
              // kind would need a migration; and the effect belongs to this
              // revoke, exactly as revokedCredentialCount does.
              this.insertAudit(tx, 'agent_revoked', caller.principalId, target.id, {
                principalId: target.id,
                authEpoch: newEpoch,
                revokedCredentialCount: activeCreds.length,
                stoppedScheduleCount,
              });

              effective = true;
              const result: RevokeAgentResult = {
                principalId: target.id,
                status: 'revoked',
                authEpoch: newEpoch,
                revokedCredentialCount: activeCreds.length,
              };
              return { result, redacted: result };
            }
          )
        ),
      (r) =>
        effective ? affectedByPrincipal(this.registry, r.principalId, 'authorization_lost') : { subscriptions: [] }
    );
    return result;
  }

  async rotatePrincipalCredential(
    caller: CallerContext,
    body: { principalId: string; replaceCredentialId: string },
    idempotencyKey: string
  ): Promise<RotateCredentialResult> {
    let closedSessionIds: string[] = [];
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'ROTATE_PRINCIPAL_CREDENTIAL',
            idempotencyKey,
            body,
            (tx) => this.assertOperatorCaller(tx, caller),
            (tx) => {
              const target = this.getPrincipalOrThrow(tx, body.principalId);

              const replaced = tx
                .prepare('SELECT * FROM principal_credentials WHERE id = ?')
                .get(body.replaceCredentialId) as CredentialRow | undefined;
              if (!replaced || replaced.principal_id !== target.id || replaced.state !== 'active') {
                throw new CollabError(
                  'CREDENTIAL_NOT_FOUND',
                  `Credential ${body.replaceCredentialId} is unknown, not active, or not owned by ${target.id}`
                );
              }

              // (L2) LAST_OPERATOR_CREDENTIAL guard for ROTATE when
              // replaceCredentialId is the operator's only active credential —
              // counted INSIDE the transaction after BEGIN IMMEDIATE.
              if (target.kind === 'operator') {
                const activeCount = this.countActiveCredentials(tx, target.id);
                if (activeCount <= 1) {
                  throw new CollabError(
                    'LAST_OPERATOR_CREDENTIAL',
                    "Cannot rotate the operator's only active credential without mutation"
                  );
                }
              }

              const now = this.env.clock.next();
              const cred = this.issueCredentialRow(tx, target.id, now);

              tx
                .prepare('UPDATE principal_credentials SET state = ?, revoked_at = ? WHERE id = ?')
                .run('revoked', now, replaced.id);

              closedSessionIds = this.closeSessionsForCredential(tx, replaced.id, 'credential_revoked', now);

              this.insertAudit(tx, 'credential_created', caller.principalId, target.id, {
                principalId: target.id,
                credentialId: cred.credentialId,
              });
              this.insertAudit(tx, 'credential_revoked', caller.principalId, target.id, {
                principalId: target.id,
                credentialId: replaced.id,
              });

              const result: RotateCredentialResult = {
                principalId: target.id,
                credentialId: cred.credentialId,
                credential: cred.token,
                credentialAvailable: true,
                replacedCredentialId: replaced.id,
              };
              const redacted: RotateCredentialResult = {
                principalId: target.id,
                credentialId: cred.credentialId,
                credentialAvailable: false,
                replacedCredentialId: replaced.id,
              };
              return { result, redacted, secretBytes: cred.secretBytes };
            }
          )
        ),
      () => {
        const subs: AffectedSet['subscriptions'] = [];
        for (const sid of closedSessionIds) {
          subs.push(...affectedBySession(this.registry, sid, 'authorization_lost').subscriptions);
        }
        return { subscriptions: subs };
      }
    );
    return result;
  }

  async revokePrincipalCredential(
    caller: CallerContext,
    body: { credentialId: string },
    idempotencyKey: string
  ): Promise<RevokeCredentialResult> {
    let closedSessionIds: string[] = [];
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'REVOKE_PRINCIPAL_CREDENTIAL',
            idempotencyKey,
            body,
            (tx) => this.assertOperatorCaller(tx, caller),
            (tx) => {
              const cred = tx.prepare('SELECT * FROM principal_credentials WHERE id = ?').get(body.credentialId) as
                | CredentialRow
                | undefined;
              if (!cred) {
                throw new CollabError('CREDENTIAL_NOT_FOUND', `Credential ${body.credentialId} not found`);
              }

              const owner = this.getPrincipalOrThrow(tx, cred.principal_id);

              if (cred.state === 'revoked') {
                // "returns the original revocation result for an already-revoked
                // one" — a fresh success result reflecting current state, no
                // further mutation.
                const result: RevokeCredentialResult = {
                  credentialId: cred.id,
                  revokedAt: cred.revoked_at ?? this.env.clock.next(),
                };
                return { result, redacted: result };
              }

              // (L2) LAST_OPERATOR_CREDENTIAL guard for REVOKE, counted inside
              // the transaction after BEGIN IMMEDIATE.
              if (owner.kind === 'operator') {
                const activeCount = this.countActiveCredentials(tx, owner.id);
                if (activeCount <= 1) {
                  throw new CollabError(
                    'LAST_OPERATOR_CREDENTIAL',
                    "Cannot revoke the operator's final active credential without mutation"
                  );
                }
              }

              const now = this.env.clock.next();
              tx.prepare('UPDATE principal_credentials SET state = ?, revoked_at = ? WHERE id = ?').run(
                'revoked',
                now,
                cred.id
              );

              closedSessionIds = this.closeSessionsForCredential(tx, cred.id, 'credential_revoked', now);

              this.insertAudit(tx, 'credential_revoked', caller.principalId, owner.id, {
                principalId: owner.id,
                credentialId: cred.id,
              });

              const result: RevokeCredentialResult = { credentialId: cred.id, revokedAt: now };
              return { result, redacted: result };
            }
          )
        ),
      () => {
        const subs: AffectedSet['subscriptions'] = [];
        for (const sid of closedSessionIds) {
          subs.push(...affectedBySession(this.registry, sid, 'authorization_lost').subscriptions);
        }
        return { subscriptions: subs };
      }
    );
    return result;
  }

  // -------------------------------------------------------------------
  // Channel commands (Slice 2 / Section 4.2, 5.3, 5.4, 7.4)
  //
  // (C1) Lock-class split:
  //  - keyed mutations (this.runKeyedCommand, via this.mutex): CREATE_CHANNEL,
  //    ADD_CHANNEL_MEMBER, REMOVE_CHANNEL_MEMBER, ARCHIVE_CHANNEL,
  //    UNARCHIVE_CHANNEL, POST_CHANNEL_MESSAGE.
  //  - naturally-idempotent (this.runNaturallyIdempotentCommand, via
  //    this.mutex, BEGIN IMMEDIATE, but NEVER touches
  //    collab_mutation_results): ACK_CHANNEL_CURSOR.
  //  - read-path (this.runReadCommand, no mutex, no BEGIN IMMEDIATE, no
  //    result row): LIST_CHANNELS, GET_CHANNEL_TIMELINE.
  //
  // (C2) Every channel-scoped predicate — channel resolution, membership
  // lookup, and owner check — runs INSIDE the transaction/read-snapshot in
  // the step-2 predicate slot, and throws COLLAB_NOT_FOUND (byte-identical
  // message) for every denial cause. There is NO channel resolution before
  // BEGIN IMMEDIATE (or before the read snapshot starts) anywhere below.
  // -------------------------------------------------------------------

  async createChannel(
    caller: CallerContext,
    body: { name: string },
    idempotencyKey: string
  ): Promise<CreateChannelResult> {
    // (L1) Normalize BEFORE hashing and persisting — mirrors createAgent's
    // F2 discipline. NFC + trim via normalizeName.
    const normalized = normalizeName(body.name);
    if ('error' in normalized) {
      throw new CollabError('INVALID_REQUEST', normalized.message);
    }
    const normalizedBody = { name: normalized.name };

    return this.withReadThenSequencer(() =>
      this.mutex.withLock(() =>
      this.runKeyedCommand(
        caller.principalId,
        'CREATE_CHANNEL',
        idempotencyKey,
        normalizedBody,
        (tx) => this.assertOperatorCaller(tx, caller),
        (tx) => {
          const operator = this.getOperatorOrThrow(tx);
          const key = nameKey(normalizedBody.name);

          const channelId = this.env.uuids.next();
          const now = this.env.clock.next();

          try {
            tx
              .prepare(
                "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, external_export_policy, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
              )
              .run(channelId, normalizedBody.name, key, 'active', operator.id, 1, 'local_only', now, now);
          } catch (err) {
            throw this.mapChannelNameConflict(err);
          }

          // Validation 2: one active owner membership (rejoined_seq 0) +
          // channel_created event at channel_seq 1, same transaction.
          tx
            .prepare(
              'INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES(?,?,?,?,?,?,?,?)'
            )
            .run(channelId, operator.id, 'owner', 'active', 1, 0, now, null);

          const eventId = this.env.uuids.next();
          const eventNow = this.env.clock.next();
          tx
            .prepare(
              'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?,?,?,?,?,?,?,?)'
            )
            .run(
              eventId,
              1,
              channelId,
              1,
              operator.id,
              'channel_created',
              canonicalJson({ channelId, name: normalizedBody.name }),
              eventNow
            );

          const result: CreateChannelResult = {
            channelId,
            name: normalizedBody.name,
            externalExportPolicy: 'local_only',
          };
          return { result, redacted: result };
        }
      )
      )
    );
  }

  async setChannelExternalExportPolicy(
    caller: CallerContext,
    body: { channelId: string; externalExportPolicy: 'local_only' | 'operator_confirmed_non_sensitive' },
    idempotencyKey: string,
  ): Promise<SetChannelExternalExportPolicyResult> {
    const channelId = this.normalizeRuntimeIdentifier(body.channelId, 'channelId');
    if (!['local_only', 'operator_confirmed_non_sensitive'].includes(body.externalExportPolicy)) {
      throw new CollabError('INVALID_REQUEST', 'Invalid channel external export policy');
    }
    const normalizedBody = { channelId, externalExportPolicy: body.externalExportPolicy };
    return this.withReadThenSequencer(() => this.mutex.withLock(() => this.runKeyedCommand(
      caller.principalId,
      'SET_CHANNEL_EXTERNAL_EXPORT_POLICY',
      idempotencyKey,
      normalizedBody,
      (tx) => { this.assertChannelOwner(tx, caller, channelId); },
      (tx) => {
        const channel = this.assertChannelOwner(tx, caller, channelId);
        const now = this.env.clock.next();
        tx.prepare('UPDATE collab_channels SET external_export_policy = ?, updated_at = ? WHERE id = ?')
          .run(normalizedBody.externalExportPolicy, now, channelId);
        tx.prepare(`INSERT INTO collab_channel_export_policy_audit(
          id, channel_id, actor_principal_id, prior_policy, new_policy, idempotency_key, created_at
        ) VALUES(?,?,?,?,?,?,?)`).run(
          this.env.uuids.next(), channelId, caller.principalId,
          channel.external_export_policy, normalizedBody.externalExportPolicy,
          idempotencyKey, now,
        );
        const result: SetChannelExternalExportPolicyResult = {
          channelId,
          externalExportPolicy: normalizedBody.externalExportPolicy,
          updatedAt: now,
        };
        return { result, redacted: result };
      },
    )));
  }

  async addChannelMember(
    caller: CallerContext,
    body: { channelId: string; principalId: string },
    idempotencyKey: string
  ): Promise<ChannelMemberResult> {
    // (H2) ADD_CHANNEL_MEMBER stays write-lock class: it mutates the added
    // member's own membership_epoch, which per-write revalidation reads
    // (their OWN row — H1). No demotion to read lock even though a fresh
    // add closes nothing.
    let committed: { eventId: string; channelSeq: number; occurredAt: string } | undefined;
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'ADD_CHANNEL_MEMBER',
            idempotencyKey,
            body,
            // (C2) CHANNEL_OWNER predicate: resolved entirely inside the tx.
            (tx) => this.assertChannelOwner(tx, caller, body.channelId),
            (tx) => {
              const channel = this.getChannelOrThrow(tx, body.channelId);
              if (channel.state === 'archived') {
                throw new CollabError('CHANNEL_ARCHIVED', 'Channel is archived');
              }

              // Validation 3: target is kind agent, owned by the channel
              // operator, role agent; owner-role insert rejected (there is no
              // caller-supplied role — this command only ever inserts role
              // 'agent', so "owner-role insert rejected" is enforced by never
              // accepting a role parameter here).
              const target = tx.prepare('SELECT * FROM principals WHERE id = ?').get(body.principalId) as
                | PrincipalRow
                | undefined;
              if (!target || target.kind !== 'agent' || target.owner_principal_id !== channel.owner_principal_id) {
                throw notFound();
              }

              const existing = tx
                .prepare('SELECT * FROM collab_members WHERE channel_id = ? AND principal_id = ?')
                .get(channel.id, target.id) as MemberRow | undefined;

              if (existing && existing.role === 'owner') {
                // Owner membership cannot be re-added/mutated via this path.
                throw notFound();
              }

              if (existing && existing.state === 'active') {
                // Idempotent-at-storage same-state: Section 5.3 "same-state
                // repetition is idempotent" — return current epoch, no mutation.
                const result: ChannelMemberResult = {
                  channelId: channel.id,
                  principalId: target.id,
                  membershipEpoch: existing.membership_epoch,
                };
                return { result, redacted: result };
              }

              // (H1) rejoined_seq = MAX(channel_seq) for the channel, captured
              // BEFORE inserting the member_added event, same transaction.
              const rejoinedSeq = this.getMaxChannelSeq(tx, channel.id);
              const nextSeq = rejoinedSeq + 1;
              const now = this.env.clock.next();

              let newEpoch: number;
              if (existing) {
                // Re-add: existing removed row -> active again, own epoch bump.
                newEpoch = existing.membership_epoch + 1;
                tx
                  .prepare(
                    'UPDATE collab_members SET state = ?, membership_epoch = ?, rejoined_seq = ?, joined_at = ?, removed_at = ? WHERE channel_id = ? AND principal_id = ?'
                  )
                  .run('active', newEpoch, rejoinedSeq, now, null, channel.id, target.id);
              } else {
                newEpoch = 1;
                tx
                  .prepare(
                    'INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES(?,?,?,?,?,?,?,?)'
                  )
                  .run(channel.id, target.id, 'agent', 'active', newEpoch, rejoinedSeq, now, null);
              }

              const eventId = this.env.uuids.next();
              const eventNow = this.env.clock.next();
              tx
                .prepare(
                  'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?,?,?,?,?,?,?,?)'
                )
                .run(
                  eventId,
                  1,
                  channel.id,
                  nextSeq,
                  caller.principalId,
                  'member_added',
                  canonicalJson({ channelId: channel.id, principalId: target.id, membershipEpoch: newEpoch }),
                  eventNow
                );

              committed = { eventId, channelSeq: nextSeq, occurredAt: eventNow };
              const result: ChannelMemberResult = {
                channelId: channel.id,
                principalId: target.id,
                membershipEpoch: newEpoch,
              };
              return { result, redacted: result };
            }
          )
        ),
      // ADD never closes an existing subscription in legal flows (the added
      // principal has no pre-existing live subscription on this channel by
      // definition — it just became a member). Empty affected set; the
      // write lock still serializes this epoch change against concurrent
      // per-write revalidation for any OTHER subscription this principal
      // might hold elsewhere (H2).
      () => ({ subscriptions: [] })
    );

    // Fan out member_added to every OTHER already-live subscription on this
    // channel (Section 10: "adding member B while member A holds a live
    // subscription... delivers B's member_added event to A in sequence").
    // Runs AFTER the write lock releases — each candidate delivery
    // acquires its own per-write read lock (fanoutOne/C1).
    if (committed) {
      await fanoutToChannel(
        {
          lock: this.lock,
          registry: this.registry,
          db: this.env.db,
          observability: this.observability,
          nowMs: this.nowMs,
        },
        {
          channelId: result.channelId,
          channelSeq: committed.channelSeq,
          eventId: committed.eventId,
          kind: 'member_added',
          actorPrincipalId: caller.principalId,
          occurredAt: committed.occurredAt,
          payload: { channelId: result.channelId, principalId: result.principalId, membershipEpoch: result.membershipEpoch },
        }
      );
    }

    return result;
  }

  async removeChannelMember(
    caller: CallerContext,
    body: { channelId: string; principalId: string },
    idempotencyKey: string
  ): Promise<ChannelMemberResult> {
    let effective = false;
    let committed: { eventId: string; channelSeq: number; occurredAt: string } | undefined;
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'REMOVE_CHANNEL_MEMBER',
            idempotencyKey,
            body,
            (tx) => this.assertChannelOwner(tx, caller, body.channelId),
            (tx) => {
              const channel = this.getChannelOrThrow(tx, body.channelId);
              if (channel.state === 'archived') {
                throw new CollabError('CHANNEL_ARCHIVED', 'Channel is archived');
              }

              const existing = tx
                .prepare('SELECT * FROM collab_members WHERE channel_id = ? AND principal_id = ?')
                .get(channel.id, body.principalId) as MemberRow | undefined;

              if (!existing) {
                throw notFound();
              }

              // Validation 4: owner membership removal is rejected.
              if (existing.role === 'owner') {
                throw notFound();
              }

              if (existing.state === 'removed') {
                // Same-state repetition is idempotent.
                const result: ChannelMemberResult = {
                  channelId: channel.id,
                  principalId: existing.principal_id,
                  membershipEpoch: existing.membership_epoch,
                };
                return { result, redacted: result };
              }

              const nextSeq = this.getMaxChannelSeq(tx, channel.id) + 1;
              const now = this.env.clock.next();
              const newEpoch = existing.membership_epoch + 1;

              tx
                .prepare(
                  'UPDATE collab_members SET state = ?, membership_epoch = ?, removed_at = ? WHERE channel_id = ? AND principal_id = ?'
                )
                .run('removed', newEpoch, now, channel.id, existing.principal_id);

              const eventId = this.env.uuids.next();
              const eventNow = this.env.clock.next();
              tx
                .prepare(
                  'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?,?,?,?,?,?,?,?)'
                )
                .run(
                  eventId,
                  1,
                  channel.id,
                  nextSeq,
                  caller.principalId,
                  'member_removed',
                  canonicalJson({
                    channelId: channel.id,
                    principalId: existing.principal_id,
                    membershipEpoch: newEpoch,
                  }),
                  eventNow
                );

              committed = { eventId, channelSeq: nextSeq, occurredAt: eventNow };
              effective = true;
              const result: ChannelMemberResult = {
                channelId: channel.id,
                principalId: existing.principal_id,
                membershipEpoch: newEpoch,
              };
              return { result, redacted: result };
            }
          )
        ),
      (r) =>
        effective
          ? affectedByPrincipal(this.registry, r.principalId, 'authorization_lost', r.channelId)
          : { subscriptions: [] }
    );

    // Fan out member_removed to every remaining live subscription on this
    // channel (the removed principal's own subscription was already closed
    // above by the coordinator, before this point — fanoutOne's C4 closed
    // check will correctly skip it here as a no-op).
    if (committed) {
      await fanoutToChannel(
        {
          lock: this.lock,
          registry: this.registry,
          db: this.env.db,
          observability: this.observability,
          nowMs: this.nowMs,
        },
        {
          channelId: result.channelId,
          channelSeq: committed.channelSeq,
          eventId: committed.eventId,
          kind: 'member_removed',
          actorPrincipalId: caller.principalId,
          occurredAt: committed.occurredAt,
          payload: { channelId: result.channelId, principalId: result.principalId, membershipEpoch: result.membershipEpoch },
        }
      );
    }

    return result;
  }

  async archiveChannel(
    caller: CallerContext,
    body: { channelId: string },
    idempotencyKey: string
  ): Promise<ChannelArchiveResult> {
    let effective = false;
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'ARCHIVE_CHANNEL',
            idempotencyKey,
            body,
            (tx) => this.assertChannelOwner(tx, caller, body.channelId),
            (tx) => {
              const channel = this.getChannelOrThrow(tx, body.channelId);

              if (channel.state === 'archived') {
                // Same-state no-op: return current state, no epoch, no event.
                const result: ChannelArchiveResult = {
                  channelId: channel.id,
                  state: 'archived',
                  channelEpoch: channel.channel_epoch,
                };
                return { result, redacted: result };
              }

              const now = this.env.clock.next();
              const newEpoch = channel.channel_epoch + 1;
              tx
                .prepare('UPDATE collab_channels SET state = ?, channel_epoch = ?, updated_at = ? WHERE id = ?')
                .run('archived', newEpoch, now, channel.id);

              const nextSeq = this.getMaxChannelSeq(tx, channel.id) + 1;
              const eventId = this.env.uuids.next();
              const eventNow = this.env.clock.next();
              tx
                .prepare(
                  'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?,?,?,?,?,?,?,?)'
                )
                .run(
                  eventId,
                  1,
                  channel.id,
                  nextSeq,
                  caller.principalId,
                  'channel_archived',
                  canonicalJson({ channelId: channel.id, channelEpoch: newEpoch }),
                  eventNow
                );

              effective = true;
              const result: ChannelArchiveResult = {
                channelId: channel.id,
                state: 'archived',
                channelEpoch: newEpoch,
              };
              return { result, redacted: result };
            }
          )
        ),
      (r) => (effective ? affectedByChannel(this.registry, r.channelId, 'channel_archived') : { subscriptions: [] })
    );
    return result;
  }

  async unarchiveChannel(
    caller: CallerContext,
    body: { channelId: string },
    idempotencyKey: string
  ): Promise<ChannelArchiveResult> {
    let effective = false;
    const result = await runAuthorizationMutation(
      this.coordinatorDeps(),
      () =>
        this.mutex.withLock(() =>
          this.runKeyedCommand(
            caller.principalId,
            'UNARCHIVE_CHANNEL',
            idempotencyKey,
            body,
            (tx) => this.assertChannelOwner(tx, caller, body.channelId),
            (tx) => {
              const channel = this.getChannelOrThrow(tx, body.channelId);

              if (channel.state === 'active') {
                // Same-state no-op.
                const result: ChannelArchiveResult = {
                  channelId: channel.id,
                  state: 'active',
                  channelEpoch: channel.channel_epoch,
                };
                return { result, redacted: result };
              }

              // (M2) recompute name_key on unarchive; on active-name collision,
              // roll back leaving the target archived, CHANNEL_NAME_CONFLICT,
              // no epoch bump. The unique active-name_key index is the
              // concurrency backstop; catching its violation maps to
              // CHANNEL_NAME_CONFLICT and the whole transaction (including this
              // UPDATE) rolls back, so the channel is left exactly as it was
              // (archived, prior name_key, prior epoch).
              const key = nameKey(channel.name);
              const now = this.env.clock.next();
              const newEpoch = channel.channel_epoch + 1;

              try {
                tx
                  .prepare(
                    'UPDATE collab_channels SET state = ?, name_key = ?, channel_epoch = ?, updated_at = ? WHERE id = ?'
                  )
                  .run('active', key, newEpoch, now, channel.id);
              } catch (err) {
                throw this.mapChannelNameConflict(err);
              }

              const nextSeq = this.getMaxChannelSeq(tx, channel.id) + 1;
              const eventId = this.env.uuids.next();
              const eventNow = this.env.clock.next();
              tx
                .prepare(
                  'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?,?,?,?,?,?,?,?)'
                )
                .run(
                  eventId,
                  1,
                  channel.id,
                  nextSeq,
                  caller.principalId,
                  'channel_unarchived',
                  canonicalJson({ channelId: channel.id, channelEpoch: newEpoch }),
                  eventNow
                );

              effective = true;
              const result: ChannelArchiveResult = { channelId: channel.id, state: 'active', channelEpoch: newEpoch };
              return { result, redacted: result };
            }
          )
        ),
      (r) => (effective ? affectedByChannel(this.registry, r.channelId, 'channel_unarchived') : { subscriptions: [] })
    );
    return result;
  }

  async postChannelMessage(
    caller: CallerContext,
    body: { channelId: string; text: string },
    idempotencyKey: string
  ): Promise<PostChannelMessageResult> {
    // (L1) Normalize text BEFORE hashing/persisting.
    const normalized = normalizeMessageText(body.text);
    if ('error' in normalized) {
      throw new CollabError('INVALID_REQUEST', normalized.message);
    }
    const normalizedBody = { channelId: body.channelId, text: normalized.text };

    let committedSeq: number | undefined;

    const result = await this.withReadThenSequencer(() =>
      this.mutex.withLock(() =>
        this.runKeyedCommand(
          caller.principalId,
          'POST_CHANNEL_MESSAGE',
          idempotencyKey,
          normalizedBody,
          // (M3) CHANNEL_WRITABLE == CHANNEL_VISIBLE, state-free: the
          // predicate slot checks ONLY visibility/membership, never state. A
          // non-member (predicate fails) throws COLLAB_NOT_FOUND here and
          // NEVER reaches the state check below.
          (tx) => this.assertChannelVisible(tx, caller, normalizedBody.channelId),
          (tx) => {
            // (M3) Evaluation order: predicate already passed (caller is an
            // active/passing member) -> THEN the active-channel state check.
            // A member posting to an archived channel gets CHANNEL_ARCHIVED,
            // never COLLAB_NOT_FOUND.
            const channel = this.getChannelOrThrow(tx, normalizedBody.channelId);
            if (channel.state === 'archived') {
              throw new CollabError('CHANNEL_ARCHIVED', 'Channel is archived');
            }

            const nextSeq = this.getMaxChannelSeq(tx, channel.id) + 1;
            const eventId = this.env.uuids.next();
            const occurredAt = this.env.clock.next();
            tx
              .prepare(
                'INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at) VALUES(?,?,?,?,?,?,?,?)'
              )
              .run(
                eventId,
                1,
                channel.id,
                nextSeq,
                caller.principalId,
                'message_posted',
                canonicalJson({ channelId: channel.id, text: normalizedBody.text }),
                occurredAt
              );

            committedSeq = nextSeq;
            const result: PostChannelMessageResult = {
              eventId,
              cursor: String(nextSeq),
              occurredAt,
            };
            return { result, redacted: result };
          }
        )
      )
    );

    // Fan-out happens OUTSIDE the read-lock hold used for the sequencer/tx
    // above (that lock has already released by the time withReadThenSequencer
    // resolves) — each candidate subscription's delivery acquires its OWN
    // per-write read-lock hold via fanoutOne (Section 8.3: "the read lock is
    // acquired and released per socket write and is never held across more
    // than one write"). Only fires for a NEWLY committed message (not an
    // idempotent replay, where committedSeq stays undefined because fn()
    // never ran).
    if (committedSeq !== undefined) {
      await fanoutToChannel(
        { lock: this.lock, registry: this.registry, db: this.env.db, observability: this.observability, nowMs: this.nowMs },
        {
          channelId: normalizedBody.channelId,
          channelSeq: committedSeq,
          eventId: result.eventId,
          kind: 'message_posted',
          actorPrincipalId: caller.principalId,
          occurredAt: result.occurredAt,
          payload: { channelId: normalizedBody.channelId, text: normalizedBody.text },
        }
      );
    }

    return result;
  }

  async commitAgentTurnFallbackOutput(
    body: CommitAgentTurnFallbackInput,
  ): Promise<CommitAgentTurnFallbackResult> {
    return this.commitAgentTurnOutput({ ...body, outputKind: 'fallback' });
  }

  async commitAgentTurnToolOutput(
    body: CommitAgentTurnFallbackInput,
  ): Promise<CommitAgentTurnFallbackResult> {
    return this.commitAgentTurnOutput({ ...body, outputKind: 'tool' });
  }

  private async commitAgentTurnOutput(
    body: CommitAgentTurnOutputInput,
  ): Promise<CommitAgentTurnFallbackResult> {
    const agentPrincipalId = this.normalizeRuntimeIdentifier(body.agentPrincipalId, 'agentPrincipalId');
    const dispatchRequestId = this.normalizeRuntimeIdentifier(body.dispatchRequestId, 'dispatchRequestId');
    if (!Number.isSafeInteger(body.channelSeq) || body.channelSeq <= 0) {
      throw new CollabError('INVALID_REQUEST', 'channelSeq must be a positive safe integer');
    }
    if (!Number.isInteger(body.expectedProfile.personaRevision) || body.expectedProfile.personaRevision < 0) {
      throw new CollabError('INVALID_REQUEST', 'personaRevision must be a non-negative integer');
    }
    const expectedProfile: AgentTurnRuntimeSnapshot = {
      providerAccountId: this.normalizeRuntimeIdentifier(
        body.expectedProfile.providerAccountId,
        'providerAccountId',
      ),
      adapterId: this.normalizeRuntimeIdentifier(body.expectedProfile.adapterId, 'adapterId'),
      modelId: this.normalizeRuntimeIdentifier(body.expectedProfile.modelId, 'modelId'),
      personaRevision: body.expectedProfile.personaRevision,
      runtimeFingerprint: body.expectedProfile.runtimeFingerprint ?? null,
      exactModelId: body.expectedProfile.exactModelId ?? null,
      personaContentSha256: body.expectedProfile.personaContentSha256 ?? null,
    };
    const executionEnvelope = this.validatePersonaEnvelope(body.personaEnvelope);
    if (expectedProfile.personaRevision !== executionEnvelope.personaRevision) {
      throw new CollabError('INVALID_REQUEST', 'Execution profile and persona envelope revisions differ');
    }
    const normalized = normalizeMessageText(body.text);
    if ('error' in normalized) throw new CollabError('INVALID_REQUEST', normalized.message);
    const recoveryLeaseToken = body.recoveryLeaseToken?.trim() || null;
    let committed: CommittedChannelEvent | undefined;

    const result = await this.withReadThenSequencer(() =>
      this.mutex.withLock(() =>
        this.runNaturallyIdempotentCommand(agentPrincipalId, 'COMMIT_AGENT_TURN_FALLBACK', (tx) => {
          const turn = tx.prepare(`
            SELECT state, dispatch_request_id AS dispatchRequestId,
                   output_event_id AS outputEventId, output_kind AS outputKind,
                   recovery_lease_token AS recoveryLeaseToken,
                   persona_envelope_version AS personaVersion,
                   persona_content AS personaContent,
                   persona_revision AS personaRevision,
                   persona_content_sha256 AS personaContentSha256
              FROM collab_agent_turns
             WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?
          `).get(body.channelId, agentPrincipalId, body.channelSeq) as {
            state: string;
            dispatchRequestId: string | null;
            outputEventId: string | null;
            outputKind: 'tool' | 'fallback' | null;
            recoveryLeaseToken: string | null;
            personaVersion: number | null;
            personaContent: string | null;
            personaRevision: number | null;
            personaContentSha256: string | null;
          } | undefined;
          if (!turn || turn.dispatchRequestId !== dispatchRequestId) {
            throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent turn ownership could not be verified');
          }
          const leaseMatches = recoveryLeaseToken === null
            ? turn.recoveryLeaseToken === null
            : turn.recoveryLeaseToken === recoveryLeaseToken;
          if (!leaseMatches) {
            throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent turn recovery lease is not current');
          }
          const claimedEnvelope = this.validatePersonaEnvelope({
            version: turn.personaVersion,
            content: turn.personaContent,
            personaRevision: turn.personaRevision,
            contentSha256: turn.personaContentSha256,
          });
          if (!this.personaEnvelopesEqual(claimedEnvelope, executionEnvelope)) {
            throw new CollabError('COLLAB_NOT_PERMITTED', 'Execution persona does not match the claimed snapshot');
          }
          // Replay is intentionally resolved before live authorization is
          // re-read. Once an output event is atomically bound, an exact retry
          // returns that immutable event even if persona/runtime membership
          // changes later. Only a fresh write is subject to the live checks
          // below; moving this arm after them would make authorized retries
          // non-idempotent and strand already-committed output.
          if (turn.outputEventId) {
            const event = tx.prepare(`
              SELECT id AS eventId, channel_seq AS channelSeq, created_at AS occurredAt
                FROM collab_events WHERE id = ? AND channel_id = ?
            `).get(turn.outputEventId, body.channelId) as {
              eventId: string;
              channelSeq: number;
              occurredAt: string;
            } | undefined;
            if (!event || turn.outputKind === null) {
              throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent turn output is already bound');
            }
            return {
              eventId: event.eventId,
              cursor: String(event.channelSeq),
              occurredAt: event.occurredAt,
              outputKind: turn.outputKind,
              replayed: true,
            };
          }
          if (turn.state !== 'dispatched') {
            throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent turn is not dispatchable');
          }

          const live = tx.prepare(`
            SELECT p.kind, p.status AS principalStatus, c.state AS channelState,
                   m.state AS memberState,
                   r.provider_account_id AS providerAccountId,
                   r.adapter_id AS adapterId,
                   r.model_id AS modelId,
                   r.autostart,
                    COALESCE(persona.system_directives, '') AS personaContent,
                    COALESCE(persona.revision, 0) AS personaRevision,
                    r.external_context_confirmed AS externalContextConfirmed,
                    r.external_context_provider_account_id AS externalContextProviderAccountId,
                    r.external_context_model_id AS externalContextModelId,
                    r.external_context_runtime_fingerprint AS externalContextRuntimeFingerprint,
                    r.external_context_exact_model_id AS externalContextExactModelId,
                    r.external_context_persona_revision AS externalContextPersonaRevision,
                    r.external_context_persona_content_sha256 AS externalContextPersonaContentSha256
              FROM principals p
              JOIN collab_channels c ON c.id = ?
              JOIN collab_members m ON m.channel_id = c.id AND m.principal_id = p.id
              JOIN collab_agent_runtime_profiles r ON r.agent_principal_id = p.id
              LEFT JOIN collab_agent_personas persona ON persona.agent_principal_id = p.id
             WHERE p.id = ?
          `).get(body.channelId, agentPrincipalId) as {
            kind: string;
            principalStatus: string;
            channelState: string;
            memberState: string;
            providerAccountId: string;
            adapterId: string;
            modelId: string;
            autostart: number;
            personaRevision: number;
            personaContent: string;
            externalContextConfirmed: number;
            externalContextProviderAccountId: string | null;
            externalContextModelId: string | null;
            externalContextRuntimeFingerprint: string | null;
            externalContextExactModelId: string | null;
            externalContextPersonaRevision: number | null;
            externalContextPersonaContentSha256: string | null;
          } | undefined;
          const liveEnvelope = live
            ? this.mintPersonaEnvelope(live.personaContent, live.personaRevision)
            : null;
          const externalBindingValid = expectedProfile.providerAccountId === 'ollama-local'
            || (live?.externalContextConfirmed === 1
              && live.externalContextProviderAccountId === expectedProfile.providerAccountId
              && live.externalContextModelId === expectedProfile.modelId
              && live.externalContextRuntimeFingerprint === expectedProfile.runtimeFingerprint
              && live.externalContextExactModelId === expectedProfile.exactModelId
              && live.externalContextPersonaRevision === expectedProfile.personaRevision
              && live.externalContextPersonaContentSha256 === expectedProfile.personaContentSha256);
          const stopped = tx.prepare(`
            SELECT 1 FROM collab_autoreply_stop
             WHERE scope = 'global' OR (scope = 'channel' AND channel_id = ?)
             LIMIT 1
          `).get(body.channelId) !== undefined;
          const authorized = live?.kind === 'agent'
            && live.principalStatus === 'active'
            && live.channelState === 'active'
            && live.memberState === 'active'
            && live.autostart === 1
            && live.providerAccountId === expectedProfile.providerAccountId
            && live.adapterId === expectedProfile.adapterId
            && live.modelId === expectedProfile.modelId
            && liveEnvelope !== null
            && this.personaEnvelopesEqual(liveEnvelope, claimedEnvelope)
            && externalBindingValid
            && !stopped;
          if (!authorized) {
            throw new CollabError('COLLAB_NOT_PERMITTED', 'Live agent turn authorization changed');
          }

          const nextSeq = this.getMaxChannelSeq(tx, body.channelId) + 1;
          const eventId = this.env.uuids.next();
          const occurredAt = this.env.clock.next();
          tx.prepare(`
            INSERT INTO collab_events(
              id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at
            ) VALUES(?, 1, ?, ?, ?, 'message_posted', ?, ?)
          `).run(
            eventId,
            body.channelId,
            nextSeq,
            agentPrincipalId,
            canonicalJson({ channelId: body.channelId, text: normalized.text }),
            occurredAt,
          );
          const bound = tx.prepare(`
            UPDATE collab_agent_turns
               SET output_event_id = ?, output_kind = ?, state = 'completed',
                   resolved_at = ?
             WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?
               AND state = 'dispatched' AND output_event_id IS NULL
               AND dispatch_request_id = ?
               AND recovery_lease_token IS ?
          `).run(
            eventId,
            body.outputKind,
            occurredAt,
            body.channelId,
            agentPrincipalId,
            body.channelSeq,
            dispatchRequestId,
            recoveryLeaseToken,
          ) as { changes: number | bigint };
          if (Number(bound.changes) !== 1) {
            throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent turn output ownership changed');
          }
          committed = {
            channelId: body.channelId,
            channelSeq: nextSeq,
            eventId,
            kind: 'message_posted',
            actorPrincipalId: agentPrincipalId,
            occurredAt,
            payload: { channelId: body.channelId, text: normalized.text },
          };
          return {
            eventId,
            cursor: String(nextSeq),
            occurredAt,
            outputKind: body.outputKind,
            replayed: false,
          };
        }),
      ),
    );

    if (committed) {
      await fanoutToChannel(
        {
          lock: this.lock,
          registry: this.registry,
          db: this.env.db,
          observability: this.observability,
          nowMs: this.nowMs,
        },
        committed,
      );
    }
    return result;
  }

  /**
   * ACK_CHANNEL_CURSOR: naturally-idempotent path (C1). Takes the sequencer
   * mutex and BEGIN IMMEDIATE, runs its predicate in-transaction, but NEVER
   * reads or writes collab_mutation_results — cursor upsert with
   * max(existing,submitted) computed in SQL (L2) is itself the idempotent
   * operation; no separate mutation-result envelope is needed or permitted.
   */
  async ackChannelCursor(
    caller: CallerContext,
    body: { channelId: string; cursor: string }
  ): Promise<AckChannelCursorResult> {
    return this.withReadThenSequencer(() =>
      this.mutex.withLock(() =>
        this.runNaturallyIdempotentCommand(caller.principalId, 'ACK_CHANNEL_CURSOR', (tx) => {
          // (C2) CURSOR_OWNER == CHANNEL_VISIBLE, resolved inside the tx.
          const member = this.assertChannelVisible(tx, caller, body.channelId);
          const channel = this.getChannelOrThrow(tx, body.channelId);

          const submitted = this.parseCursor(body.cursor);

          // (H3 / two-branch bound) caller-visible bound: greatest committed
          // channel_seq when events above rejoined_seq exist, otherwise
          // rejoined_seq.
          const bound = this.callerVisibleBound(tx, channel.id, member.rejoined_seq);
          if (submitted > bound) {
            throw new CollabError('CURSOR_OUT_OF_RANGE', `Cursor ${submitted} exceeds caller-visible bound ${bound}`);
          }

          // (L2) upsert-from-zero, max(existing,submitted) computed in SQL.
          const now = this.env.clock.next();
          tx
            .prepare(
              `INSERT INTO collab_cursors(channel_id, principal_id, acknowledged_seq, updated_at)
             VALUES(?,?,?,?)
             ON CONFLICT(channel_id, principal_id) DO UPDATE SET
               acknowledged_seq = MAX(acknowledged_seq, excluded.acknowledged_seq),
               updated_at = excluded.updated_at`
            )
            .run(channel.id, caller.principalId, submitted, now);

          const row = tx
            .prepare('SELECT acknowledged_seq FROM collab_cursors WHERE channel_id = ? AND principal_id = ?')
            .get(channel.id, caller.principalId) as { acknowledged_seq: number };

          return { channelId: channel.id, acknowledgedCursor: String(row.acknowledged_seq) };
        })
      )
    );
  }

  /**
   * SUBSCRIBE_CHANNEL: naturally-idempotent-class path (read lock then
   * sequencer mutex — Section 8.3 L1). (C3) Registry insertion +
   * `buffering` flag + high-water capture happen as ONE atomic step, inside
   * the sequencer-mutex-guarded transaction, via `this.registry.register`
   * — so any commit that happens after this call (even the very next
   * microtask) sees this subscription already registered and buffers or
   * (for backlog-covered seqs) is simply covered by the backlog read that
   * follows, outside the lock. After registering, backlog is read (outside
   * the locks, per Section 8.3: "Backlog sends authorized events through
   * high water ascending" as a step distinct from the mutex-held
   * registration), delivered ascending, then the subscription transitions
   * to live UNDER THE MUTEX, draining any events that committed and
   * buffered during the backlog read.
   */
  async subscribeChannel(
    caller: CallerContext,
    body: { channelId: string; afterCursor: string; sessionId: string; credentialId: string; sink: import('./subscriptions.js').DeliverySink },
    subscriptionId: string
  ): Promise<SubscribeChannelResult> {
    let registered: Subscription | undefined;
    let effectiveAfter = 0;

    await this.withReadThenSequencer(() =>
      this.mutex.withLock(() => {
        // (C2) CHANNEL_VISIBLE predicate + epoch snapshot capture, inside
        // the mutex-guarded critical section.
        const member = this.assertChannelVisible(this.env.db, caller, body.channelId);
        const channel = this.getChannelOrThrow(this.env.db, body.channelId);
        const principal = this.getPrincipalOrThrow(this.env.db, caller.principalId);

        const requested = this.parseCursor(body.afterCursor);
        effectiveAfter = Math.max(requested, member.rejoined_seq);

        const highWaterCursor = this.getMaxChannelSeq(this.env.db, channel.id);

        const epochSnapshot: EpochSnapshot = {
          authEpoch: principal.auth_epoch,
          membershipEpoch: member.membership_epoch,
          channelEpoch: channel.channel_epoch,
        };

        // (C3) Atomic: register + buffering=true + highWater capture, all
        // synchronous, still holding the sequencer mutex.
        registered = this.registry.register({
          subscriptionId,
          sessionId: body.sessionId,
          channelId: channel.id,
          principalId: caller.principalId,
          credentialId: body.credentialId,
          rejoinedSeq: member.rejoined_seq,
          epochSnapshot,
          highWaterCursor,
          sink: body.sink,
          nowMs: this.nowMs,
        });
        this.observability.markSubscriptionBacklog();
      })
    );

    const sub = registered!;

    // Backlog replay: max(afterCursor,rejoined_seq) < seq <= highWater,
    // delivered ascending, OUTSIDE the locks (Section 8.3).
    const backlogRows = this.env.db
      .prepare(
        `SELECT * FROM collab_events WHERE channel_id = ? AND channel_seq > ? AND channel_seq <= ? ORDER BY channel_seq ASC`
      )
      .all(body.channelId, effectiveAfter, sub.highWaterCursor) as EventRow[];

    for (const row of backlogRows) {
      const payload = JSON.parse(row.content_json) as Record<string, unknown>;
      sub.deliverBacklogEvent({
        type: 'channel_event',
        protocolVersion: 2,
        subscriptionId,
        channelId: body.channelId,
        cursor: String(row.channel_seq),
        event: {
          id: row.id,
          kind: row.kind,
          actorPrincipalId: row.actor_principal_id,
          occurredAt: row.created_at,
          payload,
        },
      });
    }

    // Transition to live UNDER THE MUTEX: drains anything that committed
    // and buffered (seq > highWater) during the backlog read above.
    await this.mutex.withLock(() => {
      sub.transitionToLive();
      this.observability.markSubscriptionLive();
    });

    return { subscriptionId, highWaterCursor: String(sub.highWaterCursor) };
  }

  /**
   * UNSUBSCRIBE_CHANNEL: naturally-idempotent path (read lock then
   * sequencer mutex). Closes ONLY the target subscription with
   * `unsubscribed` — never the session or any other subscription. Repeated
   * calls by the owning session return the same closed result
   * (SUBSCRIPTION_OWNER predicate + idempotent `close()`).
   */
  async unsubscribeChannel(
    caller: CallerContext,
    body: { subscriptionId: string; sessionId: string }
  ): Promise<UnsubscribeChannelResult> {
    let didClose = false;
    const sub = await this.withReadThenSequencer(() =>
      this.mutex.withLock(() => {
        const sub = this.registry.get(body.subscriptionId);
        // (SUBSCRIPTION_OWNER) belongs to current session; absent or
        // foreign subscription -> COLLAB_NOT_FOUND, byte-identical to every
        // other denial cause.
        if (!sub || sub.sessionId !== body.sessionId) {
          throw notFound();
        }
        if (!sub.closed) {
          const wasActive = sub.state !== 'backlog';
          sub.close('unsubscribed');
          this.observability.markSubscriptionClosed(wasActive);
          didClose = true;
        }
        return sub;
      })
    );

    // Post-lock delivery step: deliver the close frame only on the call
    // that actually performed the transition to closed — a repeat
    // UNSUBSCRIBE (or one racing a mutation that closed it first) returns
    // the same closed result without re-delivering a second close frame.
    if (didClose) {
      sub.deliverCloseFrame();
    }
    return { subscriptionId: body.subscriptionId, state: 'closed' as const };
  }

  /**
   * PRD-TCLAW-AGENT-PARTICIPATION-007 S5: close and DEREGISTER every
   * subscription owned by one gateway session (socket lifecycle). Closing
   * alone leaves the registry row addressable by forSession()/all(); the
   * departure gap this slice closes is specifically that a dead socket must
   * not remain registered. Active subscriptions are closed under the
   * sequencer mutex (same ordering discipline as every other registry state
   * transition), their terminal close frame is delivered best-effort AFTER
   * the lock releases, and every subscription for the session is then removed
   * from the registry whether it was active or already closed. A throwing
   * sink must never strand the deregistration or escape into the gateway's
   * socket close handler.
   */
  async closeSubscriptionsForSession(
    sessionId: string,
    reason: SubscriptionCloseReason = 'socket_closed'
  ): Promise<number> {
    let closedNow: Subscription[] = [];
    const sessionSubs = await this.mutex.withLock(() => {
      const subs = this.registry.forSession(sessionId);
      closedNow = [];
      for (const sub of subs) {
        if (sub.closed) continue;
        const wasActive = sub.state !== 'backlog';
        sub.close(reason);
        this.observability.markSubscriptionClosed(wasActive);
        closedNow.push(sub);
      }
      return subs;
    });

    const closedNowIds = new Set(closedNow.map((sub) => sub.subscriptionId));
    for (const sub of sessionSubs) {
      try {
        if (closedNowIds.has(sub.subscriptionId)) {
          sub.deliverCloseFrame();
        }
      } catch {
        // Best-effort terminal frame only; removal still completes.
      } finally {
        this.registry.remove(sub.subscriptionId);
      }
    }
    return closedNow.length;
  }

  /**
   * LIST_CHANNELS: read-path (C1). No sequencer mutex, no result row; a
   * plain read against the current committed state is sufficient (SQLite's
   * default isolation for a sequence of statements outside an explicit
   * transaction is consistent enough for a read-only listing command with
   * no cross-row invariant to preserve).
   */
  async listChannels(
    caller: CallerContext,
    body: { afterChannelId: string | null; limit: number; includeArchived: boolean }
  ): Promise<ListChannelsResult> {
    return this.withReadOnly(() => this.runReadCommand(() => {
      if (body.limit < 1 || body.limit > 100) {
        throw new CollabError('INVALID_REQUEST', 'limit must be between 1 and 100');
      }

      const db = this.env.db;
      const stateFilter = body.includeArchived ? "('active','archived')" : "('active')";
      const rows = db
        .prepare(
          `SELECT c.id as channel_id, c.name as name, c.state as state,
                  c.external_export_policy as external_export_policy,
                  m.role as role, m.membership_epoch as membership_epoch
           FROM collab_channels c
           JOIN collab_members m ON m.channel_id = c.id
           WHERE m.principal_id = ? AND m.state = 'active' AND c.state IN ${stateFilter}
             AND (? IS NULL OR c.id > ?)
           ORDER BY c.id ASC
           LIMIT ?`
        )
        .all(caller.principalId, body.afterChannelId, body.afterChannelId, body.limit + 1) as Array<{
        channel_id: string;
        name: string;
        state: 'active' | 'archived';
        role: 'owner' | 'agent';
        membership_epoch: number;
        external_export_policy: 'local_only' | 'operator_confirmed_non_sensitive';
      }>;

      // Frame-cut (H3): trim to the 64 KiB result-frame bound in addition
      // to the row-count limit. Encode incrementally and stop before the
      // frame would exceed 65536 bytes.
      const encoder = new TextEncoder();
      const channels: ListChannelsEntry[] = [];
      let hasMore = false;
      let encodedLen = 2; // '{}' shell approximation; refined below per item

      for (let i = 0; i < rows.length; i++) {
        if (channels.length >= body.limit) {
          hasMore = true;
          break;
        }
        const row = rows[i]!;
        const cursorRow = db
          .prepare('SELECT acknowledged_seq FROM collab_cursors WHERE channel_id = ? AND principal_id = ?')
          .get(row.channel_id, caller.principalId) as { acknowledged_seq: number } | undefined;

        const entry: ListChannelsEntry = {
          channelId: row.channel_id,
          name: row.name,
          state: row.state,
          role: row.role,
          lastAcknowledgedCursor: cursorRow ? String(cursorRow.acknowledged_seq) : '0',
          externalExportPolicy: row.external_export_policy,
        };

        const entryBytes = encoder.encode(JSON.stringify(entry)).length;
        if (channels.length > 0 && encodedLen + entryBytes + 1 > 65536) {
          hasMore = true;
          break;
        }
        encodedLen += entryBytes + 1;
        channels.push(entry);
      }

      // If the query fetched limit+1 rows and we consumed exactly `limit`
      // without a frame cut, there is at least one more matching row.
      if (!hasMore && rows.length > channels.length) {
        hasMore = true;
      }

      const nextChannelId = channels.length > 0 ? channels[channels.length - 1]!.channelId : body.afterChannelId;

      return { channels, nextChannelId, hasMore };
    }));
  }

  /**
   * GET_CHANNEL_TIMELINE: read-path (C1). No sequencer mutex, no result row.
   */
  async getChannelTimeline(
    caller: CallerContext,
    body: { channelId: string; afterCursor: string; limit: number }
  ): Promise<GetChannelTimelineResult> {
    const start = this.nowMs();
    const out = await this.withReadOnly(() => this.runReadCommand(() => {
      if (body.limit < 1 || body.limit > 100) {
        throw new CollabError('INVALID_REQUEST', 'limit must be between 1 and 100');
      }

      const db = this.env.db;
      const member = this.assertChannelVisible(db, caller, body.channelId);

      const requested = this.parseCursor(body.afterCursor);
      // Clamp effective afterCursor to max(afterCursor, rejoined_seq).
      const effectiveAfter = Math.max(requested, member.rejoined_seq);

      // (H1) event visible iff channel_seq STRICTLY > rejoined_seq — the
      // clamp above already enforces this for the lower bound of the page,
      // and the query below re-asserts channel_seq > effectiveAfter, which
      // is >= rejoined_seq, so no event at or before rejoined_seq is ever
      // returned.
      const rows = db
        .prepare(
          `SELECT * FROM collab_events WHERE channel_id = ? AND channel_seq > ? ORDER BY channel_seq ASC LIMIT ?`
        )
        .all(body.channelId, effectiveAfter, body.limit + 1) as EventRow[];

      const encoder = new TextEncoder();
      const events: TimelineEventObject[] = [];
      let hasMore = false;
      let encodedLen = 2;

      for (const row of rows) {
        if (events.length >= body.limit) {
          hasMore = true;
          break;
        }
        const payload = JSON.parse(row.content_json) as Record<string, unknown>;
        const eventObj: TimelineEventObject = {
          cursor: String(row.channel_seq),
          id: row.id,
          kind: row.kind,
          actorPrincipalId: row.actor_principal_id,
          occurredAt: row.created_at,
          payload,
        };
        const entryBytes = encoder.encode(JSON.stringify(eventObj)).length;
        if (events.length > 0 && encodedLen + entryBytes + 1 > 65536) {
          hasMore = true;
          break;
        }
        encodedLen += entryBytes + 1;
        events.push(eventObj);
      }

      if (!hasMore && rows.length > events.length) {
        hasMore = true;
      }

      const nextCursor = events.length > 0 ? events[events.length - 1]!.cursor : String(effectiveAfter);
      const highWaterCursor = String(this.getMaxChannelSeq(db, body.channelId));

      return { events, nextCursor, hasMore, highWaterCursor };
    }));
    this.observability.timelineLatency.record(this.nowMs() - start);
    return out;
  }

  // -------------------------------------------------------------------
  // Direct storage-level negative-fixture surface (Section 9 validations)
  // -------------------------------------------------------------------

  /**
   * Exposes the raw db handle for direct storage-level negative fixtures
   * (Section 9's mandate: "Direct storage-level negative fixtures invoke
   * every CollaborationStore write method with ... forged owner
   * memberships ... and prove zero rows change"). Tests use this to
   * attempt writes bypassing the command layer's own guards and assert
   * the DB-level CHECKs/validations still hold.
   */
  get rawDb(): BootstrapDb {
    return this.env.db;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private issueCredentialRow(
    tx: BootstrapDb,
    principalId: string,
    now: string
  ): { credentialId: string; token: string; secretBytes: Buffer } {
    const credentialId = this.env.uuids.next();
    const issued = issueCredential(credentialId, this.env.principalPepper, this.env.rng);

    // (F1) Capture the secret Buffer reference AT ALLOCATION, before the
    // INSERT below can throw, and before returning control to `fn`/the
    // transaction closure/the post-`fn` mutation-result INSERT/commit. From
    // this point on, `runKeyedCommand`'s outer try/finally owns zeroing
    // this exact Buffer on every exit path — success, IDEMPOTENCY_CONFLICT,
    // predicate denial (not reachable after this line), UNIQUE-violation
    // rethrow, or any later throw (e.g. a throwing clock).
    this.pendingSecretBytes = issued.secretBytes;

    try {
      tx
        .prepare(
          'INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES(?,?,?,?,?,?,?)'
        )
        .run(credentialId, principalId, issued.secretHmac, 'active', null, now, null);
    } catch (err) {
      // (F1) Do NOT fill(0) here: `this.pendingSecretBytes` already holds
      // this exact Buffer, and `runKeyedCommand`'s outer try/finally is the
      // single source of truth for zeroing it, on this path and every
      // other. Zeroing here too would be harmless (fill(0) is idempotent)
      // but would split the "who zeroes this" responsibility across two
      // places, which is exactly the bug this fix removes.
      //
      // (M1): a secret_hmac UNIQUE violation is a typed internal invariant
      // error, not an uncaught SQLite exception. better-sqlite3 raises a
      // generic Error whose `.message` contains the SQLite constraint
      // description; we detect the UNIQUE-on-secret_hmac case by message
      // content since better-sqlite3 does not expose a typed error class
      // for this in the injected BootstrapDb interface.
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed.*secret_hmac/i.test(message)) {
        throw new CredentialHmacCollisionError(
          `secret_hmac collision detected for credential ${credentialId}: ${message}`
        );
      }
      throw err;
    }

    return { credentialId, token: issued.token, secretBytes: issued.secretBytes };
  }

  private countActiveCredentials(tx: BootstrapDb, principalId: string): number {
    const row = tx
      .prepare('SELECT COUNT(*) as c FROM principal_credentials WHERE principal_id = ? AND state = ?')
      .get(principalId, 'active') as { c: number };
    return row.c;
  }

  private getPrincipalOrThrow(tx: BootstrapDb, principalId: string): PrincipalRow {
    const row = tx.prepare('SELECT * FROM principals WHERE id = ?').get(principalId) as PrincipalRow | undefined;
    if (!row) {
      throw new CollabError('PRINCIPAL_NOT_FOUND', `Principal ${principalId} not found`);
    }
    return row;
  }

  private getAgentTargetOrThrow(tx: BootstrapDb, principalId: string): PrincipalRow {
    const row = this.getPrincipalOrThrow(tx, principalId);
    if (row.kind !== 'agent') {
      // Section 7.4: SUSPEND_AGENT/RESTORE_AGENT/REVOKE_AGENT return
      // INVALID_REQUEST when principalId names the operator.
      throw new CollabError('INVALID_REQUEST', `${principalId} is not an agent principal`);
    }
    return row;
  }

  private assertOwnedAgent(tx: BootstrapDb, caller: CallerContext, principalId: string): PrincipalRow {
    const agent = this.getAgentTargetOrThrow(tx, principalId);
    if (agent.owner_principal_id !== caller.principalId) {
      throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent is not owned by the invoking operator');
    }
    return agent;
  }

  private normalizeRuntimeIdentifier(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new CollabError('INVALID_REQUEST', `${field} must be a string`);
    }
    const normalized = value.normalize('NFC').trim();
    if (normalized.length === 0 || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new CollabError('INVALID_REQUEST', `${field} must contain 1-200 printable characters`);
    }
    return normalized;
  }

  private normalizeAgentIcon(value: unknown): AgentIconId {
    if (typeof value !== 'string' || !AGENT_ICON_IDS.includes(value as AgentIconId)) {
      throw new CollabError('INVALID_REQUEST', 'iconId is not an allowed agent icon');
    }
    return value as AgentIconId;
  }

  private normalizeSystemDirectives(value: unknown): string {
    if (typeof value !== 'string') {
      throw new CollabError('INVALID_REQUEST', 'systemDirectives must be a string');
    }
    const normalized = value.normalize('NFC').trim();
    if (normalized.length > 4000) {
      throw new CollabError('INVALID_REQUEST', 'systemDirectives must contain at most 4000 characters');
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(normalized)) {
      throw new CollabError('INVALID_REQUEST', 'systemDirectives contain forbidden control characters');
    }
    return normalized;
  }

  private mintPersonaEnvelope(source: unknown, revision: number): AgentPersonaEnvelope {
    const content = this.normalizeSystemDirectives(source);
    if (content === '') {
      return {
        version: 1,
        content: '',
        personaRevision: 0,
        contentSha256: createHash('sha256').update('', 'utf8').digest('hex'),
      };
    }
    if (!Number.isInteger(revision) || revision <= 0) {
      throw new CollabError('COLLAB_NOT_PERMITTED', 'Nonblank persona has no valid revision');
    }
    return {
      version: 1,
      content,
      personaRevision: revision,
      contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }

  private validatePersonaEnvelope(value: {
    version: unknown; content: unknown; personaRevision: unknown; contentSha256: unknown;
  } | undefined): AgentPersonaEnvelope {
    if (!value || value.version !== 1 || typeof value.content !== 'string'
      || !Number.isInteger(value.personaRevision) || (value.personaRevision as number) < 0
      || typeof value.contentSha256 !== 'string') {
      throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent turn persona envelope is missing or malformed');
    }
    const content = this.normalizeSystemDirectives(value.content);
    const hash = createHash('sha256').update(content, 'utf8').digest('hex');
    if (content !== value.content || hash !== value.contentSha256
      || (content === '' && value.personaRevision !== 0)) {
      throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent turn persona envelope failed integrity validation');
    }
    return { version: 1, content, personaRevision: value.personaRevision as number, contentSha256: hash };
  }

  private personaEnvelopesEqual(left: AgentPersonaEnvelope, right: AgentPersonaEnvelope): boolean {
    return left.version === right.version && left.content === right.content
      && left.personaRevision === right.personaRevision && left.contentSha256 === right.contentSha256;
  }

  private runtimeProfileForClaim(tx: BootstrapDb, agentPrincipalId: string): AgentRuntimeProfile {
    const row = tx.prepare('SELECT * FROM collab_agent_runtime_profiles WHERE agent_principal_id = ?')
      .get(agentPrincipalId) as AgentRuntimeProfileRow | undefined;
    if (!row) throw new CollabError('COLLAB_NOT_PERMITTED', 'Agent runtime profile is unavailable');
    return this.runtimeProfileFromRow(row);
  }

  private runtimeProfileFromRow(row: AgentRuntimeProfileRow): AgentRuntimeProfile {
    return {
      agentPrincipalId: row.agent_principal_id,
      providerAccountId: row.provider_account_id,
      adapterId: row.adapter_id,
      modelId: row.model_id,
      autostart: row.autostart === 1,
      externalContextConfirmed:
        row.external_context_confirmed === 1
        && row.external_context_provider_account_id === row.provider_account_id
        && row.external_context_model_id === row.model_id,
      externalContextRuntimeFingerprint: row.external_context_runtime_fingerprint,
      externalContextExactModelId: row.external_context_exact_model_id,
      externalContextPersonaRevision: row.external_context_persona_revision,
      externalContextPersonaContentSha256: row.external_context_persona_content_sha256,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private validateExternalContextBinding(body: Pick<
    UpsertAgentRuntimeProfileInput,
    'providerAccountId' | 'modelId' | 'externalContextConfirmed'
      | 'externalContextRuntimeFingerprint' | 'externalContextExactModelId'
      | 'externalContextPersonaRevision' | 'externalContextPersonaContentSha256'
  >): void {
    if (!body.externalContextConfirmed) {
      if (body.externalContextRuntimeFingerprint !== null
        || body.externalContextExactModelId !== null
        || body.externalContextPersonaRevision !== null
        || body.externalContextPersonaContentSha256 !== null) {
        throw new CollabError('INVALID_REQUEST', 'Disabled external consent cannot retain a binding');
      }
      return;
    }
    if (!/^[a-f0-9]{64}$/.test(body.externalContextRuntimeFingerprint ?? '')
      || body.externalContextExactModelId !== body.modelId
      || !Number.isInteger(body.externalContextPersonaRevision)
      || (body.externalContextPersonaRevision ?? -1) < 0
      || !/^[a-f0-9]{64}$/.test(body.externalContextPersonaContentSha256 ?? '')) {
      throw new CollabError('INVALID_REQUEST', 'External subscription consent binding is incomplete');
    }
  }

  private getOperatorOrThrow(tx: BootstrapDb): PrincipalRow {
    const row = tx.prepare("SELECT * FROM principals WHERE kind = 'operator'").get() as PrincipalRow | undefined;
    if (!row) {
      throw new CollabError('PRINCIPAL_NOT_FOUND', 'No operator principal exists');
    }
    return row;
  }

  /**
   * Section 9 validations 1/9 (e-3): storage-level backstop. Every write
   * verifies the invoking principal is the operator (kind operator) and
   * active; a mismatch rolls back with ZERO row changes by throwing before
   * any mutation statement runs (the caller's already-open BEGIN IMMEDIATE
   * transaction is rolled back around this throw).
   */
  private assertOperatorCaller(tx: BootstrapDb, caller: CallerContext): void {
    const row = tx.prepare('SELECT * FROM principals WHERE id = ?').get(caller.principalId) as
      | PrincipalRow
      | undefined;
    if (!row || row.kind !== 'operator' || row.status !== 'active') {
      throw new CollabError(
        'COLLAB_NOT_PERMITTED',
        'Only the active operator principal, connected with role operator, may invoke this command'
      );
    }
  }

  // -------------------------------------------------------------------
  // Channel helpers (Slice 2)
  // -------------------------------------------------------------------

  /**
   * (C2) Channel resolution used ONLY inside a predicate/read slot that has
   * already decided the channel is hidden -> throws COLLAB_NOT_FOUND. Never
   * called before BEGIN IMMEDIATE / before a read snapshot begins.
   */
  private getChannelOrThrow(tx: BootstrapDb, channelId: string): ChannelRow {
    const row = tx.prepare('SELECT * FROM collab_channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
    if (!row) {
      throw notFound();
    }
    return row;
  }

  /**
   * CHANNEL_OWNER predicate (Section 4.2): BASE plus the current principal
   * is the operator principal connected with role operator, and the target
   * channel's owner_principal_id equals the current principal ID; channel
   * may be active or archived (state is NEVER part of this predicate — see
   * M3/step-8). Every denial cause here — absent channel, hidden channel,
   * non-operator caller, or operator-but-not-this-channel's-owner — is
   * COLLAB_NOT_FOUND, byte-identical. Section 9 validation 9: the invoking
   * principal's operator-ness is a DB read, never caller-asserted.
   */
  private assertChannelOwner(tx: BootstrapDb, caller: CallerContext, channelId: string): ChannelRow {
    const callerRow = tx.prepare('SELECT * FROM principals WHERE id = ?').get(caller.principalId) as
      | PrincipalRow
      | undefined;
    const channel = tx.prepare('SELECT * FROM collab_channels WHERE id = ?').get(channelId) as
      | ChannelRow
      | undefined;

    if (
      !callerRow ||
      callerRow.kind !== 'operator' ||
      callerRow.status !== 'active' ||
      !channel ||
      channel.owner_principal_id !== callerRow.id
    ) {
      throw notFound();
    }
    return channel;
  }

  /**
   * CHANNEL_VISIBLE / CHANNEL_WRITABLE / CURSOR_OWNER predicate (Section
   * 4.2): BASE plus active-or-archived channel and active membership. State
   * is never part of this predicate. Every denial cause — absent, hidden,
   * archived-hidden, non-member — is COLLAB_NOT_FOUND, byte-identical.
   * Returns the caller's own active membership row.
   */
  private assertChannelVisible(tx: BootstrapDb, caller: CallerContext, channelId: string): MemberRow {
    const channel = tx.prepare('SELECT * FROM collab_channels WHERE id = ?').get(channelId) as
      | ChannelRow
      | undefined;
    if (!channel) {
      throw notFound();
    }
    const member = tx
      .prepare('SELECT * FROM collab_members WHERE channel_id = ? AND principal_id = ?')
      .get(channelId, caller.principalId) as MemberRow | undefined;
    if (!member || member.state !== 'active') {
      throw notFound();
    }
    return member;
  }

  private getMaxChannelSeq(tx: BootstrapDb, channelId: string): number {
    const row = tx
      .prepare('SELECT COALESCE(MAX(channel_seq), 0) as m FROM collab_events WHERE channel_id = ?')
      .get(channelId) as { m: number };
    return row.m;
  }

  /**
   * (H3) The two-branch caller-visible cursor bound: the greatest committed
   * channel_seq when any committed event in the channel has channel_seq
   * greater than the member's current rejoined_seq; otherwise the member's
   * rejoined_seq.
   */
  private callerVisibleBound(tx: BootstrapDb, channelId: string, rejoinedSeq: number): number {
    const maxSeq = this.getMaxChannelSeq(tx, channelId);
    return maxSeq > rejoinedSeq ? maxSeq : rejoinedSeq;
  }

  private parseCursor(cursor: string): number {
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) {
      throw new CollabError('INVALID_REQUEST', `Cursor must be an unsigned base-10 integer without leading zeroes: ${cursor}`);
    }
    const n = Number(cursor);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new CollabError('INVALID_REQUEST', `Cursor out of representable range: ${cursor}`);
    }
    return n;
  }

  /**
   * Maps a UNIQUE(collab_channels_active_name_key) constraint violation to
   * CHANNEL_NAME_CONFLICT. Used by both CREATE_CHANNEL and UNARCHIVE_CHANNEL
   * (Section 9 validation 8: the unique active-name_key index is the
   * concurrency backstop for both).
   */
  private mapChannelNameConflict(err: unknown): unknown {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed.*name_key/i.test(message) || /collab_channels_active_name_key/i.test(message)) {
      return new CollabError('CHANNEL_NAME_CONFLICT', 'An active channel with this name already exists');
    }
    return err;
  }

  private insertAudit(
    tx: BootstrapDb,
    kind: string,
    actorPrincipalId: string,
    subjectPrincipalId: string,
    content: Record<string, unknown>
  ): void {
    const now = this.env.clock.next();
    tx
      .prepare(
        'INSERT INTO collab_audit(kind, actor_principal_id, subject_principal_id, content_json, created_at) VALUES(?,?,?,?,?)'
      )
      .run(kind, actorPrincipalId, subjectPrincipalId, canonicalJson(content), now);
  }

  /** Returns the closed session IDs, so callers can derive affected subscriptions (Section 8.2). */
  private closeSessionsForPrincipal(
    tx: BootstrapDb,
    principalId: string,
    closeReason: string,
    now: string
  ): string[] {
    const openSessions = tx
      .prepare('SELECT session_id FROM collab_session_bindings WHERE principal_id = ? AND closed_at IS NULL')
      .all(principalId) as Array<{ session_id: string }>;
    for (const s of openSessions) {
      tx
        .prepare('UPDATE collab_session_bindings SET closed_at = ?, close_reason = ? WHERE session_id = ?')
        .run(now, closeReason, s.session_id);
    }
    return openSessions.map((s) => s.session_id);
  }

  /** Returns the closed session IDs, so callers can derive affected subscriptions (Section 8.2). */
  private closeSessionsForCredential(
    tx: BootstrapDb,
    credentialId: string,
    closeReason: string,
    now: string
  ): string[] {
    const openSessions = tx
      .prepare('SELECT session_id FROM collab_session_bindings WHERE credential_id = ? AND closed_at IS NULL')
      .all(credentialId) as Array<{ session_id: string }>;
    for (const s of openSessions) {
      tx
        .prepare('UPDATE collab_session_bindings SET closed_at = ?, close_reason = ? WHERE session_id = ?')
        .run(now, closeReason, s.session_id);
    }
    return openSessions.map((s) => s.session_id);
  }

  /**
   * The Section 8.3 atomic protocol driver.
   *
   * `predicate` runs FIRST inside the transaction (step 2: revalidate the
   * command predicate) — for every Slice 1 command this is
   * `assertOperatorCaller`, since all seven Slice 1 commands are
   * OPERATOR_GLOBAL. It must throw a CollabError to deny.
   *
   * The idempotency lookup (steps 3-5) then runs, followed by `fn` (step
   * 6: perform the mutation) only when no stored result was returned.
   * `fn` must throw a CollabError (or let one propagate) for any
   * command-specific denial (e.g. PRINCIPAL_NOT_FOUND); this wrapper turns
   * any throw into a clean ROLLBACK.
   *
   * On success, `fn` returns `{ result, redacted, secretBytes? }`: `result`
   * is the full first-response shape (with plaintext secret if
   * applicable), `redacted` is what gets persisted to
   * `collab_mutation_results.result_json`, and `secretBytes` (if present)
   * is zeroed AFTER commit (step 7: commit BEFORE one-time secret
   * handoff), on both the success and error paths.
   *
   * (F1) Zeroing discipline: `fn`'s mutation logic (specifically
   * `issueCredentialRow`, when a command issues a credential) sets
   * `this.pendingSecretBytes` to the live secret Buffer THE INSTANT it is
   * allocated — before the credential INSERT, before this method's own
   * mutation-result INSERT, before commit. The `try/finally` below wraps
   * the ENTIRE transaction invocation (`tx()`), so `this.pendingSecretBytes`
   * is zeroed on every exit from `tx()` — normal return (success or
   * same-hash replay, where it is simply `undefined` and the fill is a
   * no-op), a thrown `IDEMPOTENCY_CONFLICT`, a thrown command-specific
   * CollabError from `fn`, a thrown UNIQUE-violation from the credential
   * INSERT, or a throw from ANYTHING that runs after allocation but before
   * `tx()` returns — including the `this.env.clock.next()` call and the
   * `collab_mutation_results` INSERT that both run after `fn()` in this
   * method. This closes the exact gap the G2A audit found: previously the
   * secret Buffer reference was only captured in a local variable AFTER
   * `fn()` returned successfully, so a throw between allocation and that
   * point left the Buffer un-zeroed on the heap. Capturing at allocation
   * time on `this` and zeroing in `finally` makes zeroing unconditional.
   */
  private runKeyedCommand<TResult>(
    principalId: string,
    command: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
    predicate: (tx: BootstrapDb) => void,
    fn: (tx: BootstrapDb) => { result: TResult; redacted: unknown; secretBytes?: Buffer }
  ): TResult {
    // (H1/F2): hash the POST-NORMALIZATION POST-TRIM body. Every public
    // command method normalizes its own free-text fields (e.g.
    // createAgent's displayName via normalizeName) before calling this
    // method, so `body` here is already the exact persisted-form bytes,
    // and canonicalJson(body) is the exact hash input, matching what gets
    // persisted (bound to canonicalJson specifically, not JSON.stringify,
    // so key order never perturbs the hash — see the permuted-key-order
    // replay fixture).
    const requestHash = createHash('sha256').update(canonicalJson(body)).digest();

    let finalResult: TResult;

    const tx = this.env.db.transaction(() => {
      // Step 2: revalidate the command predicate INSIDE the transaction,
      // before the idempotency lookup (steps 3-5).
      predicate(this.env.db);

      const existing = this.env.db
        .prepare(
          'SELECT request_hash, result_json FROM collab_mutation_results WHERE principal_id = ? AND command = ? AND idempotency_key = ?'
        )
        .get(principalId, command, idempotencyKey) as { request_hash: Buffer; result_json: string } | undefined;

      if (existing) {
        const existingHashBuf = Buffer.from(existing.request_hash);
        if (existingHashBuf.equals(requestHash)) {
          finalResult = JSON.parse(existing.result_json) as TResult;
          return;
        }
        throw new CollabError('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different request body');
      }

      // (F1) `fn` may call `issueCredentialRow`, which sets
      // `this.pendingSecretBytes` at allocation — before this line
      // returns. Nothing here re-reads `secretBytes` off the return value
      // for zeroing purposes; the outer `finally` is the sole zeroer.
      const { result, redacted } = fn(this.env.db);

      const now = this.env.clock.next();
      this.env.db
        .prepare(
          'INSERT INTO collab_mutation_results(principal_id, command, idempotency_key, request_hash, result_json, created_at) VALUES(?,?,?,?,?,?)'
        )
        .run(principalId, command, idempotencyKey, requestHash, JSON.stringify(redacted), now);

      finalResult = result;
    });

    try {
      tx();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return finalResult!;
    } finally {
      // (F1) Unconditional zero-and-clear: covers the success path (step 7
      // semantics — commit already happened above, by the time we reach
      // here, before this one-time zero) AND every throw path, including
      // throws that occur after credential allocation but before this
      // try/finally's `tx()` call returns.
      if (this.pendingSecretBytes) {
        this.pendingSecretBytes.fill(0);
        this.pendingSecretBytes = undefined;
      }
    }
  }

  /**
   * (C1) The naturally-idempotent driver path: sequencer mutex + BEGIN
   * IMMEDIATE, predicate revalidated in-transaction, but NEVER reads or
   * writes collab_mutation_results. Used solely by ACK_CHANNEL_CURSOR,
   * whose own upsert-with-max semantics ARE the idempotency mechanism.
   */
  private runNaturallyIdempotentCommand<TResult>(
    _principalId: string,
    _command: string,
    fn: (tx: BootstrapDb) => TResult
  ): TResult {
    let finalResult: TResult;
    const tx = this.env.db.transaction(() => {
      finalResult = fn(this.env.db);
    });
    tx();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return finalResult!;
  }

  /**
   * (C1) The read-path driver: NO sequencer mutex, no BEGIN IMMEDIATE, no
   * result row. Used by LIST_CHANNELS and GET_CHANNEL_TIMELINE. Runs the
   * predicate/query directly against the current committed state.
   */
  private runReadCommand<TResult>(fn: () => TResult): TResult {
    return fn();
  }
}

/** A CredentialLookup adapter backed by a live BootstrapDb, for connect-path verification (used by future slices / tests). */
export function credentialLookupFromDb(db: BootstrapDb): CredentialLookup {
  return (credentialId: string) => {
    const row = db.prepare('SELECT secret_hmac, state FROM principal_credentials WHERE id = ?').get(credentialId) as
      | { secret_hmac: Buffer; state: 'active' | 'revoked' }
      | undefined;
    if (!row) return undefined;
    return { secretHmac: Buffer.from(row.secret_hmac), state: row.state };
  };
}
