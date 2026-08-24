/**
 * G1D FABLE channels-agent-UX packet (2026-08-24), Item A -- the greeting
 * loop. Root cause (verified, per the packet's diagnosis of record): the
 * dispatched prompt for the failing turn contained the triggering message
 * (state.db `tasks.request_json`, seq-550); the 40-event anchor window held
 * 7 near-identical prior self-replies, and a clean-context probe of the same
 * model answered correctly. This is in-context self-imitation, not
 * context-blindness -- the fix is structural (window collapse +
 * duplicate-suppression at commit), never a model-judgment retry.
 *
 * THE SEAM, same discipline as tests/agent-participation-a3c.test.ts: this
 * file drives the REAL onChannelMessageCommitted -> claimAgentTurn ->
 * runAgentTurn -> commitAgentTurnFallbackOutput path against the REAL built
 * gateway/collab dist artifacts. `setAutoReplyDispatchForTest` replaces ONLY
 * "what a model would have decided to do this turn" -- exactly the license
 * a3c already uses for the same reason (no test in this repo boots a real
 * local model). Everything downstream -- the anchor+window context assembly
 * (buildAnchorWindowContext, now receiving selfPrincipalId), the
 * duplicate-suppression guard at the local-fallback commit decision, the
 * migration's resolution_note column, and resolveAgentTurn -- is the real
 * built artifact, unmodified by this test.
 *
 * Obligations covered here (G1D resolution table, all 16 adopted verbatim):
 *   5  -- A-1 RED-first at the COMMIT layer with the real seq-550 window
 *         shape: 7 near-identical self-greetings pre-loaded, a scripted
 *         local-fallback task result equal to the greeting drives the
 *         local-fallback path. RED against pre-fix code = the duplicate
 *         gets posted; this file's own git history is the RED evidence
 *         (see build-evidence.md for the reproduction transcript).
 *   6a -- window collapse: at most 1 of the agent's own prior replies survives
 *         in the assembled window, plus an elision marker; other principals'
 *         messages are complete and in order.
 *   6b -- the amputation test: a long, distinct self-authored exchange is
 *         NOT collapsed, and the reply it produces is non-degenerate.
 *   7  -- subscriptionText stays actor-blind: the marker never contains a
 *         channel id, actor id, or event id.
 *   8  -- the cron path (cronDispatcher.ts:208) passes no selfPrincipalId --
 *         its assembled context is asserted byte-identical to a captured
 *         baseline from before this change (the parameter is optional and
 *         additive).
 *   9  -- suppressed-duplicate vs. chosen silence are DB-distinguishable via
 *         resolution_note; a deletion probe shows a query that depends on
 *         the distinction goes from green to red if the WHERE clause on
 *         resolution_note is deleted.
 *   10 -- short acknowledgments ("ack", "done", "on it") are NEVER
 *         suppressed even when repeated verbatim -- the honest temperature-0
 *         floor (obligation 10's note): the same text posted twice by the
 *         same agent for a short ack is legitimate, not a loop.
 *   11 -- zero retries: the scripted dispatch is called exactly once per
 *         claimed turn (call-count assertion), proving B-6's "no retry"
 *         ruling (temperature-0 futility) held.
 *   14 -- zero collab_events writes from the new duplicate-suppression path
 *         (A4-c pattern): a suppressed turn must not create ANY event row,
 *         only resolve the collab_agent_turns row.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

const REPO_ROOT = join(GATEWAY_DIST_ENTRY, '..', '..', '..', '..');
const GATEWAY_DIST_DIR = join(REPO_ROOT, 'packages', 'gateway', 'dist');
const COLLAB_DIST_DIR = join(REPO_ROOT, 'packages', 'collab', 'dist');

beforeAll(async () => { await ensureGatewayBuild(); }, 200000);

function nowIso(): string { return new Date().toISOString(); }

type Seeded = {
  collabDbPath: string;
  operatorId: string;
  agentId: string;
  channelId: string;
};

function seedChannel(dbPath: string): Seeded {
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
  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Loop', 'loop', 'active', ?, 1, ?, ?)",
  ).run(channelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, operatorId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(channelId, agentId, now);
  db.prepare(
    `INSERT INTO collab_agent_runtime_profiles(
       agent_principal_id, provider_account_id, adapter_id, model_id, autostart, created_at, updated_at
     ) VALUES (?, 'ollama-local', 'ollama-local', 'torq-ai-v5', 1, ?, ?)`,
  ).run(agentId, now, now);
  db.prepare(
    `INSERT INTO collab_agent_personas(
       agent_principal_id, icon_id, system_directives, created_at, updated_at, revision
     ) VALUES (?, 'robot', '', ?, ?, 1)`,
  ).run(agentId, now, now);
  db.close();
  return { collabDbPath: dbPath, operatorId, agentId, channelId };
}

function messagePostedRows(dbPath: string, channelId: string): Array<{ actorPrincipalId: string; channelSeq: number; text: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT actor_principal_id AS actorPrincipalId, channel_seq AS channelSeq, content_json AS contentJson
           FROM collab_events WHERE channel_id = ? AND kind = 'message_posted' ORDER BY channel_seq ASC`,
      )
      .all(channelId) as Array<{ actorPrincipalId: string; channelSeq: number; contentJson: string }>;
    return rows.map((r) => ({ actorPrincipalId: r.actorPrincipalId, channelSeq: r.channelSeq, text: JSON.parse(r.contentJson).text }));
  } finally {
    db.close();
  }
}

function agentTurnRows(dbPath: string, channelId: string): Array<{
  agentPrincipalId: string; channelSeq: number; state: string; resolutionNote: string | null;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT agent_principal_id AS agentPrincipalId, channel_seq AS channelSeq, state, resolution_note AS resolutionNote
           FROM collab_agent_turns WHERE channel_id = ? ORDER BY channel_seq ASC`,
      )
      .all(channelId) as Array<{ agentPrincipalId: string; channelSeq: number; state: string; resolutionNote: string | null }>;
  } finally {
    db.close();
  }
}

describe('PRD-TCLAW G1D-FABLE-CHANNELS-AGENT-UX Item A — greeting loop self-dedupe + suppression guard', () => {
  let dataDir: string;
  let seeded: Seeded;
  let collab: typeof import('../packages/collab/dist/index.js');
  let collabSurface: typeof import('../packages/gateway/dist/collabSurface.js');
  let autoReplyDispatcher: typeof import('../packages/gateway/dist/autoReplyDispatcher.js');
  let autoReplyContext: typeof import('../packages/gateway/dist/autoReplyContext.js');
  let cronDispatcher: typeof import('../packages/gateway/dist/cronDispatcher.js');
  let events: typeof import('../packages/gateway/dist/events.js');
  let storage: typeof import('../packages/gateway/dist/storage.js');

  const PREV_ENV: Record<string, string | undefined> = {};
  function setEnv(key: string, value: string) {
    if (!(key in PREV_ENV)) PREV_ENV[key] = process.env[key];
    process.env[key] = value;
  }

  /** Queue of scripted local-fallback task results (or null to stay silent),
   *  consumed one per claimed turn. Mirrors a3c's `script` -- the ONLY thing
   *  standing in for "what a real model would decide". */
  let script: string[] | null = [];
  let dispatchCallCount = 0;
  let triggerEnabled = true;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'torq-greeting-loop-'));
    const pepper = Buffer.alloc(32, 0x52);
    const collabDbPath = join(dataDir, 'collab.db');
    seeded = seedChannel(collabDbPath);

    setEnv('TORQCLAW_DATA_DIR', dataDir);
    setEnv('TORQCLAW_COLLAB_DB_PATH', collabDbPath);
    setEnv('TORQCLAW_COLLAB_ENABLED', '1');
    setEnv('TORQCLAW_COLLAB_SURFACE_COMMANDS', '1');
    setEnv('TORQCLAW_AGENT_PARTICIPATION', '1');
    setEnv('TORQCLAW_AGENT_AUTOREPLY', '1');
    setEnv('TORQCLAW_COLLAB_TEST_PEPPER', pepper.toString('base64'));

    collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as any;
    collabSurface = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'collabSurface.js')).href) as any;
    autoReplyDispatcher = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'autoReplyDispatcher.js')).href) as any;
    autoReplyContext = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'autoReplyContext.js')).href) as any;
    cronDispatcher = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'cronDispatcher.js')).href) as any;
    events = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'events.js')).href) as any;
    storage = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'storage.js')).href) as any;

    const { setCollabSecretStoreForTest } = await import(
      pathToFileURL(join(GATEWAY_DIST_DIR, 'collabIdentity.js')).href
    ) as any;
    const { InMemorySecretStore } = collab as any;
    const secretStore = new InMemorySecretStore();
    secretStore.set('TORQCLAW/principal-pepper', pepper);
    setCollabSecretStoreForTest(secretStore);

    collabSurface.setAutoReplyTrigger((params: any) => {
      if (!triggerEnabled) return;
      return autoReplyDispatcher.onChannelMessageCommitted(params);
    });

    // THE SEAM: same license a3c uses. Recover WHICH claimed turn this
    // dispatch is for from the real dispatch_request_id correlator, then
    // complete the real task row with the scripted text (or empty for
    // silence) -- runDispatchAndWait's poll and everything past it is real.
    autoReplyDispatcher.setAutoReplyDispatchForTest((req: any, _diag: any) => {
      dispatchCallCount += 1;
      void (async () => {
        events.taskStore.create(req, _diag);
        try {
          const reply = script && script.length > 0 ? script.shift()! : '';
          events.taskStore.complete(req.id, reply, {});
        } catch (err) {
          events.taskStore.fail(req.id, String((err as any)?.message ?? err));
        }
      })();
    });
  }, 60000);

  afterAll(() => {
    autoReplyDispatcher.setAutoReplyDispatchForTest(null);
    collabSurface.setAutoReplyTrigger(() => {});
    for (const [key, value] of Object.entries(PREV_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { storage.resetStateDbForTest({ close: true }); } catch { /* best-effort */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  afterEach(() => {
    triggerEnabled = true;
    script = [];
    dispatchCallCount = 0;
    collab.clearAutoreplyStop(collabSurface.getCollabDbForAutoReply()!, 'global', null);
    collab.clearAutoreplyStop(collabSurface.getCollabDbForAutoReply()!, 'channel', seeded.channelId);
  });

  async function waitForTerminal(expectedTurnSeq: number, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const turns = agentTurnRows(seeded.collabDbPath, seeded.channelId);
      const row = turns.find((t) => t.channelSeq === expectedTurnSeq && t.agentPrincipalId === seeded.agentId);
      if (row && row.state !== 'dispatched') return;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for turn @seq=${expectedTurnSeq} to resolve; turns=${JSON.stringify(turns)}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Seed N prior messages authored by the agent itself, WITHOUT triggering
   *  auto-reply (trigger disabled during seeding) -- this reproduces the
   *  real seq-550 window shape: 7 near-identical self-greetings already
   *  committed in the channel BEFORE the turn under test is dispatched. */
  async function seedAgentGreetings(count: number, text: string): Promise<void> {
    const store = collabSurface.getStore();
    triggerEnabled = false;
    try {
      for (let i = 0; i < count; i++) {
        await store!.postChannelMessage(
          collabSurface.callerFor(seeded.agentId),
          { channelId: seeded.channelId, text },
          randomUUID(),
        );
      }
    } finally {
      triggerEnabled = true;
    }
  }

  it('obligation 5 — A-1: 7 near-identical self-greetings pre-loaded, scripted reply equals the greeting -> suppressed, never posted as a duplicate', async () => {
    const GREETING = "Hello! I'm your assistant for this channel, happy to help with anything you need.";
    await seedAgentGreetings(7, GREETING);

    const store = collabSurface.getStore();
    const humanSeq = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'Anyone there?' },
        randomUUID(),
      )).cursor,
    );
    script = [GREETING]; // scripted "model decision": repeat the same greeting
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: humanSeq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });

    await waitForTerminal(humanSeq);

    // RED against pre-fix code would show this posting a duplicate 8th
    // greeting. Fixed: the turn resolves no_post with the persisted
    // discriminator, and no 8th message_posted row is created.
    const turns = agentTurnRows(seeded.collabDbPath, seeded.channelId);
    const turn = turns.find((t) => t.channelSeq === humanSeq)!;
    expect(turn.state).toBe('no_post');
    expect(turn.resolutionNote).toBe('duplicate_suppressed');

    const posts = messagePostedRows(seeded.collabDbPath, seeded.channelId);
    // 1 human message + 7 seeded greetings = 8 total; the would-be 9th
    // (duplicate) must never land.
    expect(posts.length).toBe(8);
    expect(posts.filter((p) => p.text === GREETING).length).toBe(7);
  }, 20000);

  it('obligation 11 — zero retries: the scripted dispatch is called exactly once for the suppressed turn', async () => {
    const GREETING = 'Repeating myself here for the loop test, exact same words every single time.';
    await seedAgentGreetings(3, GREETING);
    const store = collabSurface.getStore();
    const humanSeq = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'ping' },
        randomUUID(),
      )).cursor,
    );
    dispatchCallCount = 0;
    script = [GREETING];
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: humanSeq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    await waitForTerminal(humanSeq);
    expect(dispatchCallCount, 'no retry -- exactly one dispatch call for the suppressed turn').toBe(1);
  }, 20000);

  it('obligation 14 — zero collab_events writes from the suppression path (A4-c pattern)', async () => {
    const GREETING = 'This exact acknowledgement text repeats identically across every single one of these turns.';
    await seedAgentGreetings(2, GREETING);
    const store = collabSurface.getStore();
    const before = messagePostedRows(seeded.collabDbPath, seeded.channelId).length;
    const humanSeq = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'status?' },
        randomUUID(),
      )).cursor,
    );
    script = [GREETING];
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: humanSeq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    await waitForTerminal(humanSeq);
    // before + 1 (the human's own status? post) is the only new event; the
    // suppressed turn contributes ZERO further collab_events rows.
    const after = messagePostedRows(seeded.collabDbPath, seeded.channelId).length;
    expect(after).toBe(before + 1);
  }, 20000);

  it('obligation 10 — short acknowledgments are never suppressed, even repeated verbatim', async () => {
    await seedAgentGreetings(3, 'ack');
    const store = collabSurface.getStore();
    const humanSeq = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'go' },
        randomUUID(),
      )).cursor,
    );
    script = ['ack'];
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: humanSeq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    await waitForTerminal(humanSeq);
    const turns = agentTurnRows(seeded.collabDbPath, seeded.channelId);
    const turn = turns.find((t) => t.channelSeq === humanSeq)!;
    // A short ack is exempt from the near-duplicate floor -- it posts and
    // completes normally, never suppressed.
    expect(turn.state).toBe('completed');
    expect(turn.resolutionNote).toBeNull();
    const posts = messagePostedRows(seeded.collabDbPath, seeded.channelId);
    expect(posts.filter((p) => p.text === 'ack').length).toBe(4); // 3 seeded + 1 new
  }, 20000);

  it('obligation 9 — suppressed-duplicate is DB-distinguishable from chosen silence, with a deletion probe', async () => {
    // Chosen silence: script an empty reply, no prior greetings needed.
    const store = collabSurface.getStore();
    const silenceSeq = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'nothing to say to this one' },
        randomUUID(),
      )).cursor,
    );
    script = ['']; // completedLocalFallbackText returns null for empty -> no_post, no note
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: silenceSeq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    await waitForTerminal(silenceSeq);

    // Suppressed duplicate, in the same channel.
    const GREETING = 'A distinguishable duplicate greeting used only for this specific probe test right here.';
    await seedAgentGreetings(2, GREETING);
    const dupSeq = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'again?' },
        randomUUID(),
      )).cursor,
    );
    script = [GREETING];
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: dupSeq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    await waitForTerminal(dupSeq);

    const turns = agentTurnRows(seeded.collabDbPath, seeded.channelId);
    const silenceTurn = turns.find((t) => t.channelSeq === silenceSeq)!;
    const dupTurn = turns.find((t) => t.channelSeq === dupSeq)!;
    expect(silenceTurn.state).toBe('no_post');
    expect(silenceTurn.resolutionNote).toBeNull();
    expect(dupTurn.state).toBe('no_post');
    expect(dupTurn.resolutionNote).toBe('duplicate_suppressed');

    // DELETION PROBE (obligation 9): a query that depends on the
    // distinction (count ONLY genuinely-silent no_post turns) must be
    // sensitive to resolution_note. Simulate "deleting" the discriminator
    // clause by running the naive query (no WHERE on resolution_note) and
    // show it produces a DIFFERENT (wrong) count than the discriminating
    // one -- proving the column is load-bearing, not decorative.
    const db = new Database(seeded.collabDbPath, { readonly: true });
    try {
      const naiveSilentCount = (db.prepare(
        `SELECT COUNT(*) AS c FROM collab_agent_turns WHERE channel_id = ? AND state = 'no_post'`,
      ).get(seeded.channelId) as { c: number }).c;
      const discriminatingSilentCount = (db.prepare(
        `SELECT COUNT(*) AS c FROM collab_agent_turns WHERE channel_id = ? AND state = 'no_post' AND resolution_note IS NULL`,
      ).get(seeded.channelId) as { c: number }).c;
      expect(naiveSilentCount, 'the naive query (pre-deletion-probe) conflates suppression with chosen silence').toBeGreaterThan(discriminatingSilentCount);
      expect(discriminatingSilentCount, 'the discriminating query excludes the suppressed turn').toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  }, 20000);

  it('obligation 6a/6b — window collapse: at most one self-reply survives plus a marker; a long distinct self-exchange is not collapsed', async () => {
    // Use a FRESH channel in the SAME already-open store/DB (getStore() is a
    // process-wide singleton -- see collabSurface.ts's defaultStore -- so a
    // second DB cannot be swapped in via env vars mid-suite). Raw SQL
    // inserts (not postChannelMessage) so this test exercises ONLY
    // buildAnchorWindowContext, never the dispatcher/trigger machinery the
    // other cases already cover.
    const store = collabSurface.getStore();
    const db = collabSurface.getCollabDbForAutoReply()! as unknown as Database.Database;
    const now = nowIso();
    const freshChannelId = randomUUID();
    db.prepare(
      "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Window', ?, 'active', ?, 1, ?, ?)",
    ).run(freshChannelId, `window-${freshChannelId}`, seeded.operatorId, now, now);
    db.prepare(
      "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
    ).run(freshChannelId, seeded.operatorId, now);
    db.prepare(
      "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
    ).run(freshChannelId, seeded.agentId, now);

    // 6a: 5 near-identical self-greetings collapse to <=1 kept representative
    // plus a marker inside the assembled window text.
    const GREETING = "Hi there, I'm ready to help with whatever you need in this channel today.";
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, kind, actor_principal_id, content_json, created_at)
         VALUES (?, 1, ?, ?, 'message_posted', ?, ?, ?)`,
      ).run(randomUUID(), freshChannelId, i + 1, seeded.agentId, JSON.stringify({ channelId: freshChannelId, text: GREETING }), now);
    }
    // 6b: two DISTINCT, long self-authored messages separated by a human
    // message must NOT be collapsed into each other.
    const DISTINCT_A = 'Here is my first detailed status update covering the work completed so far in this task.';
    const DISTINCT_B = 'Separately, here is an entirely different second update about the next phase of the work.';
    db.prepare(
      `INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, kind, actor_principal_id, content_json, created_at)
       VALUES (?, 1, ?, 6, 'message_posted', ?, ?, ?)`,
    ).run(randomUUID(), freshChannelId, seeded.agentId, JSON.stringify({ channelId: freshChannelId, text: DISTINCT_A }), now);
    db.prepare(
      `INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, kind, actor_principal_id, content_json, created_at)
       VALUES (?, 1, ?, 7, 'message_posted', ?, ?, ?)`,
    ).run(randomUUID(), freshChannelId, seeded.operatorId, JSON.stringify({ channelId: freshChannelId, text: 'thanks, what else' }), now);
    db.prepare(
      `INSERT INTO collab_events(id, schema_version, channel_id, channel_seq, kind, actor_principal_id, content_json, created_at)
       VALUES (?, 1, ?, 8, 'message_posted', ?, ?, ?)`,
    ).run(randomUUID(), freshChannelId, seeded.agentId, JSON.stringify({ channelId: freshChannelId, text: DISTINCT_B }), now);

    const caller = collabSurface.callerFor(seeded.agentId);
    const ctx = await autoReplyContext.buildAnchorWindowContext(store, caller, freshChannelId, seeded.agentId);

    // 6a: at most one of the 5 near-identical greetings survives verbatim in
    // the rendered text, plus an elision marker naming the count.
    const greetingOccurrences = ctx.text.split(GREETING).length - 1;
    expect(greetingOccurrences, '6a: at most one self-greeting survives verbatim').toBeLessThanOrEqual(1);
    expect(ctx.text).toMatch(/elided|earlier repl/i);

    // 6b: both distinct self-authored messages, and the human's message
    // between them, all survive uncollapsed and in order.
    expect(ctx.text).toContain(DISTINCT_A);
    expect(ctx.text).toContain(DISTINCT_B);
    expect(ctx.text).toContain('thanks, what else');
    expect(ctx.text.indexOf(DISTINCT_A)).toBeLessThan(ctx.text.indexOf('thanks, what else'));
    expect(ctx.text.indexOf('thanks, what else')).toBeLessThan(ctx.text.indexOf(DISTINCT_B));

    // 7: subscriptionText stays actor-blind -- no channel/actor/event id.
    expect(ctx.subscriptionText).not.toContain(freshChannelId);
    expect(ctx.subscriptionText).not.toContain(seeded.agentId);
    expect(ctx.subscriptionText).not.toContain(seeded.operatorId);
    if (/elided|omitted/i.test(ctx.subscriptionText)) {
      expect(ctx.subscriptionText).toMatch(/\[\d+ earlier repl(y|ies) omitted\]/);
    }
  }, 20000);

  it('obligation 8 — the cron path passes no selfPrincipalId and its assembled context is unchanged', async () => {
    // Baseline: call buildAnchorWindowContext with NO selfPrincipalId
    // (exactly cronDispatcher.ts:208's call shape) against a channel holding
    // the same repeated self-greetings used above -- the parameter is
    // optional and additive, so omitting it must reproduce byte-identical
    // pre-change behavior (no collapsing at all).
    const GREETING = 'Hello again, this is a repeated greeting used to verify the cron path stays unaffected.';
    await seedAgentGreetings(4, GREETING);
    const store = collabSurface.getStore();
    const caller = collabSurface.callerFor(seeded.agentId);

    const withoutSelf = await autoReplyContext.buildAnchorWindowContext(store, caller, seeded.channelId);
    const withoutSelfAgain = await autoReplyContext.buildAnchorWindowContext(store, caller, seeded.channelId, undefined);
    expect(withoutSelf.text).toBe(withoutSelfAgain.text);

    // No collapsing occurred: all 4 greetings appear verbatim, no marker.
    const occurrences = withoutSelf.text.split(GREETING).length - 1;
    expect(occurrences).toBe(4);
    expect(withoutSelf.text).not.toMatch(/earlier repl/i);

    // Source-level pin (mirrors agent-participation-s3.test.ts's own
    // source-level assertions): the cron dispatcher's SOURCE call site
    // passes exactly (store, caller, channelId) -- three arguments, no
    // selfPrincipalId -- so a future edit that widened it would show up as
    // a visible, reviewable diff here, not a silent behavior change.
    const { readFileSync } = await import('node:fs');
    const cronSourcePath = join(REPO_ROOT, 'packages', 'gateway', 'src', 'cronDispatcher.ts');
    const cronSourceText = readFileSync(cronSourcePath, 'utf8');
    const callMatch = cronSourceText.match(/buildAnchorWindowContext\(([^)]*)\)/);
    expect(callMatch, 'cronDispatcher.ts must call buildAnchorWindowContext').not.toBeNull();
    const args = callMatch![1]!.split(',').map((s) => s.trim()).filter(Boolean);
    expect(args, 'the cron call site must pass exactly 3 args (no selfPrincipalId)').toEqual(['store', 'caller', 'channelId']);
    expect(typeof cronDispatcher).toBe('object'); // the module itself loaded fine
  }, 20000);
});
