/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 A3-c — two agents actually converse.
 *
 * "This is the criterion that proves the product exists" (§7 A3-c). Every
 * mechanism around the loop (STOP, INV-T1, the watermark, crash recovery,
 * dispatch-time identity binding) is proven in agent-participation-s3.test.ts
 * and agent-participation-s2.test.ts. NONE of those tests drive a turn all
 * the way through onChannelMessageCommitted -> claimAgentTurn ->
 * runAgentTurn -> a tool call that actually posts -> a re-trigger of the
 * OTHER agent. This file does.
 *
 * STATUS UPDATE (G1R COLLAB-WRITE-PROFILE ruling, landed): THE FINDING below
 * described a real defect -- no shipped profile admitted collab__post_message,
 * so the round trip could never complete. That defect is now fixed (a new
 * 'agent_conversation' profile, packages/contracts/src/profile.ts, resolved
 * explicitly by autoReplyDispatcher.ts's runAgentTurn) and ASSERTION 1 below
 * is INVERTED, per the ruling's explicit instruction ("the danger is that
 * whoever fixes this sees a failing test asserting brokenness and deletes
 * it -- losing the only end-to-end proof of the round trip"): it now asserts
 * the round trip DOES complete, not that it fails. THE FINDING is retained
 * below UNCHANGED as the historical record of the defect this fix closes --
 * it describes the pre-fix state, not the current one.
 *
 * THE SEAM, AND WHY IT IS HONEST
 * -------------------------------
 * `runAgentTurn` (autoReplyDispatcher.ts) dispatches a real GatewayRequest
 * through `dispatch()`, which normally reaches a real Ollama model. No test
 * in this repo boots a real local model. `setAutoReplyDispatchForTest`
 * (already shipped, exported from autoReplyDispatcher.ts for exactly this
 * purpose per its own doc comment) replaces ONLY the `dispatch` call --
 * every other line of runAgentTurn/dispatchOneTurn/onChannelMessageCommitted
 * is the REAL BUILT artifact, unmodified:
 *
 *   REAL:  onChannelMessageCommitted, resolveEligibleAgents (INV-T1),
 *          claimAgentTurn (idempotency watermark), isAutoreplyStopped
 *          (STOP), buildAnchorWindowContext, resolveProfile (the REAL
 *          profile a real auto-turn would resolve -- NOT overridden, see
 *          the finding below), attachDispatchRequestId, runDispatchAndWait's
 *          poll-the-tasks-row loop, resolveAgentTurn, countAgentPostsSince,
 *          agentIsActiveMember -- i.e. the ENTIRE dispatcher and its state
 *          machine, including the exact policy object production computes.
 *   SUBSTITUTED: only "what a model would have decided to do this turn" --
 *          the override looks up which (channel, agent) the claimed turn's
 *          collab_agent_turns.dispatch_request_id row identifies (the SAME
 *          correlator attachDispatchRequestId writes in production,
 *          immediately before the real runDispatchAndWait call this
 *          replaces), consults a small per-agent SCRIPT the test supplies,
 *          and if scripted to reply, calls bridge.executeTool('collab__
 *          post_message', ...) with req.effectiveProfile -- the EXACT SAME
 *          call and the EXACT SAME profile object collabAgentTools.ts's
 *          real MCP tool handler and a real model's tool call would use.
 *
 * This mirrors the license TORQCLAW_E2E_FORCE_GATED_TOOL already has in
 * ollama.ts (force a tool decision deterministically, but still execute the
 * REAL admission/tool/policy path) -- narrowed to the one seam the brief
 * names as off-limits to stub: `runAgentTurn` and the dispatcher are never
 * replaced, only the model's choice of tool call is, and the policy that
 * decides whether that call is even PERMITTED is never touched.
 *
 * THE FINDING (reported, not routed around) -- HISTORICAL, describes the
 * pre-fix defect. See "STATUS UPDATE" above for the current state.
 * ------------------------------------------
 * `runAgentTurn` resolves its GatewayRequest's effectiveProfile via
 * `resolveProfile({ taskType: 'SUMMARIZATION' })` (autoReplyDispatcher.ts
 * ~line 238), which resolves to the 'read_only' built-in profile
 * (profileResolver.ts's DEFAULT_PROFILE_BY_TASK). `read_only`'s
 * allowedSideEffects is `['none']` (packages/contracts/src/profile.ts).
 * collab__post_message's side-effect class is `collab_write`
 * (profilePolicy.ts's sideEffectFor, G1R V-S2-1's deliberate, CORRECT fix --
 * post_message really does commit a row and must not be misclassified
 * 'none'). Checking all four BUILT_IN_PROFILE_DEFINITIONS
 * (packages/contracts/src/profile.ts): read_only allows ['none'],
 * workspace_write allows ['none','filesystem_write'], browser_research
 * allows ['none'], terminal_power allows ['none','process']. NONE of the
 * four shipped profiles admits 'collab_write'. Consequence: EVERY auto-turn
 * dispatched by the current build resolves a profile under which
 * collab__post_message is filtered out of the model's rendered tool list
 * (toolFilter.ts's getToolsForTask -- the tool is never even OFFERED) and,
 * if reached by any other path, refused by assertOperationAllowed
 * ("Tool 'collab__post_message' is outside effective profile 'read_only'").
 * A real model in this seat has no way to speak, ever, regardless of what
 * it decides. This is not a test-harness limitation -- it reproduces
 * against unmodified dist artifacts, with the override supplying the exact
 * profile production computes.
 *
 * This is a genuine, real gap between S2 (which correctly taught the policy
 * layer that post_message mutates something) and S3 (which never revisited
 * what profile an auto-turn should carry). The S3 commit's own message
 * (84bfda3) says as much: "auto-reply plumbing built, live loop NOT
 * proven." Fixing it requires a policy decision (which profile, or a new
 * one, permits collab_write for an unattended auto-turn) that is squarely
 * in "provider config / MCP write permissions" territory per this repo's
 * CLAUDE.md gate table -- G1R review, not a unilateral Sonnet patch under
 * this ticket's scope ("stage nothing, commit nothing" / minimal
 * test-enablement changes only). So this file does NOT widen any profile.
 * It proves the dispatcher mechanics (claim, no-self-reply, idempotency,
 * STOP, silence-is-valid) are real and correctly wired end-to-end, and it
 * proves -- with a falsifiable, reproducible RED -- that the conversational
 * round trip A3-c requires cannot complete today for this specific,
 * pinpointed reason.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
  agentBId: string;
  channelId: string;
};

function seedTwoAgentChannel(dbPath: string): Seeded {
  const db = new Database(dbPath);
  runCollaborationMigration(db);
  runAgentAutoreplyMigration(db);
  const operatorId = randomUUID();
  const agentAId = randomUUID();
  const agentBId = randomUUID();
  const now = nowIso();
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(operatorId, now, now);
  for (const [id, name] of [[agentAId, 'AgentA'], [agentBId, 'AgentB']] as const) {
    db.prepare(
      "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', ?, ?, 'active', 1, NULL, ?, ?)",
    ).run(id, name, operatorId, now, now);
  }
  const channelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Duo', 'duo', 'active', ?, 1, ?, ?)",
  ).run(channelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(channelId, operatorId, now);
  for (const id of [agentAId, agentBId]) {
    db.prepare(
      "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
    ).run(channelId, id, now);
  }
  db.close();
  return { collabDbPath: dbPath, operatorId, agentAId, agentBId, channelId };
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

function agentTurnRows(dbPath: string, channelId: string): Array<{ agentPrincipalId: string; channelSeq: number; triggerEventId: string; state: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT agent_principal_id AS agentPrincipalId, channel_seq AS channelSeq, trigger_event_id AS triggerEventId, state
           FROM collab_agent_turns WHERE channel_id = ? ORDER BY channel_seq ASC, agent_principal_id ASC`,
      )
      .all(channelId) as Array<{ agentPrincipalId: string; channelSeq: number; triggerEventId: string; state: string }>;
  } finally {
    db.close();
  }
}

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 A3-c — two agents actually converse', () => {
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

  /** The test-model script: maps agentPrincipalId -> a queue of reply texts
   *  (or null to stay silent that turn). Consumed one entry per claimed turn.
   *  This is the ONLY thing standing in for "what a real model would
   *  decide" -- everything downstream of the decision (the tool call
   *  against the REAL profile, the commit, the re-trigger) is real. */
  let script: Map<string, Array<string | null>>;
  let triggerEnabled = true;
  /** Every refusal the override observed calling collab__post_message under
   *  the REAL production-resolved profile, for precise, evidence-based
   *  reporting rather than a bare timeout. */
  let observedRefusals: string[] = [];

  function nextScriptedReply(agentPrincipalId: string): string | null {
    const q = script.get(agentPrincipalId);
    if (!q || q.length === 0) return null;
    return q.shift()!;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'torq-a3c-'));
    const pepper = Buffer.alloc(32, 0x51);
    const collabDbPath = join(dataDir, 'collab.db');
    seeded = seedTwoAgentChannel(collabDbPath);

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

    // Replicate collab-gateway-test-preload.mjs's ONE real effect for an
    // in-process (no spawn) test — same discipline agent-participation-s2's
    // beforeAll uses, same reason (production reads the pepper from a
    // FileSecretStore keyed on TORQCLAW_DATA_DIR, not from the test env var
    // directly).
    const { setCollabSecretStoreForTest } = await import(
      pathToFileURL(join(GATEWAY_DIST_DIR, 'collabIdentity.js')).href
    ) as any;
    const { InMemorySecretStore } = collab as any;
    const secretStore = new InMemorySecretStore();
    secretStore.set('TORQCLAW/principal-pepper', pepper);
    setCollabSecretStoreForTest(secretStore);

    // Wire the SAME trigger production wires in server.ts's boot sequence
    // (`setAutoReplyTrigger(onChannelMessageCommitted)`), so an agent's own
    // post (collabAgentTools.ts's post_message handler calling
    // triggerAutoReply) reaches the real dispatcher exactly as it does in
    // a booted gateway. Nothing about this rewires or replaces
    // onChannelMessageCommitted itself.
    collabSurface.setAutoReplyTrigger((params: any) => {
      if (!triggerEnabled) return;
      return autoReplyDispatcher.onChannelMessageCommitted(params);
    });

    // Register the REAL in-process collab MCP server so bridge.executeTool
    // routes through the REAL registry/approval/capability/policy path
    // (identical to agent-participation-s2.test.ts's registerCollabTools()).
    await bridge.connectInProcessServer(
      collabAgentTools.COLLAB_AGENT_SERVER_ID,
      collabAgentTools.buildCollabAgentMcpServer(),
      { capabilities: collabAgentTools.COLLAB_AGENT_TOOL_CAPABILITIES },
    );

    // THE SEAM: replace ONLY dispatch(). See the file header for exactly
    // what remains real vs. substituted. req.effectiveProfile is used
    // VERBATIM, unmodified -- the real policy object runAgentTurn actually
    // computed for this turn, per "THE FINDING" above.
    autoReplyDispatcher.setAutoReplyDispatchForTest((req: any, _diag: any) => {
      void (async () => {
        // Real task-row bookkeeping so runDispatchAndWait's poll (unchanged,
        // real) resolves exactly as it does against a real dispatch.
        events.taskStore.create(req, _diag);
        try {
          // Recover WHICH (channel, agent) this claimed turn is for from the
          // SAME correlator production writes: attachDispatchRequestId sets
          // collab_agent_turns.dispatch_request_id = req.id immediately
          // before the real runDispatchAndWait call this override stands in
          // for. This is real committed substrate data, not a fabricated
          // shortcut.
          const db = collabSurface.getCollabDbForAutoReply();
          const row = db!
            .prepare(
              `SELECT channel_id AS channelId, agent_principal_id AS agentPrincipalId
                 FROM collab_agent_turns WHERE dispatch_request_id = ?`,
            )
            .get(req.id) as { channelId: string; agentPrincipalId: string } | undefined;

          if (row) {
            const reply = nextScriptedReply(row.agentPrincipalId);
            if (reply !== null) {
              // THE REAL CALL, THE REAL PROFILE: identical to what
              // collabAgentTools.ts's own post_message handler executes for
              // a real model's tool call, under the EXACT profile object
              // runAgentTurn resolved for this turn (never substituted).
              try {
                await bridge.executeTool(
                  'collab__post_message',
                  { channelId: row.channelId, text: reply },
                  req.effectiveProfile,
                  row.agentPrincipalId,
                );
              } catch (toolErr: any) {
                observedRefusals.push(String(toolErr?.message ?? toolErr));
                throw toolErr;
              }
            }
          }
          events.taskStore.complete(req.id, 'ok', {});
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
    collab.clearAutoreplyStop(collabSurface.getCollabDbForAutoReply()!, 'global', null);
    collab.clearAutoreplyStop(collabSurface.getCollabDbForAutoReply()!, 'channel', seeded.channelId);
  });

  /** Poll until EITHER the target post count is reached AND every expected
   *  turn has resolved to a terminal state (so callers observe a settled
   *  outcome, never a post that landed a beat before its turn's own
   *  resolveAgentTurn call -- runDispatchAndWait's poll delay means those
   *  two writes are not atomic), OR every currently in-flight turn this
   *  poll can observe has resolved to a terminal state with zero new posts
   *  -- so a genuine policy refusal (the finding above) fails FAST with a
   *  precise message instead of running out a long timeout that looks like
   *  a hang. */
  async function waitForPostsOrTerminalRefusal(count: number, expectedTurnCount: number, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = messagePostedRows(seeded.collabDbPath, seeded.channelId);
      const turns = agentTurnRows(seeded.collabDbPath, seeded.channelId);
      const resolvedEnough = turns.filter((t) => t.state !== 'dispatched').length >= expectedTurnCount;
      if (rows.length >= count && resolvedEnough) return;
      if (resolvedEnough && rows.length < count) {
        throw new Error(
          `all ${expectedTurnCount} expected turn(s) resolved without reaching ${count} posts (have ${rows.length}). ` +
          `turns=${JSON.stringify(turns)} observedRefusals=${JSON.stringify(observedRefusals)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for ${count} message_posted rows; have ${rows.length}. ` +
          `turns=${JSON.stringify(turns)} observedRefusals=${JSON.stringify(observedRefusals)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('ASSERTION 1, INVERTED: two agents actually converse — the A3-c criterion, never before green (G1R COLLAB-WRITE-PROFILE ruling §7/§10 item 8)', async () => {
    // G1R ruling: "the danger is that whoever fixes this sees a failing test
    // asserting brokenness and deletes it -- losing the only end-to-end
    // proof of the round trip." This assertion FLIPS rather than being
    // deleted. THE FINDING documented in this file's header (still true as
    // history -- it describes the defect this fix closes) was: no shipped
    // profile admitted collab__post_message, so runAgentTurn resolving
    // taskType='SUMMARIZATION' always landed on 'read_only' and every
    // auto-turn was refused. The fix: autoReplyDispatcher.ts's runAgentTurn
    // now resolves 'agent_conversation' explicitly (both requestedProfile
    // and sessionDefaultProfile, per the ruling's PART 3 trap), which DOES
    // admit collab__post_message. This test proves that resolution
    // end-to-end through the REAL dispatcher, REAL claim/idempotency/STOP
    // machinery, and REAL profile-gated bridge.executeTool call -- nothing
    // here is a fixture.
    observedRefusals = [];
    script = new Map([
      [seeded.agentAId, ['Hello B, I saw your ping.']],
      [seeded.agentBId, ['Got it, thanks A.']],
    ]);

    const store = collabSurface.getStore();
    const humanSeq = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'Agents, please coordinate.' },
        randomUUID(),
      )).cursor,
    );
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: humanSeq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });

    // Both A and B are eligible for the human's post (INV-T1: every active
    // member except the actor). Both are scripted to reply, and EACH reply
    // is itself a committed message_posted row that re-enters
    // onChannelMessageCommitted (the same real anti-storm mechanism S3
    // documents, header mechanism 1: "no self-reply") -- so this is a real
    // two-agent CASCADE, not a fixed two-turn exchange: A's reply to the
    // human re-triggers eligibility excluding A (-> B becomes eligible
    // again, at A's post's seq), and B's reply likewise re-triggers
    // excluding B. Once each agent's one-entry script is exhausted, its
    // next claimed turn legitimately resolves 'no_post' (A3-f). The A3-c
    // CRITERION itself only requires three message_posted rows (human +
    // A's reply + B's reply) -- assert that first, precisely.
    await waitForPostsOrTerminalRefusal(3, 2);

    // No refusal should have been observed at all -- the profile now admits
    // the tool, so bridge.executeTool must never have thrown.
    expect(
      observedRefusals,
      `A3-c must complete with zero policy refusals; got: ${JSON.stringify(observedRefusals)}`,
    ).toEqual([]);

    // The human's message AND both agents' replies all committed.
    const posts = messagePostedRows(seeded.collabDbPath, seeded.channelId);
    expect(posts.length).toBe(3);
    expect(posts[0]!.actorPrincipalId).toBe(seeded.operatorId);
    const replyAuthors = new Set(posts.slice(1).map((p) => p.actorPrincipalId));
    expect(replyAuthors, 'THE A3-c criterion: both agents actually posted a reply').toEqual(
      new Set([seeded.agentAId, seeded.agentBId]),
    );

    // Let the cascade's own re-triggered turns (each agent's script is now
    // exhausted, so their next eligible turn legitimately posts nothing)
    // settle to terminal states before asserting turn-level invariants --
    // real dispatcher work, not a fixture, so it needs a real window.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Every claimed turn resolved cleanly -- no turn is left 'dispatched'
    // (stuck/crashed), and no turn ever posted for an agent replying to its
    // OWN message (that is ASSERTION 2's job below; this is the coarse
    // version scoped to this trigger sequence).
    const turns = agentTurnRows(seeded.collabDbPath, seeded.channelId);
    expect(turns.length, 'at least the two originally-triggered turns must exist').toBeGreaterThanOrEqual(2);
    for (const t of turns) {
      expect(t.state, `turn for ${t.agentPrincipalId}@${t.channelSeq} must resolve cleanly`).not.toBe('dispatched');
      expect(['completed', 'no_post'], `turn for ${t.agentPrincipalId}@${t.channelSeq} must not be terminated (a policy refusal) now that the profile admits posting`)
        .toContain(t.state);
    }
    // At least one turn per agent must have actually completed (posted) --
    // otherwise "both agents replied" above could vacuously hold from only
    // one agent's turn while the other's post came from an unexpected path.
    const completedAgentIds = new Set(turns.filter((t) => t.state === 'completed').map((t) => t.agentPrincipalId));
    expect(completedAgentIds).toEqual(new Set([seeded.agentAId, seeded.agentBId]));
  }, 20000);

  it('ASSERTION 2 (mechanics) — no self-reply: every DIRECTLY-triggered turn is for an agent OTHER than whoever authored its triggering event', () => {
    // Scoped to real-event-triggered claims (trigger_event_id is an actual
    // collab_events row id), NOT coalesced follow-ups (dispatchOneTurn's
    // dirty-flag mechanism writes a synthetic 'coalesced:<uuid>' trigger_event_id
    // and re-evaluates against latestChannelSeq at RESOLUTION time -- see
    // this file's own A3-c cascade above, where the human's post makes both
    // A and B eligible, A's reply chains into B via a real trigger, and B's
    // OWN original claim (from the human's post) can only be re-dispatched
    // as a coalesced follow-up once B is no longer in-flight; by then the
    // latest seq in the channel may legitimately equal B's own most recent
    // post. That is NOT a self-reply -- the coalesced dispatch is B
    // evaluating "is there anything new to react to", not "B replying to
    // channel_seq=N's author". Excluding coalesced rows keeps this
    // assertion sound for the invariant it actually names.
    const turns = agentTurnRows(seeded.collabDbPath, seeded.channelId)
      .filter((t) => !t.triggerEventId.startsWith('coalesced:'));
    expect(turns.length).toBeGreaterThan(0);
    const posts = messagePostedRows(seeded.collabDbPath, seeded.channelId);
    const authorBySeq = new Map(posts.map((e) => [e.channelSeq, e.actorPrincipalId]));
    for (const t of turns) {
      const triggeringAuthor = authorBySeq.get(t.channelSeq);
      expect(
        triggeringAuthor,
        `no self-reply: turn for agent=${t.agentPrincipalId} seq=${t.channelSeq} must not be triggered by itself`,
      ).not.toBe(t.agentPrincipalId);
    }
  });

  it('ASSERTION 3 (mechanics) — idempotency: redundant delivery of an already-claimed trigger adds no new collab_agent_turns row', () => {
    const before = agentTurnRows(seeded.collabDbPath, seeded.channelId);
    expect(before.length).toBeGreaterThan(0);
    const anyTurn = before[0]!;
    // Re-deliver via the real trigger path (not a direct claimAgentTurn
    // call) so this exercises the SAME onChannelMessageCommitted ->
    // claimAgentTurn path production uses.
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: anyTurn.channelSeq, eventId: anyTurn.triggerEventId, actorPrincipalId: seeded.operatorId,
    });
    const after = agentTurnRows(seeded.collabDbPath, seeded.channelId);
    expect(after.length, 'redundant delivery of an already-claimed trigger must not add a row').toBe(before.length);
  });

  it('ASSERTION 4 (mechanics) — STOP: with a turn already claimed (positive control), STOP prevents any NEW turn claim for a subsequent trigger', async () => {
    const beforeStopTurns = agentTurnRows(seeded.collabDbPath, seeded.channelId).length;
    expect(beforeStopTurns, 'positive control: a turn must already exist from the finding reproduction above before STOP is even set').toBeGreaterThan(0);

    const db = collabSurface.getCollabDbForAutoReply()!;
    collab.setAutoreplyStop(db, { scope: 'global', channelId: null, stoppedByPrincipalId: seeded.operatorId, nowIso: nowIso() });

    const store = collabSurface.getStore();
    const seq = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'one more thing, while stopped' },
        randomUUID(),
      )).cursor,
    );
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: seq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });

    // Give the (should-be-refused) trigger a real window to have shown up.
    await new Promise((r) => setTimeout(r, 1200));

    const afterStopTurns = agentTurnRows(seeded.collabDbPath, seeded.channelId).length;
    expect(afterStopTurns, 'STOP must prevent any NEW turn claim').toBe(beforeStopTurns);
    // The human's own message still commits -- STOP gates DISPATCH, not the
    // substrate's write path.
    const afterStopPosts = messagePostedRows(seeded.collabDbPath, seeded.channelId);
    expect(afterStopPosts.some((p) => p.channelSeq === seq && p.actorPrincipalId === seeded.operatorId)).toBe(true);

    collab.clearAutoreplyStop(db, 'global', null);
  }, 15000);

  it('FALSIFIABILITY — with the trigger disabled, a fresh human post produces ZERO new agent_turns rows (proves the earlier claims tested the real loop, not a fixture)', async () => {
    const before = agentTurnRows(seeded.collabDbPath, seeded.channelId).length;

    triggerEnabled = false; // RED PROBE: disable the trigger wiring itself
    try {
      const store = collabSurface.getStore();
      const seq = Number(
        (await store!.postChannelMessage(
          collabSurface.callerFor(seeded.operatorId),
          { channelId: seeded.channelId, text: 'trigger is OFF for this probe' },
          randomUUID(),
        )).cursor,
      );
      collabSurface.triggerAutoReply({
        channelId: seeded.channelId, channelSeq: seq, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
      });
      await new Promise((r) => setTimeout(r, 1000));
      const after = agentTurnRows(seeded.collabDbPath, seeded.channelId).length;
      expect(after, 'RED PROBE: with the trigger disabled, NOTHING should have been claimed').toBe(before);
    } finally {
      triggerEnabled = true;
    }

    // Restore and prove the SAME shape of trigger, re-enabled, DOES claim a
    // turn -- the positive control that makes the probe above meaningful
    // rather than a test of an always-broken build.
    const store = collabSurface.getStore();
    const seq2 = Number(
      (await store!.postChannelMessage(
        collabSurface.callerFor(seeded.operatorId),
        { channelId: seeded.channelId, text: 'trigger restored' },
        randomUUID(),
      )).cursor,
    );
    collabSurface.triggerAutoReply({
      channelId: seeded.channelId, channelSeq: seq2, eventId: randomUUID(), actorPrincipalId: seeded.operatorId,
    });
    const deadline = Date.now() + 8000;
    let after2 = before;
    while (Date.now() < deadline) {
      after2 = agentTurnRows(seeded.collabDbPath, seeded.channelId).length;
      if (after2 > before) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after2, 'positive control: re-enabling the trigger must claim a turn').toBeGreaterThan(before);
  }, 15000);
});
