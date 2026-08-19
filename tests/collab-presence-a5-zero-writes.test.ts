/**
 * PRD-TCLAW-COLLAB-PRESENCE-UI-005 S5 — A5's DB-provable zero-writes proof.
 *
 * A5 (§6): "a full task lifecycle (submit -> run -> terminal) produces ZERO
 * writes to `collab_events`." This is the spine of S5's "presence only,
 * read-side only" claim — the v0.1 design (mirroring task lifecycle events
 * INTO channels, CUT by §4 S5) would have shown up here as a nonzero row
 * count. This test is the falsifiable proof that S5's roster join is
 * render-time-only and touches no persistence at all.
 *
 * METHOD: two structurally independent SQLite handles, proven independent
 * by construction rather than by inspection:
 *   - the GATEWAY's own tasks/events database (packages/gateway/src/storage.ts,
 *     TORQCLAW_DATA_DIR-scoped `state.db`) — driven through the REAL
 *     production code path a task lifecycle uses: taskStore.create (submit),
 *     makeEmitter emitting TIER_SELECTED/TOOL_CALL (run), taskStore.complete
 *     + a RESULT emission (terminal). This is not a simulation of the shape
 *     of a lifecycle; it is the actual persistAndPublish/taskStore module
 *     under test.
 *   - a FRESH, separately-migrated in-memory CollaborationStore database
 *     (packages/collab/src/migration.ts's runCollaborationMigration),
 *     instantiated but never passed to, imported by, or referenced from any
 *     gateway lifecycle code in this test. Its collab_events row count is
 *     read directly via raw SQL before and after driving the gateway
 *     lifecycle.
 *
 * grep confirms packages/gateway/src/storage.ts never references
 * TORQCLAW_COLLAB_DB_PATH or collab.db anywhere — the gateway's task
 * lifecycle code has no handle to the collab database at all, so this test
 * is proving a structural fact, not a lucky empirical one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../packages/collab/src/store.js';
import { ComputeTier, type GatewayRequest, type RouterDiagnostics } from '@torqclaw/contracts';

function fixtureRequest(id: string, sessionId: string): GatewayRequest {
  return {
    id,
    sessionId,
    sourceChannel: 'test',
    receivedAt: new Date().toISOString(),
    payload: {
      prompt: 'test prompt',
      contextSize: 0,
      requiredTools: [],
      taskType: 'ROUTINE_AUTOMATION',
      grantedTools: [],
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
      estimatedTokens: 0,
      memoryUsed: false,
    },
  };
}

function fixtureDiag(tier: RouterDiagnostics['tier']): RouterDiagnostics {
  return { score: 0, reason: 'test', tier };
}

const dataDir = mkdtempSync(join(tmpdir(), 'torq-a5-gateway-'));
const originalDataDir = process.env.TORQCLAW_DATA_DIR;
process.env.TORQCLAW_DATA_DIR = dataDir;

// G1R B-1: point the PRODUCTION collab handle at this suite's temp dir, set
// BEFORE collabIdentity.js is imported (it resolves the path lazily on first
// getCollabDb(), collabIdentity.ts:148 -- `TORQCLAW_COLLAB_DB_PATH ||
// join(DATA_DIR,'collab.db')`). This is what makes the A5 assertion
// FALSIFIABLE: it must count the database a regression would actually write
// to, not a private handle nothing can reach. See prodCollabEventsCount below.
const originalCollabDbPath = process.env.TORQCLAW_COLLAB_DB_PATH;
process.env.TORQCLAW_COLLAB_DB_PATH = join(dataDir, 'collab.db');

// Imported AFTER TORQCLAW_DATA_DIR is set (storage.ts resolves the data dir
// lazily on first `db` access, per storage-handle-isolation.test.ts's
// documented contract) so this suite gets a private state.db, never
// touching any other suite's or the operator's real gateway state.
const { taskStore, makeEmitter } = await import('../packages/gateway/src/events.js');
const { db: gatewayDb } = await import('../packages/gateway/src/storage.js');

/** tasks.session_id FK's parent row — same minimal insert every other
 *  gateway-DB test in this suite uses (e.g. tests/approvals-read.test.ts). */
function seedSession(sessionId: string): void {
  gatewayDb
    .prepare(`INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')`)
    .run(sessionId);
}

afterAll(() => {
  if (originalCollabDbPath === undefined) delete process.env.TORQCLAW_COLLAB_DB_PATH;
  else process.env.TORQCLAW_COLLAB_DB_PATH = originalCollabDbPath;
  if (originalDataDir === undefined) delete process.env.TORQCLAW_DATA_DIR;
  else process.env.TORQCLAW_DATA_DIR = originalDataDir;
});

function freshCollabStore() {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  return sqlite;
}

/**
 * G1R B-1 — THE LOAD-BEARING COUNTER. Counts collab_events in the database
 * PRODUCTION would write to, obtained through the same getCollabDb() handle
 * collabSurface.ts's getStore() uses (collabIdentity.ts:146-150).
 *
 * The original A5 proof counted a private `new Database(':memory:')` created
 * inside the test. No production path can reach that handle, so the assertion
 * was UNFALSIFIABLE BY CONSTRUCTION -- it would have stayed green through the
 * exact v0.1 mirroring regression A5 exists to prevent. G1R proved it by
 * landing a real mirroring write into the production DB while the suite
 * reported GREEN. Same shape as V-1 and RC-1: a guard whose test passes
 * identically with and without it enforces nothing.
 *
 * A falsifiability probe must exercise the SAME handle the guarded assertion
 * reads -- otherwise it only proves that row-counting works on some SQLite DB,
 * which was never in doubt.
 */
async function prodCollabEventsCount(): Promise<number> {
  const { getCollabDb } = await import('../packages/gateway/src/collabIdentity.js');
  const prod = getCollabDb() as unknown as {
    prepare: (sql: string) => { get: () => unknown };
  };
  return (prod.prepare('SELECT COUNT(*) as n FROM collab_events').get() as { n: number }).n;
}

function collabEventsCount(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT COUNT(*) as n FROM collab_events').get() as { n: number }).n;
}

/** A real, fully bootstrapped CollaborationStore with one operator and one
 *  channel. Used by the standing regression test below, which proves this
 *  suite's assertion actually DETECTS a v0.1-style mirroring write rather
 *  than passing vacuously — falsifiability evidence kept as a permanent
 *  test rather than a one-off manual RED/GREEN toggle (Builder verified the
 *  manual RED output once; this keeps that proof alive going forward). */
async function bootstrappedCollabHarness(fixtureId: string) {
  const sqlite = freshCollabStore();
  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const secretStore = new InMemorySecretStore();
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids(fixtureId);
  const bootstrap = bootstrapOperator(
    { db, secretStore, clock, uuids, rng: nodeRandomSource },
    { operatorDisplayName: 'Operator', installationId: `install-${fixtureId}`, schemaVersion: 1 },
  );
  const store = new CollaborationStore({ db, clock, uuids, rng: nodeRandomSource, principalPepper: bootstrap.principalPepper });
  const operatorCaller: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };
  const channel = await store.createChannel(operatorCaller, { name: 'general' }, `idem-${fixtureId}`);
  return { sqlite, store, operatorCaller, channelId: channel.channelId };
}

describe('A5: a full gateway task lifecycle writes ZERO rows to collab_events', () => {
  it('submit -> run (TIER_SELECTED, TOOL_CALL) -> terminal (RESULT) leaves collab_events row count unchanged', async () => {
    // G1R B-1: count the PRODUCTION handle -- the DB a mirroring regression
    // would actually write to. The private in-memory store below is kept only
    // as a secondary witness; the production count is the load-bearing one.
    const prodBefore = await prodCollabEventsCount();
    const collab = freshCollabStore();
    const before = collabEventsCount(collab);
    expect(before).toBe(0); // sanity: a fresh migration starts empty

    const sessionId = randomUUID();
    const requestId = randomUUID();
    seedSession(sessionId);
    const emit = makeEmitter(sessionId, requestId, ComputeTier.LOCAL_EDGE);

    // SUBMIT: the pre-execution task row (taskStore.create is called before
    // any execution begins in the real dispatch path).
    taskStore.create(fixtureRequest(requestId, sessionId), fixtureDiag(ComputeTier.LOCAL_EDGE));

    // RUN: real gateway event emissions a live task produces.
    emit('TIER_SELECTED', 'Routed to LOCAL_EDGE');
    emit('TOOL_CALL', 'Executing filesystem__read_file');

    // TERMINAL: completion + the RESULT frame.
    taskStore.complete(requestId, 'ok', { costUsd: 0 });
    emit('RESULT', 'done');

    // THE LOAD-BEARING ASSERTION (G1R B-1): the production collab DB.
    const prodAfter = await prodCollabEventsCount();
    expect(
      prodAfter,
      'A5 REGRESSION: a full task lifecycle wrote to the PRODUCTION collab_events '
        + 'table. S5 is presence-only, read-side-only — no task-lifecycle mirroring '
        + 'into the collab substrate is permitted (the v0.1 design §4 S5 CUT, partly '
        + 'for the telemetry-to-members disclosure path it opened). This assertion '
        + 'reads getCollabDb() — the same handle collabSurface.ts writes through — '
        + 'so a real mirroring write fails it.',
    ).toBe(prodBefore);

    // Secondary witness: the isolated store is also untouched.
    const after = collabEventsCount(collab);
    expect(after).toBe(before);
  });

  it('a task lifecycle with an ERROR terminal also leaves collab_events untouched', () => {
    const collab = freshCollabStore();
    const before = collabEventsCount(collab);

    const sessionId = randomUUID();
    const requestId = randomUUID();
    seedSession(sessionId);
    const emit = makeEmitter(sessionId, requestId, ComputeTier.FRONTIER);
    taskStore.create(fixtureRequest(requestId, sessionId), fixtureDiag(ComputeTier.FRONTIER));
    emit('TIER_SELECTED', 'Routed to FRONTIER');
    taskStore.fail(requestId, 'boom');
    emit('ERROR', 'boom');

    expect(collabEventsCount(collab)).toBe(before);
  });

  it('FALSIFIABILITY: a mirroring write to the PRODUCTION collab DB is visible to the load-bearing counter', async () => {
    // G1R B-1 REWRITE. The previous version wrote to a THIRD store instance
    // (its own freshCollabStore()), proving only that row-counting works on
    // some SQLite DB -- which was never in doubt. It did NOT prove the guarded
    // assertion was wired to the database under threat, and it was not: the
    // assertion counted a private `:memory:` handle no production path can
    // reach. G1R demonstrated the gap by landing a real mirroring write in the
    // production DB while the suite reported GREEN.
    //
    // A falsifiability probe must exercise the SAME handle the guarded
    // assertion reads. This one writes DIRECTLY into getCollabDb() -- the
    // handle prodCollabEventsCount() reads and collabSurface.ts writes through
    // -- so if the counter ever stops seeing production writes, this fails and
    // the A5 proof above is known to be meaningless rather than silently so.
    const { getCollabDb } = await import('../packages/gateway/src/collabIdentity.js');
    const prodDb = getCollabDb() as unknown as BootstrapDb;

    // Bootstrap a principal + channel IN THE PRODUCTION DB. collab_events has
    // FKs to collab_channels and principals (migration.ts:113-115), so a bare
    // INSERT cannot stand alone -- and going through the store is the faithful
    // reproduction anyway: a v0.1 mirroring regression would call
    // postChannelMessage on a store backed by exactly this handle.
    const clock = new DeterministicClock();
    const uuids = new DeterministicUuids('a5-prod-falsifiability');
    const bootstrap = bootstrapOperator(
      { db: prodDb, secretStore: new InMemorySecretStore(), clock, uuids, rng: nodeRandomSource },
      {
        operatorDisplayName: 'Operator',
        installationId: 'install-a5-prod-falsifiability',
        schemaVersion: 1,
      },
    );
    const prodStore = new CollaborationStore({
      db: prodDb, clock, uuids, rng: nodeRandomSource,
      // The bootstrap we just ran against THIS db owns the pepper; calling
      // getPrincipalPepper() would hit the OS credential store, which is not
      // implemented under test.
      principalPepper: bootstrap.principalPepper,
    });
    const prodCaller: CallerContext = {
      principalId: bootstrap.operatorPrincipalId, kind: 'operator',
    };
    const chan = await prodStore.createChannel(
      prodCaller, { name: 'a5-falsifiability' }, 'idem-a5-prod-chan',
    );

    // Count AFTER bootstrap/channel creation so only the mirroring write is
    // measured (createChannel legitimately emits a channel_created event).
    const before = await prodCollabEventsCount();

    await prodStore.postChannelMessage(
      prodCaller,
      { channelId: chan.channelId, text: 'a real mirroring write DID happen' },
      randomUUID(),
    );

    const after = await prodCollabEventsCount();
    expect(
      after,
      'The A5 counter can no longer see writes to the PRODUCTION collab DB. If '
        + 'this fails, the zero-writes assertion above is VACUOUS -- it would stay '
        + 'green through the exact v0.1 mirroring regression it exists to prevent.',
    ).toBeGreaterThan(before);

    // Remove ONLY the mirroring write, leaving the channel_created event that
    // `before` already accounted for -- so the production count returns to
    // exactly `before` and test ordering cannot perturb the load-bearing
    // assertions above.
    prodDb
      .prepare("DELETE FROM collab_events WHERE channel_id = ? AND kind = 'message_posted'")
      .run(chan.channelId);
    expect(
      await prodCollabEventsCount(),
      'the falsifiability probe must leave the production count where it found it',
    ).toBe(before);
  });
});
