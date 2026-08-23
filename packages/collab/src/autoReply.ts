import { randomUUID } from 'node:crypto';

/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — the auto-reply trigger resolver,
 * turn watermark, and STOP control.
 *
 * G1R Gate-1 B-3(a): INV-T1 must be enforced by THREE independent
 * mechanisms, not asserted in a paragraph. This module supplies all three
 * for the resolver; the differential-content probe and the source-level
 * assertion live in tests/agent-participation-s3.test.ts.
 *
 *   INV-T1. The set of agent principals eligible to be triggered by a
 *   committed channel event MUST be a pure function of (channelId)
 *   evaluated against collab_members, and MUST NOT depend on any byte of
 *   the triggering event's content_json, on the event's kind, or on any
 *   model output.
 *
 *     Mechanism 1 (STRUCTURAL): resolveEligibleAgents's own parameter list
 *     below is type-narrowed to (db, channelId, actorPrincipalId, seq) --
 *     it CANNOT be given an event row, content_json, or text, because no
 *     such parameter exists on the signature. A future edit that wanted to
 *     consult message content would have to WIDEN this signature, which is
 *     a visible, reviewable diff -- not a quiet internal change.
 *
 *     Mechanism 2 (BEHAVIORAL, FALSIFIABLE): the differential-content probe
 *     in the test file posts two messages with identical membership state
 *     -- "hello" vs. an adversarial payload naming every member, every
 *     non-member, "@everyone", and a JSON-shaped {"trigger":[...]} fragment
 *     -- and asserts the eligible sets are byte-identical. It then mutates
 *     this file to union in a text-derived principal id and shows the test
 *     goes RED.
 *
 *     Mechanism 3 (REGRESSION-RESISTANT): the test file also asserts, by
 *     reading this file's own source, that resolveEligibleAgents's function
 *     body contains no reference to content_json/text/event body tokens.
 */

/**
 * Deliberately narrower than better-sqlite3's full Database type -- this
 * module only ever prepares statements, matching BootstrapDb's shape
 * (bootstrap.ts) exactly so the SAME handle collabIdentity.ts/
 * collabSurface.ts already hold (typed as BootstrapDb) can be passed
 * directly, with no adapter or cast at any call site.
 */
export type AutoreplyDb = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

/**
 * Corollary A: this function may read actor_principal_id (anti-self-reply)
 * and seq (idempotency) -- both are SUBSTRATE METADATA, passed as scalar
 * parameters, never a message body. It may not read text. It CANNOT read
 * text: no parameter here carries it.
 *
 * Corollary B: for a fixed channelId and a fixed collab_members state, this
 * returns the identical set regardless of which event triggered the call --
 * actorPrincipalId only EXCLUDES the author from an otherwise
 * membership-only set, never adds to it.
 *
 * Corollary C: this function contains no INSERT/UPDATE against
 * collab_members -- it is read-only by construction (SELECT only).
 */
export function resolveEligibleAgents(
  db: AutoreplyDb,
  channelId: string,
  actorPrincipalId: string,
  _seq: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT m.principal_id AS principalId
         FROM collab_members m
         JOIN principals p ON p.id = m.principal_id
        WHERE m.channel_id = ?
          AND m.state = 'active'
          AND p.kind = 'agent'
          AND p.status = 'active'
          AND m.principal_id != ?
        ORDER BY m.principal_id ASC`,
    )
    .all(channelId, actorPrincipalId) as Array<{ principalId: string }>;
  return rows.map((r) => r.principalId);
}

export type AgentTurnState = 'dispatched' | 'completed' | 'no_post' | 'terminated';

const CLAIM_BUSY_MAX_ATTEMPTS = 3;

type SqliteErrorLike = { code?: unknown };

function sqliteErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as SqliteErrorLike).code;
  return typeof code === 'string' && /^SQLITE_[A-Z0-9_]+$/.test(code) ? code : undefined;
}

function isDuplicateClaimError(code: string | undefined): boolean {
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function isRetryableClaimError(code: string | undefined): boolean {
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || code?.startsWith('SQLITE_BUSY_') === true
    || code?.startsWith('SQLITE_LOCKED_') === true;
}

function waitForClaimRetry(attempt: number): void {
  // better-sqlite3 is synchronous. Keep this backoff deliberately short and
  // bounded; the connection's busy_timeout remains the primary wait.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 10);
}

export class AgentTurnClaimError extends Error {
  readonly code = 'AGENT_TURN_CLAIM_FAILED';

  constructor(sqliteCode: string | undefined) {
    super(`AGENT_TURN_CLAIM_FAILED sqlite_code=${sqliteCode ?? 'UNKNOWN'}`);
    this.name = 'AgentTurnClaimError';
  }
}

/**
 * Anti-storm requirement 2 (idempotency), and the watermark half of G1R
 * B-3(b): claim the (channel, agent, seq) triple for dispatch. The PRIMARY
 * KEY on collab_agent_turns is the actual enforcement -- a second attempt
 * for the same triple is a UNIQUE-constraint failure, caught here and
 * turned into `false` (already claimed), never a silent double-dispatch.
 *
 * This is the SAME durable row used for both watermarks (G1R's naming: one
 * row, an explicit state machine, rather than two separate "highest
 * dispatched" / "highest completed" values that can point in different
 * directions across a crash).
 */
export function claimAgentTurn(
  db: AutoreplyDb,
  params: { channelId: string; agentPrincipalId: string; channelSeq: number; triggerEventId: string; nowIso: string },
): boolean {
  const statement = db.prepare(
    `INSERT INTO collab_agent_turns
       (channel_id, agent_principal_id, channel_seq, trigger_event_id, state, dispatch_request_id, dispatched_at, resolved_at)
     VALUES (?, ?, ?, ?, 'dispatched', NULL, ?, NULL)`,
  );
  for (let attempt = 1; attempt <= CLAIM_BUSY_MAX_ATTEMPTS; attempt++) {
    try {
      statement.run(
        params.channelId,
        params.agentPrincipalId,
        params.channelSeq,
        params.triggerEventId,
        params.nowIso,
      );
      return true;
    } catch (error) {
      const code = sqliteErrorCode(error);
      if (isDuplicateClaimError(code)) {
        // This exact triple was already claimed. Preserve durable idempotency.
        return false;
      }
      if (isRetryableClaimError(code) && attempt < CLAIM_BUSY_MAX_ATTEMPTS) {
        waitForClaimRetry(attempt);
        continue;
      }
      // Never convert operational corruption/locking into "already claimed",
      // and never surface the raw SQLite message (it may contain SQL/data).
      throw new AgentTurnClaimError(code);
    }
  }
  throw new AgentTurnClaimError('UNKNOWN');
}

/** Attach the dispatch_request_id once the gateway has minted the
 *  GatewayRequest for a claimed turn -- so the boot-time sweep can find and
 *  correlate it, and a future observer can tell WHICH task a stranded row
 *  belongs to. Best-effort: if this write fails the turn is still claimed
 *  (dispatched), just without a task correlator -- the sweep still recovers
 *  it by re-dispatch. */
export function attachDispatchRequestId(
  db: AutoreplyDb,
  params: { channelId: string; agentPrincipalId: string; channelSeq: number; dispatchRequestId: string },
): void {
  db.prepare(
    `UPDATE collab_agent_turns SET dispatch_request_id = ?
      WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ? AND state = 'dispatched'`,
  ).run(params.dispatchRequestId, params.channelId, params.agentPrincipalId, params.channelSeq);
}

/**
 * Resolve a claimed turn to its terminal state. 'completed' (the turn
 * posted at least one message), 'no_post' (the turn ran and legitimately
 * produced no post -- A3-f, a first-class documented outcome), or
 * 'terminated' (the branch was ended by the gateway -- membership removed
 * mid-turn, S-6, never left to model judgment).
 *
 * Idempotent by WHERE state='dispatched': a second resolve attempt on an
 * already-resolved row is a no-op (0 rows changed), never overwrites a
 * terminal state.
 *
 * B-6 (G1D PRD-007 S7/T4 packet, 2026-08-22): `leaseToken`, when provided,
 * additionally predicates on `AND recovery_lease_token IS ?` -- the exact
 * fencing style `commitAgentTurnOutput` already uses at store.ts:2545
 * (`IS` rather than `=` so a NULL lease on a never-reclaimed row compares
 * correctly). This closes the same race `commitAgentTurnOutput` closes for
 * output binding: a STALE executor from before a restart must not be able
 * to resolve a turn a FRESH executor has since reclaimed with a new lease.
 * `leaseToken` stays optional -- omitted, the predicate is dropped and the
 * call resolves exactly as it always has -- because `resolveAgentTurn` is
 * also called from call sites with no lease concept at all (a fresh,
 * never-recovered dispatch in `dispatchOneTurn`/`runAgentTurn`, and
 * `packages/collab/src/cron.ts`'s scheduled-turn path), and none of those
 * callers, nor this function's existing test callers, are in scope for
 * this change. Making it mandatory would force edits to every one of those
 * call sites plus `packages/collab/src/index.ts`'s export surface, none of
 * which this bounded correction is authorized to touch.
 *
 * Returns the number of rows actually changed (0 or 1) so a caller on the
 * recovery path can assert real ownership instead of assuming success from
 * a void return -- the same discipline `commitAgentTurnOutput` already
 * applies to its own `changes` check.
 */
export function resolveAgentTurn(
  db: AutoreplyDb,
  params: { channelId: string; agentPrincipalId: string; channelSeq: number; state: Exclude<AgentTurnState, 'dispatched'>; nowIso: string; leaseToken?: string },
): number {
  const info = params.leaseToken !== undefined
    ? db.prepare(
        `UPDATE collab_agent_turns SET state = ?, resolved_at = ?
          WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ? AND state = 'dispatched'
            AND recovery_lease_token IS ?`,
      ).run(
        params.state,
        params.nowIso,
        params.channelId,
        params.agentPrincipalId,
        params.channelSeq,
        params.leaseToken,
      ) as { changes: number | bigint }
    : db.prepare(
        `UPDATE collab_agent_turns SET state = ?, resolved_at = ?
          WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ? AND state = 'dispatched'`,
      ).run(params.state, params.nowIso, params.channelId, params.agentPrincipalId, params.channelSeq) as {
        changes: number | bigint;
      };
  return Number(info.changes);
}

export type StrandedTurn = {
  channelId: string;
  agentPrincipalId: string;
  channelSeq: number;
  triggerEventId: string;
  dispatchRequestId: string | null;
  dispatchedAt: string;
};

export type AgentTurnRecoveryLease = {
  leaseToken: string;
  attempt: number;
};

export type AgentTurnOutputBinding = {
  eventId: string;
  outputKind: 'tool' | 'fallback';
};

export function getAgentTurnOutput(
  db: AutoreplyDb,
  params: { channelId: string; agentPrincipalId: string; channelSeq: number; dispatchRequestId: string },
): AgentTurnOutputBinding | null {
  const row = db.prepare(`
    SELECT output_event_id AS eventId, output_kind AS outputKind
      FROM collab_agent_turns
     WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?
       AND dispatch_request_id = ? AND output_event_id IS NOT NULL
  `).get(
    params.channelId,
    params.agentPrincipalId,
    params.channelSeq,
    params.dispatchRequestId,
  ) as AgentTurnOutputBinding | undefined;
  return row ?? null;
}

/**
 * G1R B-3(b)'s required recovery: find every row still 'dispatched' whose
 * dispatched_at is older than `graceSeconds` (so an in-flight turn from
 * seconds ago is not mistaken for a crash). Reuses the
 * grantAdmission.ts::revokeInertGrants PATTERN -- an explicit sweep over a
 * durable row, not an inference from silence -- per G1R's direct
 * instruction to reuse rather than reinvent.
 *
 * The caller (autoReplyDispatcher.ts, gateway package) is responsible for
 * acting on each stranded turn: re-dispatch it (bidirectional correctness,
 * A3-b part ii) rather than leaving it silently indistinguishable from
 * legitimate A3-f silence.
 */
export function findStrandedAgentTurns(
  db: AutoreplyDb,
  nowIso: string,
  graceSeconds: number,
): StrandedTurn[] {
  const cutoff = new Date(Date.parse(nowIso) - graceSeconds * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT channel_id AS channelId, agent_principal_id AS agentPrincipalId, channel_seq AS channelSeq,
              trigger_event_id AS triggerEventId, dispatch_request_id AS dispatchRequestId,
              dispatched_at AS dispatchedAt
         FROM collab_agent_turns
        WHERE state = 'dispatched' AND dispatched_at <= ?`,
    )
    .all(cutoff) as StrandedTurn[];
  return rows;
}

/**
 * Re-claim a stranded turn for redispatch: flip it back to a fresh
 * 'dispatched' row (updating dispatched_at) ONLY if it is still in
 * 'dispatched' state -- guards against a race where the original turn
 * actually completes between the sweep's SELECT and this UPDATE (the
 * WHERE state='dispatched' clause is the same optimistic-concurrency
 * discipline admitToolCall's consume-UPDATE uses).
 */
export function reclaimStrandedAgentTurn(
  db: AutoreplyDb,
  params: {
    channelId: string;
    agentPrincipalId: string;
    channelSeq: number;
    nowIso: string;
    expectedDispatchedAt?: string;
    leaseToken?: string;
  },
): AgentTurnRecoveryLease | null {
  if (!params.expectedDispatchedAt) return null;
  const leaseToken = params.leaseToken ?? randomUUID();
  const info = db
    .prepare(
      `UPDATE collab_agent_turns
          SET dispatched_at = ?,
              recovery_attempt = recovery_attempt + 1,
              recovery_lease_token = ?
        WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?
          AND state = 'dispatched' AND dispatched_at = ?`,
    )
    .run(
      params.nowIso,
      leaseToken,
      params.channelId,
      params.agentPrincipalId,
      params.channelSeq,
      params.expectedDispatchedAt,
    ) as { changes: number | bigint };
  if (Number(info.changes) !== 1) return null;
  const row = db.prepare(
    `SELECT recovery_attempt AS attempt FROM collab_agent_turns
      WHERE channel_id = ? AND agent_principal_id = ? AND channel_seq = ?
        AND recovery_lease_token = ?`,
  ).get(params.channelId, params.agentPrincipalId, params.channelSeq, leaseToken) as
    | { attempt: number }
    | undefined;
  return row ? { leaseToken, attempt: row.attempt } : null;
}

/**
 * STOP (R-3a). Checked by the dispatcher BEFORE every new dispatch --
 * never inside an in-flight turn (G1R N-2: in-flight turns complete; their
 * posts do not re-trigger, because the NEXT dispatch attempt is what this
 * function gates).
 */
export function isAutoreplyStopped(db: AutoreplyDb, channelId: string): boolean {
  const globalRow = db
    .prepare(`SELECT 1 FROM collab_autoreply_stop WHERE scope = 'global'`)
    .get();
  if (globalRow) return true;
  const channelRow = db
    .prepare(`SELECT 1 FROM collab_autoreply_stop WHERE scope = 'channel' AND channel_id = ?`)
    .get(channelId);
  return channelRow !== undefined;
}

/**
 * Set STOP. Idempotent (INSERT OR IGNORE on the unique scope index): a
 * second STOP while already stopped is a no-op, never an error.
 *
 * Corollary C's sibling for STOP: this function's only caller must be the
 * gateway-side command handler for an OPERATOR-issued command (S3's own
 * wire command, gated the same as POST_CHANNEL_MESSAGE's seat lattice) --
 * it is never reachable from a collab tool or message content. No tool in
 * collabAgentTools.ts calls this.
 */
export function setAutoreplyStop(
  db: AutoreplyDb,
  params: { scope: 'global' | 'channel'; channelId: string | null; stoppedByPrincipalId: string; nowIso: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO collab_autoreply_stop(scope, channel_id, stopped_by_principal_id, stopped_at)
     VALUES (?, ?, ?, ?)`,
  ).run(params.scope, params.channelId, params.stoppedByPrincipalId, params.nowIso);
}

/** Clear STOP for one scope. */
export function clearAutoreplyStop(db: AutoreplyDb, scope: 'global' | 'channel', channelId: string | null): void {
  if (scope === 'global') {
    db.prepare(`DELETE FROM collab_autoreply_stop WHERE scope = 'global'`).run();
  } else {
    db.prepare(`DELETE FROM collab_autoreply_stop WHERE scope = 'channel' AND channel_id = ?`).run(channelId);
  }
}
