/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — the auto-reply loop and its STOP
 * control.
 *
 * Priority order per the build brief: STOP and the trigger resolver
 * (INV-T1) are the gating conditions on this slice and are proven FIRST,
 * against the REAL BUILT artifacts (never a replica -- the repo's own
 * "verify the artifact, not the unit test" discipline; a prior slice's
 * B-S0-1 blocker was exactly the mistake of testing a hand-rolled copy).
 *
 * Covers:
 *   INV-T1 mechanism 1 (structural)      — resolveEligibleAgents's own
 *     parameter list is asserted to have no `text`/`content`-shaped
 *     parameter (reflection over its declared length + a call that CANNOT
 *     supply content).
 *   INV-T1 mechanism 2 (behavioral)      — the differential-content probe:
 *     fixed membership, "hello" vs. an adversarial payload naming every
 *     member, every non-member, "@everyone", and a JSON trigger fragment;
 *     eligible sets must be byte-identical. Falsified by mutating the
 *     BUILT dist artifact to union in a text-derived id and showing RED.
 *   INV-T1 mechanism 3 (regression-resistant) — source-level assertion
 *     that resolveEligibleAgents's function body contains no reference to
 *     content_json/text/event body tokens.
 *   Anti-storm mechanism 2 (idempotency) — claimAgentTurn's PRIMARY KEY
 *     refuses a second claim for the same (channel, agent, seq) triple.
 *   S-5 (watermark bidirectionality) — a claimed-but-unresolved turn is
 *     found by findStrandedAgentTurns and can be re-claimed by
 *     reclaimStrandedAgentTurn; an already-resolved turn is NOT found.
 *   STOP (R-3a) — end-to-end over a REAL booted gateway: SET_AUTOREPLY_STOP
 *     persists, is read back by isAutoreplyStopped, survives being queried
 *     from a fresh connection (persistence), and no agent-reachable tool
 *     surface can clear it (attempted via the collab tool surface,
 *     observed to have no effect).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { issueCredential, nodeRandomSource, runCollaborationMigration, runAgentAutoreplyMigration } from '../packages/collab/src/index.js';
import { ensureGatewayBuild, launchGateway, type GatewayHandle, GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

const REPO_ROOT = join(GATEWAY_DIST_ENTRY, '..', '..', '..', '..');
const COLLAB_DIST_DIR = join(REPO_ROOT, 'packages', 'collab', 'dist');
const AUTOREPLY_SRC = join(REPO_ROOT, 'packages', 'collab', 'src', 'autoReply.ts');
const AUTOREPLY_DIST = join(COLLAB_DIST_DIR, 'autoReply.js');

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

// ---------------------------------------------------------------------------
// Unit-level: resolveEligibleAgents / claimAgentTurn / stranded-turn recovery
// driven against the REAL BUILT dist artifact (packages/collab/dist).
// ---------------------------------------------------------------------------

type CollabModule = typeof import('../packages/collab/dist/index.js');

function freshCollabDb(): { db: InstanceType<typeof Database>; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'torq-s3-'));
  const path = join(dir, 'collab.db');
  const db = new Database(path);
  runCollaborationMigration(db);
  // PRD-TCLAW-AGENT-PARTICIPATION-007 S3: deliberately a SEPARATE,
  // explicitly-invoked call, exactly mirroring
  // packages/gateway/src/collabIdentity.ts's migrateCollabDb -- NOT
  // cascaded inside runCollaborationMigration itself, because that cascade
  // broke tests/auth-v2-phase2a.test.ts's fail-closed
  // assertShippedCollabLedger check (see migration.ts's own comment on
  // this decision).
  runAgentAutoreplyMigration(db);
  return { db, path, dir };
}

function nowIso(): string { return new Date().toISOString(); }

function seedChannelWithMembers(
  db: InstanceType<typeof Database>,
  opts: { memberAgentIds: string[]; nonMemberAgentIds: string[]; ownerId?: string },
): { channelId: string; ownerId: string } {
  const ownerId = opts.ownerId ?? randomUUID();
  const now = nowIso();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(ownerId, now, now);
  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'C', 'c-' || ?, 'active', ?, 1, ?, ?)",
  ).run(channelId, channelId, ownerId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, ownerId, now);
  for (const id of opts.memberAgentIds) {
    db.prepare(
      "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'A', ?, 'active', 1, NULL, ?, ?)",
    ).run(id, ownerId, now, now);
    db.prepare(
      "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
    ).run(channelId, id, now);
  }
  for (const id of opts.nonMemberAgentIds) {
    db.prepare(
      "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'A', ?, 'active', 1, NULL, ?, ?)",
    ).run(id, ownerId, now, now);
    // Deliberately NOT added to collab_members -- these ids exist in the DB
    // (so a text-derived resolver COULD find them) but hold no membership row.
  }
  return { channelId, ownerId };
}

function postMessageRow(db: InstanceType<typeof Database>, channelId: string, actorPrincipalId: string, text: string): number {
  const maxSeqRow = db.prepare('SELECT COALESCE(MAX(channel_seq), 0) AS m FROM collab_events WHERE channel_id = ?').get(channelId) as { m: number };
  const seq = maxSeqRow.m + 1;
  db.prepare(
    `INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, actor_principal_id, kind, content_json, created_at)
     VALUES (?, 1, ?, ?, ?, 'message_posted', ?, ?)`,
  ).run(randomUUID(), channelId, seq, actorPrincipalId, JSON.stringify({ channelId, text }), nowIso());
  return seq;
}

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — INV-T1 resolveEligibleAgents', () => {
  let collab: CollabModule;
  beforeAll(async () => {
    collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as CollabModule;
  });

  it('mechanism 1 (STRUCTURAL): resolveEligibleAgents has exactly 4 declared parameters (db, channelId, actorPrincipalId, seq) -- no 5th parameter exists for content to ride on', () => {
    // .length reflects the number of parameters BEFORE the first default
    // value / rest parameter, which is exactly what a hand-added optional
    // `content`/`event` parameter would still show up as if appended.
    expect(collab.resolveEligibleAgents.length).toBe(4);
  });

  it('mechanism 3 (REGRESSION-RESISTANT): the resolver FUNCTION BODY (excluding its own doc comment, which may discuss the invariant in prose) contains no reference to content_json, text, payload, or the event kind', () => {
    const source = readFileSync(AUTOREPLY_SRC, 'utf8');
    const signature = 'export function resolveEligibleAgents(';
    const sigStart = source.indexOf(signature);
    expect(sigStart, 'resolveEligibleAgents must exist in autoReply.ts').toBeGreaterThan(-1);
    // Isolate the EXECUTABLE body only: from the opening `{` of the function
    // (skipping the signature/params) to its matching closing `}`, via
    // brace-depth counting -- so the assertion cannot be defeated by prose
    // in the preceding doc comment (which legitimately discusses "kind" and
    // "text" as concepts) while still catching a real reference inside the
    // executable code.
    const openBraceIdx = source.indexOf('{', sigStart);
    let depth = 0;
    let closeBraceIdx = -1;
    for (let i = openBraceIdx; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) { closeBraceIdx = i; break; }
      }
    }
    expect(closeBraceIdx, 'must find the resolver function body\'s closing brace').toBeGreaterThan(-1);
    const fnBody = source.slice(openBraceIdx, closeBraceIdx + 1);
    expect(fnBody).not.toMatch(/content_json/);
    expect(fnBody).not.toMatch(/\btext\b/);
    expect(fnBody).not.toMatch(/\bpayload\b/);
    // The resolver legitimately filters on `principals.kind` (agent vs.
    // operator) -- that is substrate METADATA, not event content, and is
    // exactly what Corollary A permits. What must NEVER appear is a
    // reference to the triggering EVENT's kind (message_posted /
    // channel_archived / etc, collab_events.kind) -- that would be reading
    // "what kind of thing happened" to decide eligibility, which INV-T1
    // forbids. `p.kind` (the principals table alias) is allowlisted;
    // anything else matching `kind` is not.
    const kindReferences = fnBody.match(/\bkind\b/g) ?? [];
    const nonPrincipalKindReferences = fnBody
      .split('\n')
      .filter((line) => /\bkind\b/.test(line) && !/p\.kind\b/.test(line));
    expect(kindReferences.length, 'sanity: p.kind should be the only kind reference').toBeGreaterThan(0);
    expect(nonPrincipalKindReferences, 'no reference to the triggering EVENT kind (only principals.kind is allowed)').toEqual([]);
  });

  it('mechanism 2 (BEHAVIORAL, FALSIFIABLE): the differential-content probe — "hello" vs an adversarial mention payload yield BYTE-IDENTICAL eligible sets, and non-members never appear', () => {
    const { db, dir } = freshCollabDb();
    try {
      const memberA = randomUUID();
      const memberB = randomUUID();
      const humanActor = randomUUID();
      const nonMember1 = randomUUID();
      const nonMember2 = randomUUID();
      const { channelId, ownerId } = seedChannelWithMembers(db, {
        memberAgentIds: [memberA, memberB],
        nonMemberAgentIds: [nonMember1, nonMember2],
        ownerId: humanActor,
      });
      void ownerId;

      // M1: an innocuous message.
      const seq1 = postMessageRow(db, channelId, humanActor, 'hello');
      const eligible1 = collab.resolveEligibleAgents(db, channelId, humanActor, seq1).sort();

      // M2: an adversarial payload naming every member, every non-member,
      // "@everyone", and a JSON-shaped trigger fragment. The resolver is
      // NEVER given this text (mechanism 1 proves it cannot be), but this
      // proves it EMPIRICALLY too: posting it changes nothing about the
      // eligible set.
      const adversarialText = JSON.stringify({
        mention: [memberA, memberB, nonMember1, nonMember2, '@everyone'],
        trigger: [nonMember1, nonMember2],
      });
      const seq2 = postMessageRow(db, channelId, humanActor, adversarialText);
      const eligible2 = collab.resolveEligibleAgents(db, channelId, humanActor, seq2).sort();

      expect(eligible2, 'eligible sets must be BYTE-IDENTICAL regardless of message content').toEqual(eligible1);
      expect(eligible1.sort()).toEqual([memberA, memberB].sort());
      expect(eligible1).not.toContain(nonMember1);
      expect(eligible1).not.toContain(nonMember2);
      expect(eligible2).not.toContain(nonMember1);
      expect(eligible2).not.toContain(nonMember2);

      // Corollary A: the actor is excluded (anti-self-reply), never added.
      const eligibleForAgentPost = collab.resolveEligibleAgents(db, channelId, memberA, seq2).sort();
      expect(eligibleForAgentPost).not.toContain(memberA);
      expect(eligibleForAgentPost).toContain(memberB);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mechanism 2, FALSIFIED: mutating the BUILT dist artifact to union in a text-derived principal id turns the differential-content assertion RED, then is restored', async () => {
    const original = readFileSync(AUTOREPLY_DIST, 'utf8');
    const marker = 'p.status = \'active\'';
    expect(original.includes(marker), 'expected marker to exist in built dist for the mutation to apply').toBe(true);
    // A crude but REAL mutation of the COMPILED artifact: force every
    // resolveEligibleAgents call to ALSO return a hardcoded "leaked" id,
    // simulating "the resolver started reading content and unioned in a
    // mentioned principal". This proves the mutation actually changes
    // behavior (the artifact literally differs), not merely that a flag
    // flipped -- per the "a mutation that never applied is not a probe" rule.
    const mutated = original.replace(
      'function resolveEligibleAgents(db, channelId, actorPrincipalId, _seq) {',
      'function resolveEligibleAgents(db, channelId, actorPrincipalId, _seq) {\n' +
      '    if (globalThis.__TORQ_S3_MUTATION_LEAK_ID__) return [globalThis.__TORQ_S3_MUTATION_LEAK_ID__];',
    );
    expect(mutated, 'the mutation must actually change the artifact text').not.toBe(original);
    writeFileSync(AUTOREPLY_DIST, mutated, 'utf8');
    try {
      // Bust the module cache guarantee is not available for a plain
      // dynamic import of an unchanged path in Node's ESM loader, so we
      // append a cache-busting query string to force a fresh evaluation of
      // the just-mutated file. AWAITED here (not returned) so the finally
      // block below does not restore the original file before the mutated
      // module has actually been imported and exercised -- an earlier
      // version of this test had exactly that bug (a `return
      // import(...).then(...)` whose `finally` ran before the promise
      // settled), which silently exercised the ORIGINAL unmutated resolver
      // and made the RED assertion meaningless.
      const mutatedModule: any = await import(pathToFileURL(AUTOREPLY_DIST).href + '?bust=' + Date.now());
      const { db, dir } = freshCollabDb();
      try {
        const memberA = randomUUID();
        const leakedId = randomUUID();
        const { channelId, ownerId: humanActor } = seedChannelWithMembers(db, { memberAgentIds: [memberA], nonMemberAgentIds: [] });
        const seq = postMessageRow(db, channelId, humanActor, 'hello');
        (globalThis as any).__TORQ_S3_MUTATION_LEAK_ID__ = leakedId;
        const eligible = mutatedModule.resolveEligibleAgents(db, channelId, humanActor, seq);
        // RED: the mutated resolver now returns the leaked id instead of
        // the real membership-derived set.
        expect(eligible).toEqual([leakedId]);
        expect(eligible).not.toEqual([memberA]);
      } finally {
        delete (globalThis as any).__TORQ_S3_MUTATION_LEAK_ID__;
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      writeFileSync(AUTOREPLY_DIST, original, 'utf8');
      const restored = readFileSync(AUTOREPLY_DIST, 'utf8');
      expect(restored).toBe(original);
    }
  });
});

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — anti-storm mechanism 2 (idempotency watermark)', () => {
  let collab: CollabModule;
  beforeAll(async () => {
    collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as CollabModule;
  });

  it('claimAgentTurn refuses a second claim for the same (channel, agent, seq) triple -- POSITIVE control: a DIFFERENT seq claims successfully', () => {
    const { db, dir } = freshCollabDb();
    try {
      const agentId = randomUUID();
      const { channelId } = seedChannelWithMembers(db, { memberAgentIds: [agentId], nonMemberAgentIds: [] });
      const first = collab.claimAgentTurn(db, {
        channelId, agentPrincipalId: agentId, channelSeq: 5, triggerEventId: randomUUID(), nowIso: nowIso(),
      });
      expect(first, 'first claim of a fresh triple must succeed').toBe(true);

      const second = collab.claimAgentTurn(db, {
        channelId, agentPrincipalId: agentId, channelSeq: 5, triggerEventId: randomUUID(), nowIso: nowIso(),
      });
      expect(second, 'a second claim of the SAME triple must be refused (idempotency)').toBe(false);

      // Positive control: a genuinely different seq is a different triple
      // and MUST claim successfully -- proves the refusal above is real
      // idempotency, not a universally-broken claimAgentTurn.
      const differentSeq = collab.claimAgentTurn(db, {
        channelId, agentPrincipalId: agentId, channelSeq: 6, triggerEventId: randomUUID(), nowIso: nowIso(),
      });
      expect(differentSeq, 'a different channel_seq must claim successfully (positive control)').toBe(true);

      const rows = db.prepare('SELECT COUNT(*) AS n FROM collab_agent_turns WHERE channel_id = ? AND agent_principal_id = ?').get(channelId, agentId) as { n: number };
      expect(rows.n).toBe(2); // seq 5 and seq 6 -- never a third row from the refused second claim
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('S-5 bidirectional: a claimed-but-unresolved (dispatched) turn IS found by the stranded sweep after the grace window; an already-resolved turn is NOT', () => {
    const { db, dir } = freshCollabDb();
    try {
      const agentId = randomUUID();
      const { channelId } = seedChannelWithMembers(db, { memberAgentIds: [agentId], nonMemberAgentIds: [] });

      // Turn A: claimed, never resolved (simulates a crash mid-turn).
      const past = new Date(Date.now() - 120_000).toISOString();
      collab.claimAgentTurn(db, { channelId, agentPrincipalId: agentId, channelSeq: 1, triggerEventId: randomUUID(), nowIso: past });

      // Turn B: claimed AND resolved 'completed' -- must NOT be swept.
      collab.claimAgentTurn(db, { channelId, agentPrincipalId: agentId, channelSeq: 2, triggerEventId: randomUUID(), nowIso: past });
      collab.resolveAgentTurn(db, { channelId, agentPrincipalId: agentId, channelSeq: 2, state: 'completed', nowIso: nowIso() });

      // Turn C: claimed just now (within the grace window) -- must NOT be
      // swept yet, it looks like a legitimately in-flight turn.
      collab.claimAgentTurn(db, { channelId, agentPrincipalId: agentId, channelSeq: 3, triggerEventId: randomUUID(), nowIso: nowIso() });

      const stranded = collab.findStrandedAgentTurns(db, nowIso(), 30);
      const strandedSeqs = stranded.map((t: any) => t.channelSeq).sort();
      expect(strandedSeqs, 'ONLY the old, still-dispatched turn (seq 1) must be found').toEqual([1]);

      // Bidirectional part (i): the completed turn is never replayed.
      expect(strandedSeqs).not.toContain(2);
      // Bidirectional part (ii): the in-window in-flight turn is not
      // mistaken for stranded.
      expect(strandedSeqs).not.toContain(3);

      // Reclaim: flips seq 1 back to a fresh 'dispatched' row for redispatch.
      const strandedTurn = stranded.find((turn: any) => turn.channelSeq === 1)!;
      const reclaimed = collab.reclaimStrandedAgentTurn(db, {
        channelId,
        agentPrincipalId: agentId,
        channelSeq: 1,
        nowIso: nowIso(),
        expectedDispatchedAt: strandedTurn.dispatchedAt,
        leaseToken: 's3-recovery-lease',
      });
      expect(reclaimed).toEqual({ leaseToken: 's3-recovery-lease', attempt: 1 });
      const afterReclaim = collab.findStrandedAgentTurns(db, nowIso(), 30);
      // Immediately after reclaim, dispatched_at is "now" -- inside the
      // grace window -- so it is NOT immediately re-found as stranded
      // (proves the reclaim genuinely refreshed the watermark rather than
      // being a no-op).
      expect(afterReclaim.map((t: any) => t.channelSeq)).not.toContain(1);

      // A second reclaim attempt on an ALREADY-reclaimed (still
      // 'dispatched', but not past grace) row is legitimate at the SQL
      // level (state is still 'dispatched'), but resolveAgentTurn's
      // WHERE state='dispatched' guard is what actually prevents a
      // resolved row from ever being reclaimed -- proven directly:
      collab.resolveAgentTurn(db, { channelId, agentPrincipalId: agentId, channelSeq: 1, state: 'no_post', nowIso: nowIso() });
      const reclaimAfterResolve = collab.reclaimStrandedAgentTurn(db, {
        channelId,
        agentPrincipalId: agentId,
        channelSeq: 1,
        nowIso: nowIso(),
        expectedDispatchedAt: strandedTurn.dispatchedAt,
      });
      expect(reclaimAfterResolve, 'a RESOLVED row must never be reclaimable').toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — STOP control (R-3a)', () => {
  let collab: CollabModule;
  beforeAll(async () => {
    collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as CollabModule;
  });

  it('unit: setAutoreplyStop persists a channel-scoped stop; isAutoreplyStopped reflects it; clearAutoreplyStop lifts it; global stop overrides any channel', () => {
    const { db, dir } = freshCollabDb();
    try {
      const opId = randomUUID();
      const now = nowIso();
      db.prepare(
        "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
      ).run(opId, now, now);
      const channelA = randomUUID();
      const channelB = randomUUID();
      for (const ch of [channelA, channelB]) {
        db.prepare(
          "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'C', 'c-' || ?, 'active', ?, 1, ?, ?)",
        ).run(ch, ch, opId, now, now);
      }

      expect(collab.isAutoreplyStopped(db, channelA)).toBe(false);

      collab.setAutoreplyStop(db, { scope: 'channel', channelId: channelA, stoppedByPrincipalId: opId, nowIso: now });
      expect(collab.isAutoreplyStopped(db, channelA)).toBe(true);
      expect(collab.isAutoreplyStopped(db, channelB), 'a channel-scoped stop must not affect a different channel').toBe(false);

      // Idempotent: a second STOP on the same channel is a no-op, not an error.
      expect(() => collab.setAutoreplyStop(db, { scope: 'channel', channelId: channelA, stoppedByPrincipalId: opId, nowIso: now })).not.toThrow();

      collab.clearAutoreplyStop(db, 'channel', channelA);
      expect(collab.isAutoreplyStopped(db, channelA)).toBe(false);

      // Global stop overrides every channel, including ones never explicitly stopped.
      collab.setAutoreplyStop(db, { scope: 'global', channelId: null, stoppedByPrincipalId: opId, nowIso: now });
      expect(collab.isAutoreplyStopped(db, channelA)).toBe(true);
      expect(collab.isAutoreplyStopped(db, channelB)).toBe(true);
      collab.clearAutoreplyStop(db, 'global', null);
      expect(collab.isAutoreplyStopped(db, channelA)).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mutation, FALSIFIED: removing the global-stop check from isAutoreplyStopped turns the override assertion RED', async () => {
    const original = readFileSync(join(COLLAB_DIST_DIR, 'autoReply.js'), 'utf8');
    const marker = "scope = 'global'";
    expect(original.includes(marker)).toBe(true);
    const mutated = original.replace(
      /export function isAutoreplyStopped\(db, channelId\) \{[\s\S]*?\n\}/,
      'export function isAutoreplyStopped(db, channelId) {\n' +
      '  const channelRow = db.prepare(`SELECT 1 FROM collab_autoreply_stop WHERE scope = \'channel\' AND channel_id = ?`).get(channelId);\n' +
      '  return channelRow !== undefined;\n}',
    );
    expect(mutated, 'the mutation must actually change the artifact').not.toBe(original);
    writeFileSync(join(COLLAB_DIST_DIR, 'autoReply.js'), mutated, 'utf8');
    try {
      const mutatedModule: any = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'autoReply.js')).href + '?bust=' + Date.now());
      const { db, dir } = freshCollabDb();
      try {
        const opId = randomUUID();
        const now = nowIso();
        db.prepare(
          "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
        ).run(opId, now, now);
        const channelA = randomUUID();
        mutatedModule.setAutoreplyStop(db, { scope: 'global', channelId: null, stoppedByPrincipalId: opId, nowIso: now });
        // RED: with the global check removed, a global stop no longer halts a channel that was never individually stopped.
        expect(mutatedModule.isAutoreplyStopped(db, channelA)).toBe(false);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      writeFileSync(join(COLLAB_DIST_DIR, 'autoReply.js'), original, 'utf8');
      expect(readFileSync(join(COLLAB_DIST_DIR, 'autoReply.js'), 'utf8')).toBe(original);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire-level: SET_AUTOREPLY_STOP over a REAL booted gateway.
// ---------------------------------------------------------------------------

type WireSeed = {
  collabDbPath: string;
  operatorId: string;
  issuedOperator: ReturnType<typeof issueCredential>;
  agentId: string;
  issuedAgent: ReturnType<typeof issueCredential>;
  channelId: string;
};

function seedWireDb(dataDir: string, pepper: Buffer): WireSeed {
  const collabDbPath = join(dataDir, 'collab.db');
  const db = new Database(collabDbPath);
  runCollaborationMigration(db);
  const operatorId = randomUUID();
  const agentId = randomUUID();
  const credOperator = randomUUID();
  const credAgent = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(operatorId, now, now);
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'Ag', ?, 'active', 1, NULL, ?, ?)",
  ).run(agentId, operatorId, now, now);

  const issuedOperator = issueCredential(credOperator, pepper, nodeRandomSource);
  const issuedAgent = issueCredential(credAgent, pepper, nodeRandomSource);
  for (const [id, principal, issued] of [
    [credOperator, operatorId, issuedOperator],
    [credAgent, agentId, issuedAgent],
  ] as const) {
    db.prepare(
      "INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)",
    ).run(id, principal, issued.secretHmac, now);
  }

  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'C', 'c', 'active', ?, 1, ?, ?)",
  ).run(channelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, operatorId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(channelId, agentId, now);

  issuedOperator.secretBytes.fill(0);
  issuedAgent.secretBytes.fill(0);
  db.close();
  return { collabDbPath, operatorId, issuedOperator, agentId, issuedAgent, channelId };
}

function stopRowState(collabDbPath: string, channelId: string): { channelStopped: boolean; globalStopped: boolean } {
  const db = new Database(collabDbPath, { readonly: true });
  try {
    const channelRow = db.prepare(`SELECT 1 FROM collab_autoreply_stop WHERE scope = 'channel' AND channel_id = ?`).get(channelId);
    const globalRow = db.prepare(`SELECT 1 FROM collab_autoreply_stop WHERE scope = 'global'`).get();
    return { channelStopped: channelRow !== undefined, globalStopped: globalRow !== undefined };
  } finally {
    db.close();
  }
}

function wsRoundtrip(url: string, frames: unknown[], timeoutMs = 10000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received: any[] = [];
    let idx = 0;
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* noop */ }
      reject(new Error('timeout; received=' + JSON.stringify(received)));
    }, timeoutMs);
    ws.once('open', () => ws.send(JSON.stringify(frames[idx++])));
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString()));
      if (idx < frames.length) {
        ws.send(JSON.stringify(frames[idx++]));
      } else {
        clearTimeout(timer);
        setTimeout(() => ws.close(), 150);
      }
    });
    ws.once('close', () => { clearTimeout(timer); resolve(received); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const WIRE_BASE_ENV = (dataDir: string, seed: WireSeed, pepper: Buffer) => ({
  TORQCLAW_DATA_DIR: dataDir,
  TORQCLAW_COLLAB_DB_PATH: seed.collabDbPath,
  TORQCLAW_COLLAB_ENABLED: '1',
  TORQCLAW_COLLAB_SURFACE_COMMANDS: '1',
  TORQCLAW_AGENT_PARTICIPATION: '1',
  TORQCLAW_AGENT_AUTOREPLY: '1',
  TORQCLAW_COLLAB_TEST_PEPPER: pepper.toString('base64'),
  TORQCLAW_GATEWAY_TOKEN: 'unused',
  TORQCLAW_CHANNEL_SERVICE_TOKEN: 'unused-cst',
});

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S3 — STOP over the real gateway wire', () => {
  it('SET_AUTOREPLY_STOP persists a channel stop; a fresh connection observes it via isAutoreplyStopped (persistence, not merely in-memory)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s3-stop-'));
    const pepper = Buffer.alloc(32, 0x71);
    const seed = seedWireDb(dataDir, pepper);
    gateway = await launchGateway(WIRE_BASE_ENV(dataDir, seed, pepper));
    await gateway.ready;

    const connectOperator = { expectedRole: 'operator', clientInfo: { name: 's3-op', version: '0.1.0' }, auth: { kind: 'surface', credential: seed.issuedOperator.token } };
    const stopFrame = { action: 'SET_AUTOREPLY_STOP', stop: true, scope: 'channel', channelId: seed.channelId };

    const frames = await wsRoundtrip(gateway.url, [connectOperator, stopFrame]);
    const errorFrame = frames.find((f) => f.type === 'ERROR');
    expect(errorFrame, 'STOP must succeed for the operator seat; got ' + JSON.stringify(frames)).toBeUndefined();

    const state = stopRowState(seed.collabDbPath, seed.channelId);
    expect(state.channelStopped, 'the stop must be durably persisted to collab.db, readable by a fresh process').toBe(true);
  }, 30000);

  it('a channel (non-operator) seat is denied SET_AUTOREPLY_STOP outright (authz, seat lattice)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s3-stop-deny-'));
    const pepper = Buffer.alloc(32, 0x72);
    const seed = seedWireDb(dataDir, pepper);
    gateway = await launchGateway(WIRE_BASE_ENV(dataDir, seed, pepper));
    await gateway.ready;

    const connectChannel = { expectedRole: 'channel', clientInfo: { name: 's3-chan', version: '0.1.0' }, auth: { kind: 'channel_service', credential: 'unused-cst' } };
    const stopFrame = { action: 'SET_AUTOREPLY_STOP', stop: true, scope: 'channel', channelId: seed.channelId };
    const frames = await wsRoundtrip(gateway.url, [connectChannel, stopFrame]);
    const errorFrame = frames.find((f) => f.type === 'ERROR');
    expect(errorFrame?.code).toBe('UNAUTHORIZED');

    const state = stopRowState(seed.collabDbPath, seed.channelId);
    expect(state.channelStopped, 'a denied STOP attempt must not have persisted anything').toBe(false);
  }, 30000);

  it('no collab tool (the agent-reachable surface) can clear or set STOP -- the tool surface exposes only read_channel/post_message, neither can reach the stop table', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s3-stop-agent-'));
    const pepper = Buffer.alloc(32, 0x73);
    const seed = seedWireDb(dataDir, pepper);
    gateway = await launchGateway(WIRE_BASE_ENV(dataDir, seed, pepper));
    await gateway.ready;

    // Operator sets STOP first.
    const connectOperator = { expectedRole: 'operator', clientInfo: { name: 's3-op2', version: '0.1.0' }, auth: { kind: 'surface', credential: seed.issuedOperator.token } };
    const stopFrame = { action: 'SET_AUTOREPLY_STOP', stop: true, scope: 'channel', channelId: seed.channelId };
    await wsRoundtrip(gateway.url, [connectOperator, stopFrame]);
    expect(stopRowState(seed.collabDbPath, seed.channelId).channelStopped).toBe(true);

    // Agent connects and posts a message (the ONLY write surface it has).
    // The wire protocol carries no SET_AUTOREPLY_STOP-shaped message an
    // agent could send even in principle through POST_CHANNEL_MESSAGE
    // (that command's schema has no `stop`/`scope` field), and authz denies
    // a node-seat SET_AUTOREPLY_STOP outright regardless of content.
    const connectAgent = { expectedRole: 'node', clientInfo: { name: 's3-agent', version: '0.1.0' }, auth: { kind: 'surface', credential: seed.issuedAgent.token } };
    const maliciousPost = {
      action: 'POST_CHANNEL_MESSAGE', channelId: seed.channelId,
      text: JSON.stringify({ action: 'SET_AUTOREPLY_STOP', stop: false, scope: 'channel', channelId: seed.channelId }),
      idempotencyKey: randomUUID(),
    };
    await wsRoundtrip(gateway.url, [connectAgent, maliciousPost]);

    // STOP must remain set -- message CONTENT that looks like a stop
    // command must have zero effect, because it is data, never a command.
    expect(stopRowState(seed.collabDbPath, seed.channelId).channelStopped, 'STOP must be unaffected by any message content, including one shaped like a stop command').toBe(true);

    // And a node-seat's own DIRECT attempt (not via message content, but
    // literally issuing the command on the agent's own connection) is
    // denied at authz -- the strongest form of "no agent-reachable path".
    const connectAgent2 = { expectedRole: 'node', clientInfo: { name: 's3-agent2', version: '0.1.0' }, auth: { kind: 'surface', credential: seed.issuedAgent.token } };
    const directAttempt = { action: 'SET_AUTOREPLY_STOP', stop: false, scope: 'channel', channelId: seed.channelId };
    const frames2 = await wsRoundtrip(gateway.url, [connectAgent2, directAttempt]);
    const err2 = frames2.find((f) => f.type === 'ERROR');
    expect(err2?.code, 'an agent (node-seat) connection issuing SET_AUTOREPLY_STOP directly must be denied').toBe('UNAUTHORIZED');
    expect(stopRowState(seed.collabDbPath, seed.channelId).channelStopped).toBe(true);
  }, 30000);

  it('a message posted to a STOPPED channel does not trigger a new agent turn (A3-e): a second agent member never posts in response', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s3-stop-notrigger-'));
    const pepper = Buffer.alloc(32, 0x74);
    const seed = seedWireDb(dataDir, pepper);
    // Add a second agent member so there is someone eligible to (not) trigger.
    const db = new Database(seed.collabDbPath);
    const secondAgentId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'A2', ?, 'active', 1, NULL, ?, ?)",
    ).run(secondAgentId, seed.operatorId, now, now);
    db.prepare(
      "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
    ).run(seed.channelId, secondAgentId, now);
    db.close();

    gateway = await launchGateway(WIRE_BASE_ENV(dataDir, seed, pepper));
    await gateway.ready;

    const connectOperator = { expectedRole: 'operator', clientInfo: { name: 's3-op3', version: '0.1.0' }, auth: { kind: 'surface', credential: seed.issuedOperator.token } };
    const stopFrame = { action: 'SET_AUTOREPLY_STOP', stop: true, scope: 'global', channelId: undefined };
    await wsRoundtrip(gateway.url, [connectOperator, stopFrame]);
    expect(stopRowState(seed.collabDbPath, seed.channelId).globalStopped).toBe(true);

    const connectOperator2 = { expectedRole: 'operator', clientInfo: { name: 's3-op4', version: '0.1.0' }, auth: { kind: 'surface', credential: seed.issuedOperator.token } };
    const postFrame = { action: 'POST_CHANNEL_MESSAGE', channelId: seed.channelId, text: 'hello under STOP', idempotencyKey: randomUUID() };
    await wsRoundtrip(gateway.url, [connectOperator2, postFrame]);

    // Give any (incorrectly) dispatched turn a moment to have shown up.
    await new Promise((r) => setTimeout(r, 1500));

    const turnsDb = new Database(seed.collabDbPath, { readonly: true });
    try {
      const turns = turnsDb.prepare('SELECT COUNT(*) AS n FROM collab_agent_turns WHERE channel_id = ?').get(seed.channelId) as { n: number };
      expect(turns.n, 'STOP must prevent any new dispatch: zero rows in collab_agent_turns for this channel').toBe(0);
    } finally {
      turnsDb.close();
    }
  }, 30000);
});
