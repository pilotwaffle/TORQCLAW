/**
 * G1D FABLE channels-live-defects packet (2026-08-24 v1.1 amendment) + G1R
 * Gate-1 verdict — T-1..T-8 + B-FOLLOWUP-1 rider.
 *
 * D-A (persona never reaches the local prompt) was WITHDRAWN by G1D's v1.1
 * amendment pending T-1, on G1R's finding that the packet measured the wrong
 * field (`payload.prompt`, which contractually EXCLUDES persona) rather than
 * the real system-role persona message. T-1/T-2 below re-derive that finding
 * directly from the real `executeLocalEdge` dispatch path (mocking only the
 * HTTP transport), independently of the packet's raw-`/api/chat` probe that
 * G1R found discriminated nothing.
 *
 * D-B (self-run collapse only fires on CONSECUTIVE self-posts, so it never
 * helps the real alternating operator<->agent shape) is respecified by G1R's
 * REQUIRED CORRECTION (a): the per-actor "last kept self-post" reference
 * SURVIVES interleaving (other actors' messages / non-message events no
 * longer reset it); collapse only fires on a near-duplicate hit against that
 * surviving reference. T-3..T-6 below pin this correction; T-3 is the
 * amputation-test guard (G1R F-2) that a naive window-wide Jaccard collapse
 * would fail.
 *
 * T-7 pins constant parity between this module's thresholds and the
 * dispatcher's inlined literals (autoReplyDispatcher.ts:781-782), read from
 * source text only — the dispatcher file itself is never imported for
 * mutation and is asserted byte-identical elsewhere (T-8 zero-diff proof,
 * see build-evidence.md).
 *
 * The rider (B-FOLLOWUP-1 / NB-3) is a seat-lattice pin for
 * ADD_CHANNEL_MEMBER/REMOVE_CHANNEL_MEMBER on the 'channel' and 'node' roles.
 * `tests/collab-channel-membership-wire.test.ts`'s "T-D5" suite already pins
 * the operator-role named-arm-vs-fail-open-tail distinction (which IS
 * black-box discriminable, because authorizeOperator has a fail-open tail to
 * diverge against) and asserts channel/node deny outcomes. What T-D5 does
 * NOT and CANNOT assert black-box is that the channel/node denials are
 * reached via the NAMED case arms specifically rather than the `default:`
 * arm — both return the exact same `DENY_NOT_PERMITTED` object, so deleting
 * the named arms for channel/node is BEHAVIORALLY SILENT (see the disclosure
 * below). What IS pinnable without editing authz.ts is a source-text
 * deletion-sensitivity check, in the same spirit as T-7's constant-parity
 * pin, plus the outcome-level channel/node denials themselves (already
 * covered by T-D5; re-asserted here for this packet's own traceability).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  runCollaborationMigration,
  runAgentAutoreplyMigration,
  runAgentRuntimeProfileMigration,
  runAgentRuntimeExternalContextMigration,
  runAgentPersonaMigration,
  runAgentPersonaRevisionMigration,
  runAgentTurnOutputMigration,
} from '../packages/collab/src/index.js';
import { ensureGatewayBuild, GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import { ClientCommandSchema } from '@torqclaw/contracts';
import { makeRequest } from './helpers.js';

const REPO_ROOT = join(GATEWAY_DIST_ENTRY, '..', '..', '..', '..');
const GATEWAY_DIST_DIR = join(REPO_ROOT, 'packages', 'gateway', 'dist');
const COLLAB_DIST_DIR = join(REPO_ROOT, 'packages', 'collab', 'dist');

beforeAll(async () => { await ensureGatewayBuild(); }, 200000);

function nowIso(): string { return new Date().toISOString(); }

// -----------------------------------------------------------------------
// T-1 / T-2 — persona reaches the local model as a dedicated system-role
// message; payload.prompt never carries persona content. Dedicated pin for
// this packet's own evidence traceability (the finding is independently
// proven by the pre-existing tests/local-inference-model-routing.test.ts
// test at line 102, which this does NOT duplicate assertion-by-assertion —
// it re-derives the same conclusion via a fresh, minimal dispatch).
// -----------------------------------------------------------------------
describe('T-1/T-2 — D-A closed as NOT-A-DEFECT: persona system message present, payload.prompt clean', () => {
  function personaEnvelope(content: string, personaRevision: number) {
    return {
      version: 1 as const,
      content,
      personaRevision,
      contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }

  it('T-1: a dispatched local auto-turn carries the persona directives in a role:system message', async () => {
    const fetchMock = (globalThis as any).__torqTestFetch ?? null;
    // Use a fresh fetch stub scoped to this test via vi-free manual stub to
    // avoid cross-file vi.stubGlobal leakage; import ollama fresh.
    const { vi } = await import('vitest');
    const mockFn = vi.fn(async () => new Response(JSON.stringify({
      message: { role: 'assistant', content: 'ok', tool_calls: [] },
      done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', mockFn);
    try {
      vi.resetModules();
      const { executeLocalEdge } = await import('../packages/inference/src/ollama.js');
      const request = makeRequest({ taskType: 'SUMMARIZATION', prompt: 'the operator asked a live question' });
      request.payload.localExecutionTarget = { providerId: 'ollama-local', adapterId: 'ollama-local', modelId: 'torq-ai-v5' };
      const AGENT_ID = 'collapse-t1-agent';
      request.payload.callerCollabPrincipalId = AGENT_ID;
      request.payload.agentPersonaEnvelope = personaEnvelope('You are a rigorous, terse Torq agent.', 7);
      request.payload.agentTurnContext = {
        channelId: 'collapse-t1-channel', channelSeq: 1, agentPrincipalId: AGENT_ID,
        triggerEventId: 'trigger-t1', personaRevision: 7,
      };

      await executeLocalEdge(request, vi.fn());

      const init = mockFn.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
      const systemMessages = body.messages.filter((m) => m.role === 'system');
      const personaMessage = systemMessages.find((m) => m.content.includes('You are a rigorous, terse Torq agent.'));
      if (!personaMessage) {
        throw new Error(
          'STOP: T-1 failed — persona directives were NOT found in any role:system message. ' +
          'D-A would be a REAL defect, not the packet-diagnosed one. This is the mechanism to ' +
          `report, not to fix in this slice. Full messages array: ${JSON.stringify(body.messages)}`,
        );
      }
      expect(personaMessage.content).toContain('AGENT DIRECTIVES');

      // T-2: payload.prompt (rendered into the user message) must carry NO
      // persona content — the trust-separation pin.
      const userMessage = body.messages.find((m) => m.role === 'user')!;
      expect(userMessage.content).not.toContain('You are a rigorous, terse Torq agent.');
      expect(userMessage.content).not.toContain('AGENT DIRECTIVES');
      expect(userMessage.content).toContain('the operator asked a live question');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }, 20000);
});

// -----------------------------------------------------------------------
// T-3..T-6 — collapseSelfRuns correction (a): the last-kept-self-post
// reference survives interleaving; collapse only on a near-duplicate hit
// against that surviving reference.
// -----------------------------------------------------------------------
type Seeded = { collabDbPath: string; operatorId: string; agentId: string };

function seedPrincipalsOnly(dbPath: string): Seeded {
  const db = new Database(dbPath);
  runCollaborationMigration(db);
  runAgentAutoreplyMigration(db);
  runAgentRuntimeProfileMigration(db);
  runAgentRuntimeExternalContextMigration(db);
  runAgentPersonaMigration(db);
  runAgentPersonaRevisionMigration(db);
  runAgentTurnOutputMigration(db);
  const operatorId = randomUUID();
  const agentId = randomUUID();
  const now = nowIso();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(operatorId, now, now);
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'AgentG', ?, 'active', 1, NULL, ?, ?)",
  ).run(agentId, operatorId, now, now);
  db.close();
  return { collabDbPath: dbPath, operatorId, agentId };
}

function makeChannel(db: Database.Database, seeded: Seeded): string {
  const now = nowIso();
  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'C', ?, 'active', ?, 1, ?, ?)",
  ).run(channelId, `c-${channelId}`, seeded.operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, seeded.operatorId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(channelId, seeded.agentId, now);
  return channelId;
}

function insertMessage(
  db: Database.Database, channelId: string, seq: number, actorPrincipalId: string, text: string,
): void {
  db.prepare(
    `INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, kind, actor_principal_id, content_json, created_at)
     VALUES (?, 1, ?, ?, 'message_posted', ?, ?, ?)`,
  ).run(randomUUID(), channelId, seq, actorPrincipalId, JSON.stringify({ channelId, text }), nowIso());
}

describe('T-3..T-6 — collapseSelfRuns correction (a): survives interleaving, never destroys distinct content', () => {
  let dataDir: string;
  let seeded: Seeded;
  let collabSurface: typeof import('../packages/gateway/dist/collabSurface.js');
  let autoReplyContext: typeof import('../packages/gateway/dist/autoReplyContext.js');
  let storage: typeof import('../packages/gateway/dist/storage.js');

  const PREV_ENV: Record<string, string | undefined> = {};
  function setEnv(key: string, value: string) {
    if (!(key in PREV_ENV)) PREV_ENV[key] = process.env[key];
    process.env[key] = value;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'torq-collapse-live-shape-'));
    const pepper = Buffer.alloc(32, 0x61);
    const collabDbPath = join(dataDir, 'collab.db');
    seeded = seedPrincipalsOnly(collabDbPath);

    setEnv('TORQCLAW_DATA_DIR', dataDir);
    setEnv('TORQCLAW_COLLAB_DB_PATH', collabDbPath);
    setEnv('TORQCLAW_COLLAB_ENABLED', '1');
    setEnv('TORQCLAW_COLLAB_SURFACE_COMMANDS', '1');
    setEnv('TORQCLAW_AGENT_PARTICIPATION', '1');
    setEnv('TORQCLAW_AGENT_AUTOREPLY', '1');
    setEnv('TORQCLAW_COLLAB_TEST_PEPPER', pepper.toString('base64'));

    const collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as any;
    collabSurface = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'collabSurface.js')).href) as any;
    autoReplyContext = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'autoReplyContext.js')).href) as any;
    storage = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'storage.js')).href) as any;

    const { setCollabSecretStoreForTest } = await import(
      pathToFileURL(join(GATEWAY_DIST_DIR, 'collabIdentity.js')).href
    ) as any;
    const { InMemorySecretStore } = collab as any;
    const secretStore = new InMemorySecretStore();
    secretStore.set('TORQCLAW/principal-pepper', pepper);
    setCollabSecretStoreForTest(secretStore);
  }, 60000);

  function cleanup() {
    for (const [key, value] of Object.entries(PREV_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { storage.resetStateDbForTest({ close: true }); } catch { /* best-effort */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  // Vitest afterAll registered lazily below via a describe-scoped hook import
  // to keep this file's structure flat and readable.
  (globalThis as any).__collapseLiveShapeCleanup = cleanup;

  it('T-3: hostile amputation pair — identical word sets, different order, separated by an operator message', async () => {
    // G1R's F-2 text (line 11 of the verdict) uses THIS EXACT PAIR as its own
    // illustrative argument against a window-wide, order-blind Jaccard
    // collapse: "deploy the staging build to production" vs "deploy the
    // production build to staging" = 1.0 similarity despite being a genuine
    // decision reversal.
    //
    // DISCLOSED SPEC TENSION (reported honestly per this slice's evidence
    // obligations, not silently resolved): G1R's T-3 line (verdict file,
    // line 27) states this pair "must be ... GREEN against correction (a)".
    // That cannot be literally true without EITHER changing
    // looksLikeNearDuplicateOfOwnRecent (PROHIBITED by the same verdict's
    // unfreeze grants) OR inventing new unauthorized order-sensitivity logic
    // in collapseSelfRuns beyond what correction (a) specifies. Correction
    // (a) is explicitly scoped as "collapse only on a near-duplicate hit
    // against that [surviving per-actor] reference" using the SAME
    // (unchanged) predicate — and this pair IS a near-duplicate hit under
    // that unchanged, order-blind predicate (same normalized word set),
    // separated by exactly one intervening operator message, which is
    // precisely the interleaving correction (a) is designed to survive
    // THROUGH (not reset by). So under a correct, literal implementation of
    // correction (a) as G1R described its mechanism, this adversarial pair
    // DOES still collapse -- B is kept, A is elided under it.
    //
    // What T-3 verifiably PROVES here, both true and load-bearing:
    //   (1) RED against window-wide Jaccard: demonstrated below via a
    //       minimal reimplementation of the REJECTED alternative (the T-D5
    //       house pattern for exactly this class of comparative-hazard
    //       proof) -- it destroys A's content just as correction (a) does
    //       for this specific pair, i.e. this pair does not discriminate
    //       between the rejected alternative and correction (a).
    //   (2) The genuinely DISTINCT-content amputation test (obligation 6b,
    //       real different wording, not a word-set reordering) remains green
    //       UNMODIFIED in tests/agent-participation-greeting-loop.test.ts --
    //       verified by the full regression run (see build-evidence.md) --
    //       which is what G1R's parenthetical "(obligation 6b, the
    //       amputation test)" actually names.
    // This is reported to G1D/G1R as a residual finding, not fixed here: no
    // change to looksLikeNearDuplicateOfOwnRecent (prohibited) and no new
    // order-sensitivity heuristic is introduced without a fresh unfreeze.
    const A = 'deploy the staging build to production';
    const B = 'deploy the production build to staging';

    // (1) RED against the REJECTED window-wide Jaccard alternative: a
    // minimal, literal reimplementation of "keep most recent, collapse any
    // window-wide near-duplicate regardless of position" -- NOT the real
    // collapseSelfRuns, mirroring the T-D5 house pattern (a labeled parallel
    // reimplementation used only to demonstrate what the REJECTED shape
    // would do, never a mock of the real function).
    const { normalizeForSimilarity, looksLikeNearDuplicateOfOwnRecent } = autoReplyContext;
    function windowWideJaccardCollapse(texts: string[]): string[] {
      const kept: string[] = [];
      for (const t of texts) {
        const dupIndex = kept.findIndex((k) => looksLikeNearDuplicateOfOwnRecent(t, k));
        if (dupIndex !== -1) kept[dupIndex] = t; // "keep most recent" semantics
        else kept.push(t);
      }
      return kept;
    }
    const rejectedResult = windowWideJaccardCollapse([A, B]);
    expect(rejectedResult, 'T-3 RED: window-wide Jaccard collapses A away, keeping only B').toEqual([B]);
    expect(rejectedResult, 'T-3 RED: A is lost under the rejected alternative').not.toContain(A);
    expect(normalizeForSimilarity(A) === normalizeForSimilarity(B) ? 'same-normalized' : 'different')
      .toBe('different'); // sanity: normalization alone does not equate them (order differs)

    // (2) Correction (a)'s ACTUAL behavior on this exact adversarial pair,
    // measured against the real (built) collapseSelfRuns via
    // buildAnchorWindowContext -- reported honestly, not asserted as a false
    // "both survive" claim.
    const db = collabSurface.getCollabDbForAutoReply()! as unknown as Database.Database;
    const channelId = makeChannel(db, seeded);
    insertMessage(db, channelId, 1, seeded.agentId, A);
    insertMessage(db, channelId, 2, seeded.operatorId, 'wait, confirm the target environment first');
    insertMessage(db, channelId, 3, seeded.agentId, B);
    const caller = collabSurface.callerFor(seeded.agentId);
    const ctx = await autoReplyContext.buildAnchorWindowContext(collabSurface.getStore(), caller, channelId, seeded.agentId);

    // The operator's message is NEVER lost -- this holds regardless of the
    // spec tension above, and is the one part of T-3 that is unconditionally
    // true and tested here.
    expect(ctx.text).toContain('confirm the target environment first');
    // Known residual (disclosed, not silently fixed): B survives, A is
    // elided under an honest reading of correction (a) as specified. If a
    // future slice wants this exact reordered-pair to fully survive, it
    // needs new, explicitly-unfrozen order-sensitivity logic in
    // collapseSelfRuns -- out of this slice's grant.
    expect(ctx.text, 'residual: B (the more recent) survives under correction (a) for this pair').toContain(B);
    expect(ctx.text, 'residual: A is elided under correction (a) for this exact reordered-word-set pair (disclosed spec tension, see comment above)').not.toContain(A);
    expect(ctx.text).toMatch(/elided|earlier repl/i);
  }, 20000);

  it('T-4 (the live shape, RED against pre-fix code): 7 near-identical agent greetings alternating with 7 distinct operator messages', async () => {
    const store = collabSurface.getStore();
    const db = collabSurface.getCollabDbForAutoReply()! as unknown as Database.Database;
    const channelId = makeChannel(db, seeded);

    const GREETING = "Hi there, I'm ready to help with whatever you need in this channel today.";
    const operatorMessages = [
      'What is the deploy status for the staging environment right now?',
      'Can you check whether the last migration actually completed cleanly?',
      'I need the error rate for the last hour, not a summary.',
      'Please confirm the rollback plan is still valid before we proceed.',
      'Who approved the config change that went out this morning?',
      'Is the on-call engineer aware of the current incident yet?',
      'Give me the exact timestamp the outage started, from the logs.',
    ];

    let seq = 1;
    // ANCHOR_EVENT_COUNT is 10 (frozen, unchanged) and buildAnchorWindowContext
    // collapses the anchor and the (non-overlapping) tail window
    // INDEPENDENTLY -- a run never spans the elided gap between them (this is
    // pre-existing, documented, unmodified behavior; the collapse fix in
    // this slice touches only collapseSelfRuns's OWN interleaving logic, not
    // the anchor/window split above it). The 14 target events (7 greeting/
    // operator pairs) must therefore land ENTIRELY in one block to observe
    // "at most 1 survives" over the whole set, matching G1R's T-4 spec of a
    // single alternating window -- so 10 filler events (5 unrelated
    // exchanges) are seeded first to fill the anchor, pushing the target
    // shape entirely into the tail window.
    for (let i = 0; i < 5; i++) {
      insertMessage(db, channelId, seq++, seeded.operatorId, `unrelated filler operator message number ${i}`);
      insertMessage(db, channelId, seq++, seeded.agentId, `unrelated filler agent reply number ${i}, not a greeting`);
    }
    for (let i = 0; i < 7; i++) {
      insertMessage(db, channelId, seq++, seeded.operatorId, operatorMessages[i]!);
      insertMessage(db, channelId, seq++, seeded.agentId, GREETING);
    }

    const caller = collabSurface.callerFor(seeded.agentId);
    const ctx = await autoReplyContext.buildAnchorWindowContext(store, caller, channelId, seeded.agentId);

    const greetingOccurrences = ctx.text.split(GREETING).length - 1;
    expect(greetingOccurrences, 'T-4: at most 1 of the 7 near-identical greetings survives verbatim').toBeLessThanOrEqual(1);
    expect(ctx.text, 'T-4: an elision marker must be present').toMatch(/elided|earlier repl/i);
    for (const msg of operatorMessages) {
      expect(ctx.text, `T-4: operator message must survive verbatim: "${msg}"`).toContain(msg);
    }
    // All 7 operator messages present in order, newest last.
    const indices = operatorMessages.map((msg) => ctx.text.indexOf(msg));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]!, 'T-4: operator messages must appear in order').toBeGreaterThan(indices[i - 1]!);
    }
    // G2A round-1 B-1 correction (test-construction fix, not a scope
    // change): this shape's true chronology is
    // (operator, greeting) x7 -- the FINAL event is the 7th greeting, which
    // really is the newest message, posted after all 7 operator questions.
    // The original assertion here claimed the opposite ("newest operator
    // message is last"), which only passed because of the B-1 rendering bug
    // (the surviving greeting used to render at the OLD, stale reference
    // slot instead of its own true, most-recent position). Now that B-1 is
    // fixed and the greeting representative correctly renders at its real
    // (last) position, the honest invariant is the one T-9 already checks
    // directly: the surviving self-representative renders AFTER every
    // operator message. Re-asserted here too for T-4's own self-containment
    // (T-9 is the dedicated, more thorough version of this check).
    const lastOperatorIndex = indices[indices.length - 1]!;
    const lastGreetingIndex = ctx.text.lastIndexOf(GREETING);
    const lastElisionMarkerIndex = Math.max(ctx.text.search(/\[.*earlier repl.*\]/i), ctx.text.search(/elided/i));
    expect(
      Math.max(lastGreetingIndex, lastElisionMarkerIndex),
      'T-4: the surviving greeting/elision representative -- the TRUE newest event in this shape -- renders after the last operator message',
    ).toBeGreaterThan(lastOperatorIndex);
  }, 20000);

  it('T-9 (G2A B-1 correction): rendered [#N] cursors are strictly increasing, and the surviving self-representative renders AFTER every operator message that preceded it in real time', async () => {
    // G2A round-1 finding B-1: collapseSelfRuns used to write the elision
    // entry IN PLACE at the OLD (lastSelfIndex) reference's position while
    // storing the MOST RECENT event -- once the reference survives
    // interleaving, that old slot can be arbitrarily far back in `out`,
    // producing a non-monotonic rendered cursor order (the agent's newest
    // reply appears to precede operator questions it was actually posted
    // after). This test renders the EXACT T-4 alternating shape (5 filler
    // pairs pushing the target 14 events into the tail window block, then 7
    // greeting/operator pairs) and asserts every rendered [#N] cursor token
    // is strictly increasing left-to-right, and that the single surviving
    // greeting representative's rendered position comes after every
    // operator message that was posted before it in real (channel_seq)
    // time.
    const store = collabSurface.getStore();
    const db = collabSurface.getCollabDbForAutoReply()! as unknown as Database.Database;
    const channelId = makeChannel(db, seeded);

    const GREETING = "Hi there, I'm ready to help with whatever you need in this channel today.";
    const operatorMessages = [
      'What is the deploy status for the staging environment right now?',
      'Can you check whether the last migration actually completed cleanly?',
      'I need the error rate for the last hour, not a summary.',
      'Please confirm the rollback plan is still valid before we proceed.',
      'Who approved the config change that went out this morning?',
      'Is the on-call engineer aware of the current incident yet?',
      'Give me the exact timestamp the outage started, from the logs.',
    ];

    let seq = 1;
    for (let i = 0; i < 5; i++) {
      insertMessage(db, channelId, seq++, seeded.operatorId, `unrelated filler operator message number ${i}`);
      insertMessage(db, channelId, seq++, seeded.agentId, `unrelated filler agent reply number ${i}, not a greeting`);
    }
    for (let i = 0; i < 7; i++) {
      insertMessage(db, channelId, seq++, seeded.operatorId, operatorMessages[i]!);
      insertMessage(db, channelId, seq++, seeded.agentId, GREETING);
    }

    const caller = collabSurface.callerFor(seeded.agentId);
    const ctx = await autoReplyContext.buildAnchorWindowContext(store, caller, channelId, seeded.agentId);

    // Extract every rendered [#N] cursor token in left-to-right (rendered)
    // order and assert strict monotonic increase. A non-monotonic sequence
    // is exactly B-1's symptom (e.g. a stale elision entry rendering an old
    // cursor position while carrying the newest event's text, or -- as
    // measured by G2A pre-fix -- the reverse: an old SLOT position holding
    // the newest cursor number, jumping back down afterward).
    const cursorTokens = [...ctx.text.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
    expect(cursorTokens.length, 'T-9: at least one rendered [#N] cursor token must be present').toBeGreaterThan(0);
    for (let i = 1; i < cursorTokens.length; i++) {
      expect(
        cursorTokens[i]!,
        `T-9: rendered cursors must be strictly increasing; got ${JSON.stringify(cursorTokens)} (violation at index ${i})`,
      ).toBeGreaterThan(cursorTokens[i - 1]!);
    }

    // The surviving self-representative (the single elision/verbatim entry
    // carrying the GREETING text) must render AFTER every operator message
    // whose real channel_seq preceded it -- i.e. after ALL 7 operator
    // messages in this shape, since the kept representative is always the
    // MOST RECENT greeting (channel_seq of the 7th/last greeting), which in
    // real time came after every one of the 7 operator questions.
    const greetingRenderIndex = ctx.text.search(new RegExp(GREETING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(greetingRenderIndex, 'T-9: the surviving greeting representative must render somewhere').toBeGreaterThan(-1);
    for (const msg of operatorMessages) {
      const opIndex = ctx.text.indexOf(msg);
      expect(opIndex, `T-9: operator message must be present: "${msg}"`).toBeGreaterThan(-1);
      expect(
        greetingRenderIndex,
        `T-9: the surviving self-representative must render AFTER the operator message it followed in real time: "${msg}"`,
      ).toBeGreaterThan(opIndex);
    }
  }, 20000);

  it('T-5: deletion probe — with collapsing effectively disabled (no selfPrincipalId), T-4s shape fails', async () => {
    const store = collabSurface.getStore();
    const db = collabSurface.getCollabDbForAutoReply()! as unknown as Database.Database;
    const channelId = makeChannel(db, seeded);

    const GREETING = 'Hello again, this is a repeated greeting used to verify the collapse call is load-bearing.';
    const operatorMessages = [
      'first distinct operator message here',
      'second distinct operator message here',
      'third distinct operator message here',
    ];
    let seq = 1;
    for (let i = 0; i < operatorMessages.length; i++) {
      insertMessage(db, channelId, seq++, seeded.operatorId, operatorMessages[i]!);
      insertMessage(db, channelId, seq++, seeded.agentId, GREETING);
    }

    const caller = collabSurface.callerFor(seeded.agentId);
    // Omitting selfPrincipalId is the deletion-probe surrogate for "the
    // collapse call removed": buildAnchorWindowContext's own documented
    // contract is that omitting selfPrincipalId performs NO collapsing at
    // all (byte-identical to pre-N-1 behavior, obligation 8). This proves
    // the collapse call is what produces the T-4 shape, not some incidental
    // property of the data.
    const ctxNoCollapse = await autoReplyContext.buildAnchorWindowContext(store, caller, channelId);
    const occurrences = ctxNoCollapse.text.split(GREETING).length - 1;
    expect(occurrences, 'T-5: without the collapse call, all repeated greetings survive uncollapsed').toBe(operatorMessages.length);
    expect(ctxNoCollapse.text, 'T-5: no elision marker without the collapse call').not.toMatch(/earlier repl/i);
  }, 20000);

  it('T-6: marker honesty — count equals items omitted; never consumes non-message events or other actors', async () => {
    const store = collabSurface.getStore();
    const db = collabSurface.getCollabDbForAutoReply()! as unknown as Database.Database;
    const channelId = makeChannel(db, seeded);

    const GREETING = 'Marker honesty greeting text repeated here to check the exact collapsed count reported.';
    let seq = 1;
    // 4 self-greetings interleaved with operator messages AND a non-message
    // event (membership_changed-shaped synthetic row) — the non-message
    // event and other actor's messages must never be counted as "collapsed"
    // and must never themselves be consumed by the collapse.
    insertMessage(db, channelId, seq++, seeded.operatorId, 'kick things off');
    insertMessage(db, channelId, seq++, seeded.agentId, GREETING);
    db.prepare(
      `INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, kind, actor_principal_id, content_json, created_at)
       VALUES (?, 1, ?, ?, 'member_added', ?, ?, ?)`,
    ).run(randomUUID(), channelId, seq++, seeded.operatorId, JSON.stringify({ channelId, principalId: seeded.operatorId }), nowIso());
    insertMessage(db, channelId, seq++, seeded.operatorId, 'anyone around');
    insertMessage(db, channelId, seq++, seeded.agentId, GREETING);
    insertMessage(db, channelId, seq++, seeded.operatorId, 'still there');
    insertMessage(db, channelId, seq++, seeded.agentId, GREETING);
    insertMessage(db, channelId, seq++, seeded.operatorId, 'final ping');
    insertMessage(db, channelId, seq++, seeded.agentId, GREETING);

    const caller = collabSurface.callerFor(seeded.agentId);
    const ctx = await autoReplyContext.buildAnchorWindowContext(store, caller, channelId, seeded.agentId);

    // Exactly 1 greeting survives, marker present, and the marker's own
    // reported count equals the number actually elided (4 total greetings
    // minus 1 kept representative = 3 collapsed).
    const greetingOccurrences = ctx.text.split(GREETING).length - 1;
    expect(greetingOccurrences).toBe(1);
    const markerMatch = ctx.text.match(/posted (\d+) earlier repl(?:y|ies)/);
    expect(markerMatch, 'T-6: marker must report an exact count').not.toBeNull();
    expect(Number(markerMatch![1])).toBe(3);

    // All operator messages and the membership event's absence-of-collapse
    // are honest too: operator text is untouched and never counted in any
    // "earlier replies" marker.
    expect(ctx.text).toContain('kick things off');
    expect(ctx.text).toContain('anyone around');
    expect(ctx.text).toContain('still there');
    expect(ctx.text).toContain('final ping');
    // The member_added event renders via the generic kind branch, never
    // folded into the self-collapse marker.
    expect(ctx.text).toContain('member_added');
  }, 20000);

  it('cleanup', () => {
    cleanup();
    expect(true).toBe(true);
  });
});

// -----------------------------------------------------------------------
// T-7 — constant parity between autoReplyContext.ts and the dispatcher's
// inlined guard literals, read from SOURCE TEXT only (dispatcher file is
// never imported/mutated here).
// -----------------------------------------------------------------------
describe('T-7 — constant parity: autoReplyContext.ts vs autoReplyDispatcher.ts inlined guard', () => {
  it('NEAR_DUPLICATE_MIN_LENGTH / NEAR_DUPLICATE_SIMILARITY_THRESHOLD equal the dispatcher guard literals', () => {
    const contextSourcePath = join(REPO_ROOT, 'packages', 'gateway', 'src', 'autoReplyContext.ts');
    const dispatcherSourcePath = join(REPO_ROOT, 'packages', 'gateway', 'src', 'autoReplyDispatcher.ts');
    const contextSource = readFileSync(contextSourcePath, 'utf8');
    const dispatcherSource = readFileSync(dispatcherSourcePath, 'utf8');

    const contextMinLength = contextSource.match(/NEAR_DUPLICATE_MIN_LENGTH\s*=\s*(\d+)/);
    const contextThreshold = contextSource.match(/NEAR_DUPLICATE_SIMILARITY_THRESHOLD\s*=\s*([\d.]+)/);
    const dispatcherMinLength = dispatcherSource.match(/NEAR_DUP_MIN_LENGTH\s*=\s*(\d+)/);
    const dispatcherThreshold = dispatcherSource.match(/NEAR_DUP_SIMILARITY_THRESHOLD\s*=\s*([\d.]+)/);

    expect(contextMinLength, 'context module must define NEAR_DUPLICATE_MIN_LENGTH').not.toBeNull();
    expect(dispatcherMinLength, 'dispatcher must define its inlined NEAR_DUP_MIN_LENGTH literal').not.toBeNull();
    expect(contextThreshold, 'context module must define NEAR_DUPLICATE_SIMILARITY_THRESHOLD').not.toBeNull();
    expect(dispatcherThreshold, 'dispatcher must define its inlined NEAR_DUP_SIMILARITY_THRESHOLD literal').not.toBeNull();

    expect(Number(contextMinLength![1])).toBe(Number(dispatcherMinLength![1]));
    expect(Number(contextThreshold![1])).toBe(Number(dispatcherThreshold![1]));
  });
});

// -----------------------------------------------------------------------
// Rider (B-FOLLOWUP-1 / NB-3) — seat-lattice pin, test-only, no authz.ts
// edit. See file-header disclosure above for what is and is not black-box
// discriminable here.
// -----------------------------------------------------------------------
describe('Rider (B-FOLLOWUP-1): ADD_CHANNEL_MEMBER / REMOVE_CHANNEL_MEMBER seat-lattice pin', () => {
  function ctx(): AuthzContext {
    return { sessionId: 'session', lookupTaskSession: () => null };
  }

  const add = ClientCommandSchema.parse({
    action: 'ADD_CHANNEL_MEMBER',
    channelId: 'chan-1',
    agentPrincipalId: 'agent-1',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174010',
  });
  const remove = ClientCommandSchema.parse({
    action: 'REMOVE_CHANNEL_MEMBER',
    channelId: 'chan-1',
    agentPrincipalId: 'agent-1',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174011',
  });

  it('outcome pin: channel and node roles deny both actions (DENY_NOT_PERMITTED)', () => {
    expect(authorize('channel', add, ctx())).toEqual({ ok: false, reason: 'action not permitted for this role' });
    expect(authorize('channel', remove, ctx())).toEqual({ ok: false, reason: 'action not permitted for this role' });
    expect(authorize('node', add, ctx())).toEqual({ ok: false, reason: 'action not permitted for this role' });
    expect(authorize('node', remove, ctx())).toEqual({ ok: false, reason: 'action not permitted for this role' });
  });

  it('DISCLOSURE + source-text deletion-sensitivity pin (no authz.ts edit): the channel-role named arms exist in source, distinct from the default arm', () => {
    // DISCLOSURE (per the rider's own instruction: "if none exists WITHOUT
    // editing authz.ts, disclose that and pin what IS pinnable"): for the
    // 'channel' role, the named case arms for ADD_CHANNEL_MEMBER/
    // REMOVE_CHANNEL_MEMBER and the switch's own `default:` arm both
    // `return DENY_NOT_PERMITTED` — the SAME module-level singleton object.
    // Deleting the two named `case` lines (letting these actions fall
    // through to `default:`) is therefore BEHAVIORALLY SILENT: no black-box
    // call to authorize() can distinguish "denied via the named arm" from
    // "denied via the default arm" for the 'channel' role, because there is
    // no fail-open tail here to diverge against (unlike authorizeOperator,
    // which DOES have a fail-open tail — see
    // tests/collab-channel-membership-wire.test.ts's T-D5 suite, which pins
    // that operator-side distinction correctly). The SAME is true for the
    // 'node' role's single unconditional `return DENY_NOT_PERMITTED;` — node
    // never had a per-action named arm for these two actions at all; it
    // denies via the branch's own fallthrough.
    //
    // What IS pinnable without touching authz.ts is a source-text check,
    // exactly the T-7 house pattern: assert the named arms are textually
    // present, inside the channel-role switch, before its `default:` arm —
    // so a future accidental deletion of the case lines (even though
    // runtime behavior would not change) shows up as a reviewable, failing
    // diff here rather than silently disappearing from the source.
    const authzSourcePath = join(REPO_ROOT, 'packages', 'gateway', 'src', 'authz.ts');
    const authzSource = readFileSync(authzSourcePath, 'utf8');

    const channelSwitchStart = authzSource.indexOf('// role === \'channel\'');
    expect(channelSwitchStart, 'must find the channel-role switch').toBeGreaterThan(-1);
    // Match the `default:` CASE LABEL specifically (start-of-line, indented,
    // followed by a newline) — several comments in this switch mention the
    // words "default:" in prose ("regardless of what the default: arm below
    // would otherwise resolve to"), which a bare substring search would
    // false-positive match well before the real label.
    const defaultLabelMatch = authzSource.slice(channelSwitchStart).match(/\n\s*default:\s*\n/);
    expect(defaultLabelMatch, 'must find the channel-role switch default CASE LABEL (not a comment mention)').not.toBeNull();
    const defaultArmIndex = channelSwitchStart + defaultLabelMatch!.index!;
    expect(defaultArmIndex, 'must find the channel-role switch default arm').toBeGreaterThan(channelSwitchStart);

    const channelSwitchBody = authzSource.slice(channelSwitchStart, defaultArmIndex);
    const addArmIndex = channelSwitchBody.indexOf("case 'ADD_CHANNEL_MEMBER':");
    const removeArmIndex = channelSwitchBody.indexOf("case 'REMOVE_CHANNEL_MEMBER':");
    expect(addArmIndex, 'ADD_CHANNEL_MEMBER must have a named case arm BEFORE the default arm').toBeGreaterThan(-1);
    expect(removeArmIndex, 'REMOVE_CHANNEL_MEMBER must have a named case arm BEFORE the default arm').toBeGreaterThan(-1);

    // Deletion-sensitivity demonstration: simulate the named arms' absence
    // by stripping those two exact lines from a COPY of the source text (no
    // file write), and show the resulting text would no longer contain
    // them — i.e. this assertion suite is sensitive to their removal, even
    // though the compiled behavior for 'channel'/'node' would not change.
    const withArmsRemoved = channelSwitchBody
      .replace("case 'ADD_CHANNEL_MEMBER':", '')
      .replace("case 'REMOVE_CHANNEL_MEMBER':", '');
    expect(withArmsRemoved).not.toContain("case 'ADD_CHANNEL_MEMBER':");
    expect(withArmsRemoved).not.toContain("case 'REMOVE_CHANNEL_MEMBER':");
    expect(channelSwitchBody).toContain("case 'ADD_CHANNEL_MEMBER':");
    expect(channelSwitchBody).toContain("case 'REMOVE_CHANNEL_MEMBER':");
  });
});
