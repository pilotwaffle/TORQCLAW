/**
 * A failed agent turn must NOT re-enter the coalescing cascade.
 *
 * WHAT THIS PROVES
 * ----------------
 * dispatchOneTurn (packages/gateway/src/autoReplyDispatcher.ts) catches a
 * throw from runAgentTurn and then, in its `finally`, re-dispatches a
 * coalesced follow-up when the dirty flag is set. Before the `failed` guard,
 * a DETERMINISTIC failure -- the §5A pre-dispatch profile assertion, which
 * throws when 'collab__post_message' is not admitted by the effective profile
 * -- therefore re-entered the cascade and threw again at the next
 * channel_seq, once per lap.
 *
 * The cascade was already BOUNDED (collab_agent_turns' PRIMARY KEY is
 * (channel_id, agent_principal_id, channel_seq), which excludes
 * trigger_event_id, so `coalesced:${randomUUID()}` mints no new claim for an
 * already-claimed triple; and a turn that dies before dispatch commits no
 * collab_events row, so it cannot advance the seq itself) and LOUD
 * (console.error per lap). The guard stops the pointless laps, not a runaway.
 *
 * WHY THE FAILURE HERE IS REAL, NOT INJECTED
 * ------------------------------------------
 * Nothing stubs or monkey-patches the assertion. runAgentTurn computes
 * requiredTools via the REAL predictTools (packages/bridge/src/toolFilter.ts),
 * which filters the REAL live bridge registry. In the FAILING test the collab
 * MCP server is simply NOT REGISTERED, so 'collab__post_message' does not
 * exist in the registry, predictTools cannot return it, and the genuine §5A
 * assertion at autoReplyDispatcher.ts fires and throws on its own. The
 * POSITIVE CONTROL then registers the real collab server in-process and the
 * identical code path succeeds.
 *
 * That registration order is why both cases live in ONE file in THIS order:
 * packages/bridge/src/registry.ts exposes connectInProcessServer but NO
 * unregister/disconnect, so the registry can only be filled, never emptied.
 * Vitest's default per-file isolation gives this file its own module
 * registry, so the empty-registry window exists only before the positive
 * control's beforeAll-equivalent registration.
 *
 * THE SEAM (identical to tests/agent-participation-a3c.test.ts)
 * ------------------------------------------------------------
 * setAutoReplyDispatchForTest replaces ONLY the dispatch() call. Profile
 * resolution, the §5A assertion, claimAgentTurn's PK idempotency, the
 * inFlight/dirty coalescing machinery, STOP, and resolveAgentTurn are all the
 * REAL built artifact. In the failing test the override is never even reached
 * -- the assertion throws BEFORE any GatewayRequest is minted.
 *
 * ASSERTIONS ARE ON DATABASE ROWS (collab_agent_turns), never on return
 * values or emitted frames: a dropped follow-up is visible as the ABSENCE of
 * a turn row at the second seq, and the positive control's coalesced
 * follow-up is visible as its PRESENCE.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runCollaborationMigration, runAgentAutoreplyMigration } from '../packages/collab/src/index.js';
import { ensureGatewayBuild, GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

const REPO_ROOT = join(GATEWAY_DIST_ENTRY, '..', '..', '..', '..');
const GATEWAY_DIST_DIR = join(REPO_ROOT, 'packages', 'gateway', 'dist');
const COLLAB_DIST_DIR = join(REPO_ROOT, 'packages', 'collab', 'dist');
const BRIDGE_DIST_DIR = join(REPO_ROOT, 'packages', 'bridge', 'dist');

beforeAll(async () => { await ensureGatewayBuild(); }, 200000);

function nowIso(): string { return new Date().toISOString(); }

type Seeded = {
  collabDbPath: string;
  operatorId: string;
  agentAId: string;
  channelId: string;
};

/** One operator + ONE agent. A single agent keeps the turn bookkeeping
 *  unambiguous: every collab_agent_turns row in the channel belongs to this
 *  agent, so a row's presence/absence at a given seq is a direct statement
 *  about the coalescing decision under test. */
function seedOneAgentChannel(dbPath: string): Seeded {
  const db = new Database(dbPath);
  runCollaborationMigration(db);
  runAgentAutoreplyMigration(db);
  const operatorId = randomUUID();
  const agentAId = randomUUID();
  const now = nowIso();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(operatorId, now, now);
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'AgentA', ?, 'active', 1, NULL, ?, ?)",
  ).run(agentAId, operatorId, now, now);
  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Solo', 'solo', 'active', ?, 1, ?, ?)",
  ).run(channelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, operatorId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(channelId, agentAId, now);
  db.close();
  return { collabDbPath: dbPath, operatorId, agentAId, channelId };
}

function agentTurnRows(
  dbPath: string,
  channelId: string,
): Array<{ agentPrincipalId: string; channelSeq: number; triggerEventId: string; state: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT agent_principal_id AS agentPrincipalId, channel_seq AS channelSeq,
                trigger_event_id AS triggerEventId, state
           FROM collab_agent_turns WHERE channel_id = ? ORDER BY channel_seq ASC`,
      )
      .all(channelId) as Array<{ agentPrincipalId: string; channelSeq: number; triggerEventId: string; state: string }>;
  } finally {
    db.close();
  }
}

describe('a failed agent turn does not re-enter the coalescing cascade', () => {
  let dataDir: string;
  let seeded: Seeded;
  let collab: typeof import('../packages/collab/dist/index.js');
  let bridge: typeof import('../packages/bridge/dist/index.js');
  let collabSurface: typeof import('../packages/gateway/dist/collabSurface.js');
  let collabAgentTools: typeof import('../packages/gateway/dist/collabAgentTools.js');
  let autoReplyDispatcher: typeof import('../packages/gateway/dist/autoReplyDispatcher.js');
  let events: typeof import('../packages/gateway/dist/events.js');
  let storage: typeof import('../packages/gateway/dist/storage.js');

  const PREV_ENV: Record<string, string | undefined> = {};
  function setEnv(key: string, value: string) {
    if (!(key in PREV_ENV)) PREV_ENV[key] = process.env[key];
    process.env[key] = value;
  }

  /** Errors the dispatcher's catch reported, captured by wrapping
   *  console.error -- proof the §5A assertion is what failed, rather than the
   *  turn having quietly not run at all. */
  let capturedErrors: string[] = [];
  let realConsoleError: typeof console.error;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'torq-failguard-'));
    const pepper = Buffer.alloc(32, 0x53);
    const collabDbPath = join(dataDir, 'collab.db');
    seeded = seedOneAgentChannel(collabDbPath);

    setEnv('TORQCLAW_DATA_DIR', dataDir);
    setEnv('TORQCLAW_COLLAB_DB_PATH', collabDbPath);
    setEnv('TORQCLAW_COLLAB_ENABLED', '1');
    setEnv('TORQCLAW_COLLAB_SURFACE_COMMANDS', '1');
    setEnv('TORQCLAW_AGENT_PARTICIPATION', '1');
    setEnv('TORQCLAW_AGENT_AUTOREPLY', '1');
    setEnv('TORQCLAW_COLLAB_TEST_PEPPER', pepper.toString('base64'));

    collab = await import(pathToFileURL(join(COLLAB_DIST_DIR, 'index.js')).href) as any;
    bridge = await import(pathToFileURL(join(BRIDGE_DIST_DIR, 'index.js')).href) as any;
    collabSurface = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'collabSurface.js')).href) as any;
    collabAgentTools = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'collabAgentTools.js')).href) as any;
    autoReplyDispatcher = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'autoReplyDispatcher.js')).href) as any;
    events = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'events.js')).href) as any;
    storage = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'storage.js')).href) as any;

    // Same one real effect the a3c test replicates: production reads the
    // pepper from a FileSecretStore keyed on TORQCLAW_DATA_DIR, not the env var.
    const { setCollabSecretStoreForTest } = await import(
      pathToFileURL(join(GATEWAY_DIST_DIR, 'collabIdentity.js')).href
    ) as any;
    const { InMemorySecretStore } = collab as any;
    const secretStore = new InMemorySecretStore();
    secretStore.set('TORQCLAW/principal-pepper', pepper);
    setCollabSecretStoreForTest(secretStore);

    // The SAME wiring server.ts performs at boot.
    collabSurface.setAutoReplyTrigger((params: any) =>
      autoReplyDispatcher.onChannelMessageCommitted(params),
    );

    realConsoleError = console.error;
    console.error = (...args: any[]) => { capturedErrors.push(args.map(String).join(' ')); };

    // DELIBERATELY NOT registering the collab MCP server yet. The empty
    // registry is what makes predictTools omit 'collab__post_message' and the
    // real §5A assertion throw. The positive control registers it below.
  }, 200000);

  afterAll(() => {
    console.error = realConsoleError;
    autoReplyDispatcher.setAutoReplyDispatchForTest(null);
    collabSurface.setAutoReplyTrigger(() => {});
    for (const [key, value] of Object.entries(PREV_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { storage.resetStateDbForTest({ close: true }); } catch { /* best-effort */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  async function postAsOperator(text: string): Promise<number> {
    const store = collabSurface.getStore();
    return Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text },
        randomUUID(),
      )).cursor,
    );
  }

  it('NEGATIVE: a deterministically failing turn drops its coalesced follow-up (no turn row at the later seq)', async () => {
    capturedErrors = [];

    // Sanity: the registry really is missing the tool, so the failure below
    // is the genuine §5A assertion and not some unrelated breakage.
    const registryNames = bridge.getRegistry().map((t: any) => t.name);
    expect(
      registryNames,
      'precondition: collab__post_message must be ABSENT so the real §5A assertion fires',
    ).not.toContain('collab__post_message');

    // The dispatcher must never reach dispatch() in this test -- the §5A
    // assertion throws before any GatewayRequest is minted. This override
    // exists purely to PROVE that: if it ever runs, the test fails loudly.
    let dispatchWasCalled = false;
    autoReplyDispatcher.setAutoReplyDispatchForTest(() => { dispatchWasCalled = true; });

    // Post TWO operator messages. The SECOND must be triggered while the
    // FIRST turn is still in flight -- that overlap is the ONLY thing that
    // sets the dirty flag, and the dirty flag is the exact precondition for
    // the coalesced re-dispatch this guard governs. A test that misses the
    // overlap proves nothing: the second trigger would simply take the normal
    // dispatchOneTurn path and claim its own row, which looks identical in
    // the turn table but exercises none of the coalescing code.
    //
    // Both events are committed to the substrate FIRST, so `latestChannelSeq`
    // already sees seq2 by the time the coalescing block runs. Then trigger 1
    // is started WITHOUT awaiting it, and trigger 2 is fired synchronously in
    // the same tick, before trigger 1's first real await
    // (buildAnchorWindowContext) can resolve -- guaranteeing inFlight is
    // still held and the dirty flag is set rather than raced past.
    const seq1 = await postAsOperator('first: this turn will fail structurally');
    const seq2 = await postAsOperator('second: arrives while the first turn is in flight');

    const p1 = collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: seq1, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    const p2 = collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: seq2, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    await Promise.allSettled([p1, p2]);
    // Let any (incorrect) coalesced follow-up have a real window to land.
    await new Promise((r) => setTimeout(r, 600));

    expect(dispatchWasCalled, 'the §5A assertion must throw BEFORE any dispatch').toBe(false);

    // The failure was the real structural assertion, and it was LOUD.
    expect(
      capturedErrors.some((e) => e.includes("agent turn cannot post")),
      `expected the real §5A failure to be logged; saw: ${JSON.stringify(capturedErrors)}`,
    ).toBe(true);

    // ---- THE ASSERTION, ON DATABASE ROWS ----
    const turns = agentTurnRows(seeded.collabDbPath, seeded.channelId);

    // The first turn WAS claimed and DID resolve terminated (§5A resolves the
    // row 'terminated' before throwing). Without this, "no second row" could
    // pass vacuously against a build that never claimed anything.
    const first = turns.filter((t) => t.channelSeq === seq1);
    expect(first.length, 'the triggering turn must have been claimed').toBe(1);
    expect(first[0]!.state, 'the §5A assertion resolves the turn terminated before throwing').toBe('terminated');

    // THE OVERLAP ACTUALLY HAPPENED -- this test is not the vacuous variant.
    // Trigger 2 arrived while turn 1 held inFlight, so it set the dirty flag
    // and RETURNED without claiming anything of its own. Had the overlap been
    // missed, trigger 2 would have taken the normal dispatchOneTurn path and
    // claimed seq2 directly with its own plain-UUID trigger id -- so the
    // absence of ANY seq2 row is simultaneously the proof that the coalescing
    // path was the one under test and the proof that its follow-up was
    // dropped. (An earlier revision of this test raced past the overlap and
    // found exactly such a plain-UUID row at seq2; that is what this asserts
    // against.)
    const second = turns.filter((t) => t.channelSeq === seq2);
    expect(
      second,
      `a failed turn must not re-dispatch a coalesced follow-up, and trigger 2 must have ` +
      `coalesced rather than claimed directly; found: ${JSON.stringify(second)}`,
    ).toEqual([]);
    expect(
      turns.filter((t) => t.triggerEventId.startsWith('coalesced:')),
      'no coalesced turn row may exist after a structural failure',
    ).toEqual([]);
    // Exactly ONE turn row in total: the failed one. Nothing else was claimed.
    expect(turns.length, `exactly one turn (the failed one) must exist; got ${JSON.stringify(turns)}`).toBe(1);

    // DROPPED, NOT DEFERRED: `dirty` is cleared BEFORE the guard, so there is
    // no latent follow-up left armed. A later successful turn must therefore
    // not retroactively fire the skipped one. (The positive control below
    // proves the coalescing machinery is not simply dead.)
    await new Promise((r) => setTimeout(r, 300));
    expect(
      agentTurnRows(seeded.collabDbPath, seeded.channelId).filter((t) => t.channelSeq === seq2),
      'the skipped follow-up must be DROPPED, never deferred into a later firing',
    ).toEqual([]);
  }, 30000);

  it('POSITIVE CONTROL: with the tool admitted, a SUCCESSFUL turn with a dirty flag DOES coalesce and re-dispatch', async () => {
    capturedErrors = [];

    // Register the REAL in-process collab MCP server. predictTools now finds
    // collab__post_message, the §5A assertion passes, and the identical code
    // path succeeds -- so a green NEGATIVE test above cannot be explained by
    // a build that never dispatches anything at all.
    await bridge.connectInProcessServer(
      collabAgentTools.COLLAB_AGENT_SERVER_ID,
      collabAgentTools.buildCollabAgentMcpServer(),
      { capabilities: collabAgentTools.COLLAB_AGENT_TOOL_CAPABILITIES },
    );
    expect(
      bridge.getRegistry().map((t: any) => t.name),
      'positive control precondition: the tool must now be admitted',
    ).toContain('collab__post_message');

    // A turn that SUCCEEDS (posts nothing -- 'no_post' is a valid outcome per
    // A3-f) and holds the in-flight slot long enough for a second trigger to
    // set the dirty flag. The delay is what guarantees the overlap the
    // coalescing path requires.
    autoReplyDispatcher.setAutoReplyDispatchForTest((req: any, diag: any) => {
      void (async () => {
        events.taskStore.create(req, diag);
        await new Promise((r) => setTimeout(r, 400));
        events.taskStore.complete(req.id, 'ok', {});
      })();
    });

    const before = agentTurnRows(seeded.collabDbPath, seeded.channelId).length;

    const seq1 = await postAsOperator('positive control: first');
    const p1 = collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: seq1, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    // Let the first turn get in-flight before the second trigger arrives, so
    // this lands on the dirty path rather than racing ahead of the claim.
    await new Promise((r) => setTimeout(r, 100));
    const seq2 = await postAsOperator('positive control: second, while first is in flight');
    const p2 = collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: seq2, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    await Promise.allSettled([p1, p2]);

    // Wait for the coalesced follow-up to claim and resolve.
    const deadline = Date.now() + 10000;
    let coalesced: Array<{ channelSeq: number; triggerEventId: string; state: string }> = [];
    while (Date.now() < deadline) {
      const rows = agentTurnRows(seeded.collabDbPath, seeded.channelId);
      coalesced = rows.filter((t) => t.triggerEventId.startsWith('coalesced:'));
      if (coalesced.length > 0 && coalesced.every((t) => t.state !== 'dispatched')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const after = agentTurnRows(seeded.collabDbPath, seeded.channelId);
    expect(after.length, 'the successful path must add turn rows').toBeGreaterThan(before);

    // THE POSITIVE CONTROL, ON DATABASE ROWS: a coalesced follow-up row
    // exists. This is exactly the row the negative test proved absent.
    expect(
      coalesced.length,
      `a successful turn with a dirty flag MUST coalesce and re-dispatch; rows=${JSON.stringify(after)}`,
    ).toBeGreaterThan(0);
    expect(
      coalesced.some((t) => t.channelSeq === seq2),
      `the coalesced follow-up must claim the latest seq (${seq2}); coalesced=${JSON.stringify(coalesced)}`,
    ).toBe(true);

    // And it succeeded -- no §5A failure on this path.
    for (const t of coalesced) {
      expect(['completed', 'no_post'], `coalesced turn @${t.channelSeq} must not have failed structurally`)
        .toContain(t.state);
    }
    expect(
      capturedErrors.filter((e) => e.includes('agent turn cannot post')),
      'the positive control must produce no §5A failures',
    ).toEqual([]);
  }, 30000);
});
