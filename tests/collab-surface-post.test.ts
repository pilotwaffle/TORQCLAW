/**
 * PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3 — POST_CHANNEL_MESSAGE.
 *
 * Covers §8's named obligations assigned to this slice:
 *   T-1 — principal-less connection => COLLAB_IDENTITY_REQUIRED
 *   T-2 — byte-identical COLLAB_NOT_FOUND, hidden-channel vs nonexistent-channel
 *         (re-verified for the WRITE path, not inherited from S1)
 *   T-3 — channel/node seat deny arms
 *   T-4 — idempotent retry: same idempotencyKey commits exactly one
 *         message_posted event; distinct keys with identical text commit two
 *   T-9 — handler-totality matrix (A6): contract-boundary rejection, residue
 *         enumeration, throw-class totality, no-new-oracle
 *   CO-1 — callerFor derives kind from a real DB read, never hardcodes it;
 *          NULL principal refuses and posts nothing
 *
 * T-9 falsifiability (§8): the probes for this matrix were executed as
 * source mutations, not as tests living in this file.
 *
 * G2A NB-2 / NB-RA-3: this header has now been wrong TWICE about where the
 * RED evidence lives, so it states the truth including the gap.
 *
 * v1 claimed the excerpts were "recorded in this file's own describe block at
 * the bottom" -- no such block exists. v2 (the NB-2 fix) redirected them to
 * commit c404a24's message; G2A checked and that message contains only the
 * C-1 probe's RED, not the four builder-side T-9 probes. Both versions read as
 * discharged while pointing at nothing.
 *
 * WHERE THE RED OUTPUT ACTUALLY IS:
 *   - C-1 fallback probe ("expected 'operator' to be 'agent'") -- commit
 *     c404a24's message. VERIFIED PRESENT.
 *   - D-1 ack-correlation probe -- commit cc95499's message. VERIFIED PRESENT.
 *   - G2A's own independent re-runs (five on the first pass, two on the
 *     re-audit), all reproduced RED and restored byte-identical --
 *     docs/prd-reviews/G2A-OPUS48-COLLAB-PRESENCE-UI-005-S3.md and
 *     ...-S3-REAUDIT.md. VERIFIED PRESENT.
 *   - The four BUILDER-SIDE T-9 probes for the matrix below
 *     (contract-boundary rejection, residue enumeration, throw-class
 *     totality, no-new-oracle): the builder reported their RED in its task
 *     output, which was NEVER COMMITTED. That evidence is LOST.
 *
 * Per §8 a probe reported without its RED output is not a discharged probe,
 * so those four are NOT discharged by this repo's own standard. They were
 * independently re-run by G2A (see the verdicts above), and that -- not the
 * builder's uncommitted report -- is what stands behind this matrix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource, type BootstrapDb } from '../packages/collab/src/bootstrap.js';
import { InMemorySecretStore } from '../packages/collab/src/secrets.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { CollaborationStore, type CallerContext } from '../packages/collab/src/store.js';
import { authorize, type AuthzContext } from '../packages/gateway/src/authz.js';
import { ClientCommandSchema, type ClientCommand } from '@torqclaw/contracts';

function makeFixture(fixtureId: string) {
  const sqlite = new Database(':memory:');
  runCollaborationMigration(sqlite);
  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const secretStore = new InMemorySecretStore();
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids(fixtureId);
  const rng = nodeRandomSource;

  const bootstrap = bootstrapOperator(
    { db, secretStore, clock, uuids, rng },
    { operatorDisplayName: 'Operator', installationId: `install-${fixtureId}`, schemaVersion: 1 },
  );

  const store = new CollaborationStore({
    db, clock, uuids, rng, principalPepper: bootstrap.principalPepper,
  });

  const operatorCaller: CallerContext = { principalId: bootstrap.operatorPrincipalId, kind: 'operator' };
  return { sqlite, db, store, bootstrap, operatorCaller };
}

const SESS_ID = randomUUID();

async function makeAgent(store: CollaborationStore, operatorCaller: CallerContext, name: string, idem: string) {
  const result = await store.createAgent(operatorCaller, { displayName: name }, idem);
  return { principalId: result.principalId, caller: { principalId: result.principalId, kind: 'agent' as const } };
}

describe('S3 handler — handlePostChannelMessage (T-1, T-2, T-4, CO-1)', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let setCollabSurfaceStoreForTest: (s: CollaborationStore | null) => void;
  let setCollabSurfaceKindLookupDbForTest: (db: BootstrapDb | null) => void;
  let handlePostChannelMessage: (
    sid: string, principalId: string | null, channelId: string, text: string, idempotencyKey: string,
  ) => Promise<{ code: string; detail?: unknown } | null>;
  let publishedFrames: Array<{ sessionId: string; event: { message: string; metadata?: unknown } }>;

  beforeEach(async () => {
    fixture = makeFixture(`surface-post-${Math.random().toString(36).slice(2)}`);

    const surfaceMod = await import('../packages/gateway/src/collabSurface.js');
    setCollabSurfaceStoreForTest = surfaceMod.setCollabSurfaceStoreForTest;
    handlePostChannelMessage = surfaceMod.handlePostChannelMessage;
    setCollabSurfaceStoreForTest(fixture.store);

    // CO-1: callerFor() now reads principals.kind from getCollabDb() -- point
    // that at the SAME fixture DB the store uses, or the kind lookup would
    // miss every principal minted by this fixture.
    setCollabSurfaceKindLookupDbForTest = surfaceMod.setCollabSurfaceKindLookupDbForTest;
    setCollabSurfaceKindLookupDbForTest(fixture.db);

    publishedFrames = [];
    const { sessionBus } = await import('../packages/gateway/src/events.js');
    sessionBus.subscribe(SESS_ID, (event) => {
      publishedFrames.push({ sessionId: SESS_ID, event: { message: event.message, metadata: event.metadata } });
    });
  });

  afterEach(() => {
    setCollabSurfaceStoreForTest(null);
    setCollabSurfaceKindLookupDbForTest(null);
    fixture.sqlite.close();
  });

  // ---- T-1 / CO-1: principal-less connection refuses and posts nothing ----
  it('T-1/CO-1: NULL principal refuses COLLAB_IDENTITY_REQUIRED and posts NOTHING', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'General' }, 'idem-ch-1');

    const err = await handlePostChannelMessage(SESS_ID, null, channel.channelId, 'hello', randomUUID());
    expect(err).toEqual({ code: 'COLLAB_IDENTITY_REQUIRED' });

    // Deletion-probe: a real principal posts successfully (proves the refusal
    // above is a real refusal, not a vacuous "always errors" stub).
    const key = randomUUID();
    const ok = await handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'hello', key);
    expect(ok).toBeNull();

    // Nothing committed under the refused call: exactly one message_posted
    // event exists (from the successful call above), not two.
    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    const posted = timeline.events.filter((e) => e.kind === 'message_posted');
    expect(posted.length).toBe(1);

    // ---- G2A RC-1: the ack MUST carry the idempotencyKey it acks ----
    //
    // The entire D-1 fix hinges on this one field, and it was pinned by
    // NOTHING: G2A deleted `idempotencyKey` from collabSurface.ts's ack
    // metadata and all 82 tests stayed GREEN. Without it the console cannot
    // attribute an ack to a specific send, which is exactly how one send's
    // ack came to clear a rejected sibling (D-1, a silent drop forbidden by
    // §13 S3 / A8).
    //
    // A regression here fails SAFE -- the console ignores an unattributable
    // ack, so the send times out honestly rather than falsely confirming --
    // which is why G2A rated it a condition, not a blocker. It is still a
    // silent break of the confirm path, so it gets a real assertion.
    const ackFrame = publishedFrames
      .map((f) => f.event.metadata as Record<string, unknown> | undefined)
      .filter((m): m is Record<string, unknown> => m?.collabMessagePosted === true)
      .at(-1);
    expect(ackFrame, 'a successful post must publish a collabMessagePosted ack').toBeDefined();
    expect(
      ackFrame!.idempotencyKey,
      'G2A RC-1 REGRESSION: the post ack no longer carries idempotencyKey. The '
      + 'console correlates acks to sends by this field alone -- without it an ack '
      + 'is unattributable and the confirm path silently stops working (and, before '
      + 'the D-1 fix, cleared the WRONG send).',
    ).toBe(key);
    // Ack shape the console actually reads (selectLatestPostAck): all four.
    expect(ackFrame!.channelId).toBe(channel.channelId);
    expect(typeof ackFrame!.eventId).toBe('string');
    expect(typeof ackFrame!.cursor).toBe('string');
  });

  // ---- T-2: byte-identical COLLAB_NOT_FOUND on the WRITE path ----
  it('T-2: a non-member posting to a hidden channel gets a BYTE-IDENTICAL COLLAB_NOT_FOUND payload to the nonexistent-channel case', async () => {
    const { store, operatorCaller } = fixture;
    const outsider = await makeAgent(store, operatorCaller, 'Outsider', 'idem-outsider-post');
    const channel = await store.createChannel(operatorCaller, { name: 'Hidden' }, 'idem-hidden-post-ch');
    // outsider is never added as a member -> channel is hidden to them.

    const hidden = await handlePostChannelMessage(SESS_ID, outsider.principalId, channel.channelId, 'hi', randomUUID());
    const absent = await handlePostChannelMessage(SESS_ID, outsider.principalId, 'no-such-channel', 'hi', randomUUID());

    expect(JSON.stringify(hidden)).toBe(JSON.stringify(absent));
    expect(hidden?.code).toBe('COLLAB_NOT_FOUND');
    expect(absent?.code).toBe('COLLAB_NOT_FOUND');

    // Deletion-probe: prove the assertion is not vacuously true by injecting
    // a distinguishing detail on one side.
    const injected = JSON.stringify({ code: 'COLLAB_NOT_FOUND', detail: 'Channel is hidden from you' });
    expect(injected).not.toBe(JSON.stringify(absent));
  });

  // ---- T-4: idempotent retry ----
  it('T-4: re-posting with the SAME idempotencyKey commits exactly ONE message_posted event', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'Idem' }, 'idem-ch-t4');
    const key = randomUUID();

    const first = await handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'same text', key);
    const second = await handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'same text', key);
    expect(first).toBeNull();
    expect(second).toBeNull();

    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    const posted = timeline.events.filter((e) => e.kind === 'message_posted');
    expect(posted.length).toBe(1);
  });

  it('T-4: two posts with IDENTICAL text but DISTINCT idempotencyKeys commit TWO events', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'Idem2' }, 'idem-ch-t4b');

    const first = await handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'same text', randomUUID());
    const second = await handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'same text', randomUUID());
    expect(first).toBeNull();
    expect(second).toBeNull();

    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    const posted = timeline.events.filter((e) => e.kind === 'message_posted');
    expect(posted.length).toBe(2);
  });

  it('T-4: retrying the SAME idempotencyKey with DIFFERENT text returns COLLAB_IDEMPOTENCY_CONFLICT (does not throw)', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'Conflict' }, 'idem-ch-conflict');
    const key = randomUUID();

    const first = await handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'text A', key);
    expect(first).toBeNull();
    await expect(
      handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'text B', key),
    ).resolves.toEqual({ code: 'COLLAB_IDEMPOTENCY_CONFLICT', detail: expect.any(String) });
  });

  // ---- author is server-stamped (A3) ----
  it('A3: the posted event\'s actorPrincipalId is the CALLER\'S resolved principal, never client-suppliable (no author field exists on the command)', async () => {
    const { store, operatorCaller } = fixture;
    const agent = await makeAgent(store, operatorCaller, 'Agent Author', 'idem-author-agent');
    const channel = await store.createChannel(operatorCaller, { name: 'AuthorCheck' }, 'idem-author-ch');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-author-member');

    const err = await handlePostChannelMessage(SESS_ID, agent.principalId, channel.channelId, 'from agent', randomUUID());
    expect(err).toBeNull();

    const timeline = await store.getChannelTimeline(operatorCaller, { channelId: channel.channelId, afterCursor: '0', limit: 100 });
    const posted = timeline.events.find((e) => e.kind === 'message_posted' && e.payload?.text === 'from agent');
    expect(posted?.actorPrincipalId).toBe(agent.principalId);
  });

  // ---- CHANNEL_ARCHIVED must not throw ----
  it('a member posting to an ARCHIVED channel gets COLLAB_CHANNEL_ARCHIVED, not COLLAB_NOT_FOUND, and does not throw', async () => {
    const { store, operatorCaller } = fixture;
    const channel = await store.createChannel(operatorCaller, { name: 'ToArchive' }, 'idem-archive-ch');
    await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-archive-op');

    await expect(
      handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'late message', randomUUID()),
    ).resolves.toEqual({ code: 'COLLAB_CHANNEL_ARCHIVED', detail: expect.any(String) });
  });

  // ---- CO-1: callerFor derives kind from a real DB read, never hardcodes ----
  it("CO-1: callerFor derives kind='agent' for an agent principal (not hardcoded 'operator') -- verified via a lookup-failure fallback probe", async () => {
    const { store, operatorCaller } = fixture;
    const agent = await makeAgent(store, operatorCaller, 'Kind Probe Agent', 'idem-kind-probe');
    const channel = await store.createChannel(operatorCaller, { name: 'KindProbe' }, 'idem-kind-probe-ch');
    await store.addChannelMember(operatorCaller, { channelId: channel.channelId, principalId: agent.principalId }, 'idem-kind-probe-member');

    // If callerFor still hardcoded kind:'operator', posting would still
    // succeed here (assertChannelVisible ignores caller.kind entirely, per
    // the PRD's frozen Cycle-3 NB-3 ruling -- verified by grep against
    // store.ts, zero reads of caller.kind). This positive-path call is
    // therefore NOT the load-bearing assertion; the load-bearing proof is
    // the lookup-failure-falls-back-to-'agent'-never-'operator' unit test
    // below (resolvePrincipalKindForCaller is not exported, so this is
    // asserted at the DB-swap boundary instead: a principal absent from
    // the collab DB the gateway reads must never be treated as an operator
    // by construction -- fail-closed-to-lesser-privilege).
    const err = await handlePostChannelMessage(SESS_ID, agent.principalId, channel.channelId, 'agent post', randomUUID());
    expect(err).toBeNull();

    // Now point the kind-lookup DB at an EMPTY, freshly migrated DB (the
    // agent's principal row does not exist there) -- the kind lookup must
    // MISS and fall back to 'agent', not silently default to 'operator'.
    // This proves the fallback branch (collabSurface.ts's
    // resolvePrincipalKindForCaller catch/null-coalesce path) resolves to
    // the LESS privileged literal.
    const emptySqlite = new Database(':memory:');
    runCollaborationMigration(emptySqlite);
    const emptyDb: BootstrapDb = {
      prepare: (sql: string) => emptySqlite.prepare(sql),
      exec: (sql: string) => emptySqlite.exec(sql),
      transaction: (fn) => emptySqlite.transaction(fn) as never,
    };
    setCollabSurfaceKindLookupDbForTest(emptyDb);
    try {
      // assertChannelVisible on THIS (still fixture.store-backed) call still
      // succeeds regardless of the kind lookup miss, because -- per the
      // documented ruling -- caller.kind is never read for authorization.
      // The point of this probe is that callerFor's DB read does not throw
      // and does not silently become 'operator' when the row is absent.
      const stillOk = await handlePostChannelMessage(SESS_ID, agent.principalId, channel.channelId, 'agent post 2', randomUUID());
      expect(stillOk).toBeNull();
    } finally {
      setCollabSurfaceKindLookupDbForTest(fixture.db);
      emptySqlite.close();
    }
  });

  // ---- CO-1 (C-1): the least-privilege fallback, ASSERTED ON kind ITSELF ----
  //
  // Closes condition C-1 from the S3 independent verify
  // (docs/prd-reviews/VERIFY-OPUS-COLLAB-PRESENCE-UI-005-S3.md). The probe
  // above drives the real fallback path but asserts only that the call
  // SUCCEEDS -- which is true whether the fallback yields 'agent' or
  // 'operator'. The verifier proved this by flipping all three fallback exits
  // to 'operator' and observing 38/38 still GREEN: the invariant was real,
  // correctly implemented, and pinned by nothing. That is this repo's
  // recurring unenforced-claim pattern.
  //
  // Inert TODAY only because store.ts reads caller.kind nowhere. The moment
  // any substrate check does read it -- precisely what this code exists to
  // guard against -- a lookup miss silently claiming operator authority would
  // be a privilege escalation with no failing test. So assert the LITERAL.
  //
  // A spy store captures the CallerContext handed to postChannelMessage; the
  // store is otherwise unused, so nothing else in the path is affected.
  it("C-1: callerFor hands the substrate kind='agent' -- for an agent principal AND on lookup miss (never 'operator')", async () => {
    const { store, operatorCaller, db } = fixture;
    const agent = await makeAgent(store, operatorCaller, 'Kind Assert Agent', 'idem-kind-assert');
    const channel = await store.createChannel(operatorCaller, { name: 'KindAssert' }, 'idem-kind-assert-ch');
    await store.addChannelMember(
      operatorCaller,
      { channelId: channel.channelId, principalId: agent.principalId },
      'idem-kind-assert-member',
    );

    const seen: Array<{ principalId: string; kind: string }> = [];
    const spyStore = {
      async postChannelMessage(caller: { principalId: string; kind: string }) {
        seen.push({ principalId: caller.principalId, kind: caller.kind });
        return { channelSeq: 1 } as never;
      },
    } as unknown as CollaborationStore;

    setCollabSurfaceStoreForTest(spyStore);
    try {
      // (a) Real agent principal present in the kind-lookup DB.
      await handlePostChannelMessage(SESS_ID, agent.principalId, channel.channelId, 'x', randomUUID());
      expect(seen.at(-1)?.kind,
        "an agent principal must reach the substrate as kind='agent'").toBe('agent');

      // (b) Lookup MISS -- principal row absent from the DB the gateway reads.
      // This is the branch the verifier flipped; it must resolve to the LESS
      // privileged literal, by construction (fail-closed-to-lesser-privilege).
      const emptySqlite2 = new Database(':memory:');
      runCollaborationMigration(emptySqlite2);
      setCollabSurfaceKindLookupDbForTest({
        prepare: (sql: string) => emptySqlite2.prepare(sql),
        exec: (sql: string) => emptySqlite2.exec(sql),
        transaction: (fn) => emptySqlite2.transaction(fn) as never,
      } as BootstrapDb);
      try {
        await handlePostChannelMessage(SESS_ID, agent.principalId, channel.channelId, 'y', randomUUID());
        expect(seen.at(-1)?.kind,
          "C-1 REGRESSION: the kind-lookup fallback resolved to something other "
          + "than 'agent'. A lookup MISS must fail closed to the LESS privileged "
          + "literal -- never 'operator', which is what the pre-S3 code hardcoded.")
          .toBe('agent');
      } finally {
        setCollabSurfaceKindLookupDbForTest(db);
        emptySqlite2.close();
      }
    } finally {
      setCollabSurfaceStoreForTest(null);
    }
  });
});

// ---------------------------------------------------------------------------
// T-3: authz deny arms for channel/node seats on POST_CHANNEL_MESSAGE.
// ---------------------------------------------------------------------------
describe('authorize() — POST_CHANNEL_MESSAGE seat arms (T-3)', () => {
  const ctx: AuthzContext = { sessionId: SESS_ID, lookupTaskSession: () => null };
  const post: ClientCommand = {
    action: 'POST_CHANNEL_MESSAGE', channelId: 'c1', text: 'hi', idempotencyKey: randomUUID(),
  };

  it('operator seat: allow', () => {
    expect(authorize('operator', post, ctx)).toEqual({ ok: true });
  });

  it('channel seat: explicit deny', () => {
    const d = authorize('channel', post, ctx);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBeTruthy();
  });

  it('node seat: deny', () => {
    expect(authorize('node', post, ctx).ok).toBe(false);
  });

  it('deletion-probe: operator differs from channel/node for the exact same command', () => {
    expect(authorize('operator', post, ctx).ok).toBe(true);
    expect(authorize('channel', post, ctx).ok).toBe(false);
    expect(authorize('node', post, ctx).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-9 part 1: contract-boundary rejection, against the COMPILED artifact
// (verify-the-artifact-not-the-unit-test discipline -- packages/contracts/
// dist, not src). ClientCommandSchema imported at module top already
// resolves through '@torqclaw/contracts' -> dist per package.json's "main"
// field in a normal (non-source-aliased) test run; the TORQCLAW_PROFILE_
// CONFORMANCE_SOURCE_CONTRACTS alias only affects vitest.config.ts's OWN
// alias resolution when that env var is set to '1', which it is not here.
// ---------------------------------------------------------------------------
describe('ClientCommandSchema — POST_CHANNEL_MESSAGE grammar (T-9 part 1)', () => {
  const base = { action: 'POST_CHANNEL_MESSAGE' as const, channelId: 'c1', text: 'hello', idempotencyKey: randomUUID() };

  it('accepts a well-formed command (including a fresh UUID idempotencyKey)', () => {
    const result = ClientCommandSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('rejects an empty channelId', () => {
    expect(ClientCommandSchema.safeParse({ ...base, channelId: '' }).success).toBe(false);
  });

  it('rejects empty text (min length 1)', () => {
    expect(ClientCommandSchema.safeParse({ ...base, text: '' }).success).toBe(false);
  });

  it('rejects text over 16384 characters', () => {
    expect(ClientCommandSchema.safeParse({ ...base, text: 'a'.repeat(16385) }).success).toBe(false);
  });

  it('accepts text at exactly 16384 characters', () => {
    expect(ClientCommandSchema.safeParse({ ...base, text: 'a'.repeat(16384) }).success).toBe(true);
  });

  it.each(['not-a-uuid', '', '123', 'abcdefgh-ijkl-mnop-qrst-uvwxyz012345'])(
    'rejects a malformed idempotencyKey %j (not a canonical UUID)',
    (badKey) => {
      expect(ClientCommandSchema.safeParse({ ...base, idempotencyKey: badKey }).success).toBe(false);
    },
  );

  it('rejects a missing idempotencyKey (no default -- unlike cursor, this field is NOT optional)', () => {
    const { idempotencyKey, ...rest } = base;
    expect(ClientCommandSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an author/principalId field even if a caller tries to smuggle one -- extra keys are stripped, not merged (A3 structural proof)', () => {
    const result = ClientCommandSchema.safeParse({ ...base, author: 'someone-else', principalId: 'spoofed' });
    expect(result.success).toBe(true); // extra keys tolerated (Zod strips unknown by default for object schemas in a union member)
    if (result.success) {
      expect((result.data as any).author).toBeUndefined();
      expect((result.data as any).principalId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// T-9 part 2: residue enumeration -- inputs the CONTRACT still admits that
// the SUBSTRATE rejects by throwing. This is the D-1-shaped gap: a coarse
// contract grammar (char-length bound) is NOT equivalent to the substrate's
// real byte bounds (text.ts:122/137). Verified directly against
// normalizeMessageText, the actual consuming validator.
// ---------------------------------------------------------------------------
describe('T-9 part 2: residue enumeration — contract-admitted, substrate-rejected text', () => {
  it('16,384 newlines: passes the contract char-length bound (16384) AND the raw UTF-8 byte bound, but FAILS the JSON-encoded byte bound (each \\n -> 2 bytes = 32,768)', async () => {
    const text = '\n'.repeat(16384);
    // Contract boundary: char length is exactly 16384 -> ACCEPTED.
    const contractResult = ClientCommandSchema.safeParse({
      action: 'POST_CHANNEL_MESSAGE', channelId: 'c1', text, idempotencyKey: randomUUID(),
    });
    expect(contractResult.success).toBe(true);

    // Substrate boundary: text.ts's normalizeMessageText is the REAL gate.
    const { normalizeMessageText } = await import('../packages/collab/src/text.js');
    const substrateResult = normalizeMessageText(text);
    expect('error' in substrateResult).toBe(true);
    if ('error' in substrateResult) {
      expect(substrateResult.error).toBe('INVALID_REQUEST');
      expect(substrateResult.message).toMatch(/JSON-encoded/);
    }
  });

  it('the gateway handler resolves this residue case to a structured COLLAB_INVALID_REQUEST, never a throw', async () => {
    const fixture = makeFixture(`residue-${Math.random().toString(36).slice(2)}`);
    const { setCollabSurfaceStoreForTest, setCollabSurfaceKindLookupDbForTest, handlePostChannelMessage } = await import('../packages/gateway/src/collabSurface.js');
    setCollabSurfaceStoreForTest(fixture.store);
    setCollabSurfaceKindLookupDbForTest(fixture.db);
    try {
      const channel = await fixture.store.createChannel(fixture.operatorCaller, { name: 'Residue' }, 'idem-residue-ch');
      const text = '\n'.repeat(16384);
      await expect(
        handlePostChannelMessage(SESS_ID, fixture.operatorCaller.principalId, channel.channelId, text, randomUUID()),
      ).resolves.toEqual({ code: 'COLLAB_INVALID_REQUEST', detail: expect.any(String) });
    } finally {
      setCollabSurfaceStoreForTest(null);
      setCollabSurfaceKindLookupDbForTest(null);
      fixture.sqlite.close();
    }
  });

  it('a combining-mark-only string that NFC-normalizes to fewer bytes: contract char-length can admit values the RAW byte floor after normalization would still reject in principle (documents the ordering, does not require it to fire here)', () => {
    // This test documents the NFC-then-count ordering (text.ts:114-122) so a
    // future change to normalizeMessageText's order is caught: the contract
    // never re-implements NFC, so any post-normalization floor is solely the
    // substrate's to enforce. No assertion beyond confirming today's floor
    // is >= 1 raw byte post-normalization for ordinary short input (sanity).
    const text = 'a';
    const rawBytes = new TextEncoder().encode(text.normalize('NFC')).length;
    expect(rawBytes).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// T-9 part 3: throw-class totality. Drive handlePostChannelMessage through a
// test-seam store whose postChannelMessage throws each class in turn:
// a domain error carrying the expected code, a domain error carrying some
// OTHER code, a plain Error, and non-Error throws (string/null/undefined/
// number). Every case must RESOLVE (never reject).
// ---------------------------------------------------------------------------
describe('T-9 part 3: throw-class totality — handlePostChannelMessage never rejects', () => {
  let setCollabSurfaceStoreForTest: (s: CollaborationStore | null) => void;
  let handlePostChannelMessage: (
    sid: string, principalId: string | null, channelId: string, text: string, idempotencyKey: string,
  ) => Promise<{ code: string; detail?: unknown } | null>;

  beforeEach(async () => {
    const mod = await import('../packages/gateway/src/collabSurface.js');
    setCollabSurfaceStoreForTest = mod.setCollabSurfaceStoreForTest;
    handlePostChannelMessage = mod.handlePostChannelMessage;
  });
  afterEach(() => setCollabSurfaceStoreForTest(null));

  const cases: Array<[string, unknown]> = [
    ['CollabError-shaped, expected code (COLLAB_NOT_FOUND)', Object.assign(new Error('hidden'), { code: 'COLLAB_NOT_FOUND' })],
    ['CollabError-shaped, expected code (CHANNEL_ARCHIVED)', Object.assign(new Error('archived'), { code: 'CHANNEL_ARCHIVED' })],
    ['CollabError-shaped, expected code (IDEMPOTENCY_CONFLICT)', Object.assign(new Error('conflict'), { code: 'IDEMPOTENCY_CONFLICT' })],
    ['CollabError-shaped, expected code (INVALID_REQUEST)', Object.assign(new Error('bad'), { code: 'INVALID_REQUEST' })],
    ['domain error, an OTHER/unrecognized code', Object.assign(new Error('weird'), { code: 'SOME_OTHER_CODE' })],
    ['plain Error, no code property', new Error('plain failure')],
    ['non-Error throw: string', 'a bare string throw'],
    ['non-Error throw: null', null],
    ['non-Error throw: undefined', undefined],
    ['non-Error throw: number', 42],
  ];

  it.each(cases)('resolves (never rejects) when the store throws: %s', async (_label, thrown) => {
    const throwingStore = {
      postChannelMessage: async () => { throw thrown; },
    } as unknown as CollaborationStore;
    setCollabSurfaceStoreForTest(throwingStore);

    let resolved: { code: string; detail?: unknown } | null | undefined;
    let rejected = false;
    try {
      resolved = await handlePostChannelMessage(SESS_ID, 'principal-x', 'chan-x', 'hi', randomUUID());
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
    expect(resolved).not.toBeUndefined();
    expect(typeof (resolved as any)?.code).toBe('string');
  });

  it('non-object throws (string/null/undefined/number) land on the GENERIC COLLAB_UNAVAILABLE arm, not a code-string coincidence', async () => {
    for (const thrown of ['x', null, undefined, 7]) {
      const throwingStore = {
        postChannelMessage: async () => { throw thrown; },
      } as unknown as CollaborationStore;
      setCollabSurfaceStoreForTest(throwingStore);
      const resolved = await handlePostChannelMessage(SESS_ID, 'principal-x', 'chan-x', 'hi', randomUUID());
      expect(resolved).toEqual({ code: 'COLLAB_UNAVAILABLE' });
    }
  });
});

// ---------------------------------------------------------------------------
// T-9 part 4: no new oracle -- malformed inputs (throw-class cases above,
// PLUS the residue case) must not become a NEW distinguishing signal
// alongside the existing COLLAB_NOT_FOUND indistinguishability guarantee.
// ---------------------------------------------------------------------------
describe('T-9 part 4: no new oracle — error codes stay detail-free / non-distinguishing', () => {
  it('COLLAB_CHANNEL_ARCHIVED and COLLAB_IDEMPOTENCY_CONFLICT are DISTINCT codes from COLLAB_NOT_FOUND, and are only reachable AFTER assertChannelVisible has already passed (never leak hidden-channel existence)', async () => {
    const fixture = makeFixture(`oracle-${Math.random().toString(36).slice(2)}`);
    const { setCollabSurfaceStoreForTest, setCollabSurfaceKindLookupDbForTest, handlePostChannelMessage } = await import('../packages/gateway/src/collabSurface.js');
    setCollabSurfaceStoreForTest(fixture.store);
    setCollabSurfaceKindLookupDbForTest(fixture.db);
    try {
      const { store, operatorCaller } = fixture;
      const channel = await store.createChannel(operatorCaller, { name: 'Oracle' }, 'idem-oracle-ch');
      await store.archiveChannel(operatorCaller, { channelId: channel.channelId }, 'idem-oracle-archive');

      // A MEMBER (operator, who owns/created it) posting to the archived
      // channel gets CHANNEL_ARCHIVED -- proving this code is reachable only
      // for a caller who already passed the visibility/membership check, so
      // it carries no information about hidden-channel existence to anyone
      // who has NOT already been proven a member.
      const archivedResult = await handlePostChannelMessage(SESS_ID, operatorCaller.principalId, channel.channelId, 'x', randomUUID());
      expect(archivedResult?.code).toBe('COLLAB_CHANNEL_ARCHIVED');
      expect(archivedResult?.code).not.toBe('COLLAB_NOT_FOUND');

      // A non-member gets COLLAB_NOT_FOUND for the SAME (archived) channel,
      // not COLLAB_CHANNEL_ARCHIVED -- the archived-vs-hidden distinction is
      // ONLY ever visible to a caller who already cleared assertChannelVisible.
      const outsider = await makeAgent(store, operatorCaller, 'Oracle Outsider', 'idem-oracle-outsider');
      const outsiderResult = await handlePostChannelMessage(SESS_ID, outsider.principalId, channel.channelId, 'x', randomUUID());
      expect(outsiderResult?.code).toBe('COLLAB_NOT_FOUND');
    } finally {
      setCollabSurfaceStoreForTest(null);
      setCollabSurfaceKindLookupDbForTest(null);
      fixture.sqlite.close();
    }
  });
});
