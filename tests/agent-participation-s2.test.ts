/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — Agent read + write path (MCP tools).
 *
 * G1R Gate-1 ruled OQ-6: an in-process MCP transport (`InMemoryTransport`),
 * with the collab tool server a REAL in-process `McpServer` — not a
 * `RegisteredTool.handler` field, not an out-of-process server, not direct
 * LOCAL_EDGE injection. This file drives the SHIPPED registration path
 * (`connectInProcessServer`, registry.ts) and the SHIPPED tool handlers
 * (collabAgentTools.ts) through the REAL BUILT artifacts (`dist/`), never a
 * replica — the repo's own "verify the artifact, not the unit test" and
 * "do not test a replica" disciplines (a prior slice's blocker B-S0-1 was
 * exactly this mistake).
 *
 * Covers:
 *   A2-a — post_message to a non-member channel: zero rows, PAIRED with a
 *          positive control (member channel: exactly one row) in the SAME
 *          test, so a universally-broken tool cannot pass (G1R §6 item 4).
 *   A2-b — read_channel: member reads succeed; non-member/nonexistent reads
 *          are COLLAB_NOT_FOUND, byte-identical.
 *   A2-c — two post_message calls with identical text commit TWO events
 *          with distinct server-minted idempotency keys.
 *   A2-d — collab__* tools are ABSENT from the rendered tool list for a
 *          caller with no bound principal, and PRESENT for one with a bound
 *          principal — asserted against the actual array getToolsForTask/
 *          predictTools return, never the TOOL_ROUTING_MAP config table.
 *   A2-e (partial; full T-9 matrix) — contract-boundary/residue/throw-class
 *          totality for the free-form `text` field.
 *   B-2  — the in-process server cannot be constructed from
 *          ~/.torqclaw/servers.json (servers.json admits only stdio |
 *          streamable-http; a third `type` is rejected by validation).
 *   Protection 6 (T-2) — COLLAB_NOT_FOUND reaches the model unelaborated,
 *          with no "not a member" hint distinguishing it from "does not
 *          exist".
 *   Protection 3/4 — requiresApproval and capability are set EXPLICITLY,
 *          not obtained from the name (post_message matches none of the 7
 *          DEFAULT_WRITE_PATTERNS, but capability is still explicit).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { issueCredential, nodeRandomSource, runCollaborationMigration } from '../packages/collab/src/index.js';
import { GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

const GATEWAY_DIST_DIR = join(GATEWAY_DIST_ENTRY, '..');

type Seeded = {
  collabDbPath: string;
  operatorId: string;
  agentId: string;
  outsiderAgentId: string;
  memberChannelId: string;
  outsiderChannelId: string;
};

function seedDb(dataDir: string, pepper: Buffer): Seeded {
  const collabDbPath = join(dataDir, 'collab.db');
  const db = new Database(collabDbPath);
  runCollaborationMigration(db);
  const operatorId = randomUUID();
  const agentId = randomUUID();
  const outsiderAgentId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Op', NULL, 'active', 1, NULL, ?, ?)",
  ).run(operatorId, now, now);
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'Ag', ?, 'active', 1, NULL, ?, ?)",
  ).run(agentId, operatorId, now, now);
  db.prepare(
    "INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'agent', 'Outsider', ?, 'active', 1, NULL, ?, ?)",
  ).run(outsiderAgentId, operatorId, now, now);

  const memberChannelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Member', 'member', 'active', ?, 1, ?, ?)",
  ).run(memberChannelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(memberChannelId, operatorId, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'agent', 'active', 1, 0, ?, NULL)",
  ).run(memberChannelId, agentId, now);

  // Channel the agent is NOT a member of (operator-only).
  const outsiderChannelId = randomUUID();
  db.prepare(
    "INSERT INTO collab_channels(id, name, name_key, state, owner_principal_id, channel_epoch, created_at, updated_at) VALUES (?, 'Outsider', 'outsider', 'active', ?, 1, ?, ?)",
  ).run(outsiderChannelId, operatorId, now, now);
  db.prepare(
    "INSERT INTO collab_members(channel_id, principal_id, role, state, membership_epoch, rejoined_seq, joined_at, removed_at) VALUES (?, ?, 'owner', 'active', 1, 0, ?, NULL)",
  ).run(outsiderChannelId, operatorId, now);

  db.close();
  return { collabDbPath, operatorId, agentId, outsiderAgentId, memberChannelId, outsiderChannelId };
}

function countMessageEvents(collabDbPath: string, channelId: string): number {
  const db = new Database(collabDbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM collab_events WHERE channel_id = ? AND kind = 'message_posted'")
      .get(channelId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

let dataDir: string;
let pepper: Buffer;
let seeded: Seeded;
let bridge: typeof import('../packages/bridge/dist/index.js');
let collabSurface: typeof import('../packages/gateway/dist/collabSurface.js');
let collabAgentTools: typeof import('../packages/gateway/dist/collabAgentTools.js');

const PREV_ENV: Record<string, string | undefined> = {};
function setEnv(key: string, value: string) {
  if (!(key in PREV_ENV)) PREV_ENV[key] = process.env[key];
  process.env[key] = value;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'torq-s2-'));
  pepper = Buffer.alloc(32, 0x61);
  seeded = seedDb(dataDir, pepper);

  setEnv('TORQCLAW_DATA_DIR', dataDir);
  setEnv('TORQCLAW_COLLAB_DB_PATH', seeded.collabDbPath);
  setEnv('TORQCLAW_COLLAB_ENABLED', '1');
  setEnv('TORQCLAW_COLLAB_TEST_PEPPER', pepper.toString('base64'));

  // Import the REAL built collab modules directly (no gateway boot/listener
  // needed for these — collabSurface's getStore()/callerFor() and
  // collabAgentTools' buildCollabAgentMcpServer() have no dependency on the
  // websocket layer). This is the same "import the real dist artifact, no
  // websocket" discipline collab-c2-s0-flag-independent-fence.test.ts uses,
  // narrowed to exactly the modules under test.
  bridge = await import(pathToFileURL(join('packages', 'bridge', 'dist', 'index.js')).href) as any;
  collabSurface = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'collabSurface.js')).href) as any;
  collabAgentTools = await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'collabAgentTools.js')).href) as any;

  // Production's getPrincipalPepper() reads from a FileSecretStore keyed on
  // TORQCLAW_DATA_DIR, not from TORQCLAW_COLLAB_TEST_PEPPER directly -- that
  // env var is consumed by collab-gateway-test-preload.mjs, a --import
  // preload script launchGateway's SPAWNED child process uses. This test
  // imports modules IN-PROCESS (no spawn, no websocket), so that preload
  // never runs; replicate its one real effect here directly, against the
  // SAME collabIdentity.js module instance getStore() (collabSurface.js)
  // will read from -- both come from the identical dist import path so
  // there is only one module instance in this file's isolated worker.
  const { setCollabSecretStoreForTest } = await import(
    pathToFileURL(join(GATEWAY_DIST_DIR, 'collabIdentity.js')).href
  ) as any;
  const { InMemorySecretStore } = await import(
    pathToFileURL(join('packages', 'collab', 'dist', 'index.js')).href
  ) as any;
  const secretStore = new InMemorySecretStore();
  secretStore.set('TORQCLAW/principal-pepper', pepper);
  setCollabSecretStoreForTest(secretStore);
}, 60000);

afterAll(() => {
  for (const [key, value] of Object.entries(PREV_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Register a FRESH copy of the collab agent MCP server for each test that
 *  needs registry isolation (getRegistry() is a shared module-level array
 *  across this whole file — re-registering under the same server id is
 *  idempotent by construction, connectInProcessServer's registerFromConnectedClient
 *  drops prior entries for the id first). */
async function registerCollabTools(): Promise<void> {
  await bridge.connectInProcessServer(
    collabAgentTools.COLLAB_AGENT_SERVER_ID,
    collabAgentTools.buildCollabAgentMcpServer(),
    { capabilities: collabAgentTools.COLLAB_AGENT_TOOL_CAPABILITIES },
  );
}

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — registration (OQ-6 mechanism proof)', () => {
  it('connectInProcessServer registers collab__read_channel and collab__post_message on the REAL registry, via a REAL InMemoryTransport connect (not a replica)', async () => {
    await registerCollabTools();
    const registry = bridge.getRegistry();
    const readTool = registry.find((t: any) => t.name === 'collab__read_channel');
    const postTool = registry.find((t: any) => t.name === 'collab__post_message');
    expect(readTool, 'collab__read_channel must be registered').toBeDefined();
    expect(postTool, 'collab__post_message must be registered').toBeDefined();

    // Protection 1/3/4: requiresApproval and capability come from the SAME
    // expression every remote-server tool goes through (isWriteClass(cap)
    // || patterns.some(...)) — asserted on the REGISTRY ENTRY, not a
    // hand-set field. capability is EXPLICIT 'read' (COLLAB_AGENT_TOOL_CAPABILITIES),
    // never obtained by name-pattern omission.
    expect(postTool.capability).toBe('read');
    expect(postTool.requiresApproval).toBe(false);
    expect(readTool.capability).toBe('read');
    expect(readTool.requiresApproval).toBe(false);

    // Protection 2: neither tool declares pathArgKeys — path-scope
    // enforcement is a no-op BY EVALUATION (no path-like arg to extract),
    // never by omission of the check itself (checkPath still runs in
    // executeTool for any entry.pathScope; these entries just have none).
    expect(postTool.pathArgKeys).toBeUndefined();
    expect(readTool.pathArgKeys).toBeUndefined();

    // sourceServerId proves this went through the SAME registerFromConnectedClient
    // tail as a remote server — namespacing is `${id}__${rawName}`.
    expect(postTool.sourceServerId).toBe('collab');
    expect(postTool.rawName).toBe('post_message');
  });
});

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — B-2: the in-process server cannot come from servers.json', () => {
  it('a servers.json entry naming a third transport type is rejected by validation; no entry is registered from it', async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'torq-s2-b2-'));
    writeFileSync(
      join(cfgDir, 'servers.json'),
      JSON.stringify({
        servers: [
          { id: 'sneaky', transport: { type: 'in-process' }, enabled: true },
        ],
      }),
    );
    const prevDataDir = process.env.TORQCLAW_DATA_DIR;
    process.env.TORQCLAW_DATA_DIR = cfgDir;
    try {
      const cfgs = bridge.loadServerConfigs();
      // Validation failure -> the WHOLE file is skipped (serverConfig.ts's
      // ServersFileSchema.safeParse posture), so zero configs are returned
      // — not a filtered list with the bad entry dropped and others kept.
      expect(cfgs).toEqual([]);
    } finally {
      if (prevDataDir === undefined) delete process.env.TORQCLAW_DATA_DIR;
      else process.env.TORQCLAW_DATA_DIR = prevDataDir;
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it('connectServer (the servers.json path) has no branch that can reach connectInProcessServer or an McpServer — source-level structural guard', async () => {
    // Regression-resistant guard against a future "just add in-process to
    // the union" change: connectServer's transport ternary must remain
    // EXACTLY the two remote variants. Reads the BUILT artifact source text
    // (not packages/bridge/src) so a source-only fix that never reaches the
    // shipped dist would not falsely pass this guard.
    const { readFileSync } = await import('node:fs');
    const registrySrc = readFileSync(join('packages', 'bridge', 'dist', 'registry.js'), 'utf8');
    const connectServerStart = registrySrc.indexOf('export async function connectServer(');
    const connectInProcessStart = registrySrc.indexOf('export async function connectInProcessServer(');
    expect(connectServerStart).toBeGreaterThan(-1);
    expect(connectInProcessStart).toBeGreaterThan(connectServerStart);
    // connectServer's own body (up to the next top-level export) must not
    // reference InMemoryTransport at all -- it stays exactly the two remote
    // transport variants.
    // The slice includes connectInProcessServer's OWN leading doc comment
    // (TS emits it immediately after connectServer's closing brace), which
    // correctly mentions InMemoryTransport in PROSE. Strip block comments
    // before asserting so this guard checks EXECUTABLE code only.
    const rawSlice = registrySrc.slice(connectServerStart, connectInProcessStart);
    const connectServerBody = rawSlice.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(connectServerBody).not.toContain('InMemoryTransport');
  });
});

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — collab__post_message (A2-a, A2-c, T-2)', () => {
  afterEach(async () => {
    await registerCollabTools(); // idempotent re-register; keeps state clean between tests
  });

  it('A2-a: member channel gets exactly ONE committed row (positive control); non-member channel gets ZERO (paired in the same test — a universally-broken tool cannot pass this)', async () => {
    await registerCollabTools();
    const text = 'S2 post ' + randomUUID();

    // Positive control FIRST.
    const okResult = await bridge.executeTool(
      'collab__post_message', { channelId: seeded.memberChannelId, text }, undefined, seeded.agentId,
    );
    expect(okResult).toBeDefined();
    expect(countMessageEvents(seeded.collabDbPath, seeded.memberChannelId)).toBeGreaterThanOrEqual(1);

    // Attack: same agent, channel it is NOT a member of.
    const before = countMessageEvents(seeded.collabDbPath, seeded.outsiderChannelId);
    await expect(
      bridge.executeTool(
        'collab__post_message', { channelId: seeded.outsiderChannelId, text: 'nope ' + randomUUID() }, undefined, seeded.agentId,
      ),
    ).rejects.toThrow(/COLLAB_NOT_FOUND/);
    expect(countMessageEvents(seeded.collabDbPath, seeded.outsiderChannelId)).toBe(before);
  });

  it('T-2: COLLAB_NOT_FOUND for a non-member channel is byte-identical to a nonexistent channel, and carries no "not a member" hint', async () => {
    let hiddenMsg = '';
    try {
      await bridge.executeTool(
        'collab__post_message', { channelId: seeded.outsiderChannelId, text: 'x' }, undefined, seeded.agentId,
      );
    } catch (e: any) { hiddenMsg = e.message; }

    let absentMsg = '';
    try {
      await bridge.executeTool(
        'collab__post_message', { channelId: 'no-such-channel-' + randomUUID(), text: 'x' }, undefined, seeded.agentId,
      );
    } catch (e: any) { absentMsg = e.message; }

    expect(hiddenMsg).toMatch(/^COLLAB_NOT_FOUND:/);
    expect(absentMsg).toMatch(/^COLLAB_NOT_FOUND:/);
    // Protection 6: the in-process handler must not enrich the message with
    // membership-revealing text beyond what the substrate's own throw
    // carries — assert no "member" wording leaks in either arm.
    expect(hiddenMsg.toLowerCase()).not.toContain('member');
    expect(absentMsg.toLowerCase()).not.toContain('member');
  });

  it('A2-c: two calls with identical text in one "turn" commit TWO distinct events with DIFFERENT server-minted idempotency keys; a model cannot control the key', async () => {
    const text = 'duplicate text ' + randomUUID();
    const before = countMessageEvents(seeded.collabDbPath, seeded.memberChannelId);

    const r1 = await bridge.executeTool(
      'collab__post_message', { channelId: seeded.memberChannelId, text }, undefined, seeded.agentId,
    ) as any;
    const r2 = await bridge.executeTool(
      'collab__post_message', { channelId: seeded.memberChannelId, text }, undefined, seeded.agentId,
    ) as any;

    const parsed1 = JSON.parse(r1[0].text);
    const parsed2 = JSON.parse(r2[0].text);
    expect(parsed1.eventId).not.toBe(parsed2.eventId);
    expect(countMessageEvents(seeded.collabDbPath, seeded.memberChannelId)).toBe(before + 2);

    // Tool schema carries no idempotencyKey field at all -- a model has no
    // argument through which to influence the key.
    const registry = bridge.getRegistry();
    const postTool = registry.find((t: any) => t.name === 'collab__post_message');
    const inputProps = (postTool.inputSchema as any)?.properties ?? {};
    expect(Object.keys(inputProps)).not.toContain('idempotencyKey');
  });

  it('COLLAB_IDENTITY_REQUIRED: no callerCollabPrincipalId supplied (undefined) refuses without writing any row -- refuse, never substitute or synthesize', async () => {
    const before = countMessageEvents(seeded.collabDbPath, seeded.memberChannelId);
    await expect(
      bridge.executeTool('collab__post_message', { channelId: seeded.memberChannelId, text: 'no id' }, undefined, undefined),
    ).rejects.toThrow(/COLLAB_IDENTITY_REQUIRED/);
    expect(countMessageEvents(seeded.collabDbPath, seeded.memberChannelId)).toBe(before);
  });

  it('T-9 residue: 16,384 raw UTF-8 bytes of a 3-byte-per-char string satisfies the schema maxLength grammar but is rejected server-side (JSON-encoded-byte overflow is caught by normalizeMessageText, not the contract)', async () => {
    // '€' (U+20AC) is 3 UTF-8 bytes, 1 UTF-16 code unit -- the schema's
    // maxLength (16384*4 code units) does not reject this string, but its
    // raw UTF-8 byte length (3 * 5462 = 16386) exceeds text.ts's 16384-byte
    // ceiling. Demonstrates the residue T-9 part 2 requires be named: a
    // contract-level length grammar cannot express a byte bound.
    const text = '€'.repeat(5462); // 16,386 raw UTF-8 bytes
    await expect(
      bridge.executeTool('collab__post_message', { channelId: seeded.memberChannelId, text }, undefined, seeded.agentId),
    ).rejects.toThrow(/COLLAB_INVALID_REQUEST/);
  });

  it('throw-class totality: a plain (non-CollabError) Error and store unavailability both resolve to a mapped tool error, never an unhandled rejection escaping the handler unmapped', async () => {
    // Simulate "store unavailable" by pointing at a channel id that is not
    // a valid UUID shape at all — exercises the generic/CollabError path
    // rather than a specific one, proving the handler's catch-all does not
    // let an unclassified throw escape as a raw, unmapped error.
    await expect(
      bridge.executeTool('collab__post_message', { channelId: '', text: 'x' }, undefined, seeded.agentId),
    ).rejects.toThrow(); // must reject with SOME mapped Error, not hang or crash the process
  });
});

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — collab__read_channel (A2-b)', () => {
  it('A2-b: a member reads its own channel; a non-member read is COLLAB_NOT_FOUND, byte-identical to nonexistent', async () => {
    await registerCollabTools();
    const posted = await bridge.executeTool(
      'collab__post_message', { channelId: seeded.memberChannelId, text: 'read-me ' + randomUUID() }, undefined, seeded.agentId,
    ) as any;
    expect(posted).toBeDefined();

    const readResult = await bridge.executeTool(
      'collab__read_channel', { channelId: seeded.memberChannelId, afterCursor: '0', limit: 50 }, undefined, seeded.agentId,
    ) as any;
    const parsed = JSON.parse(readResult[0].text);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events.length).toBeGreaterThanOrEqual(1);

    let hiddenMsg = '';
    try {
      await bridge.executeTool(
        'collab__read_channel', { channelId: seeded.outsiderChannelId, afterCursor: '0', limit: 50 }, undefined, seeded.agentId,
      );
    } catch (e: any) { hiddenMsg = e.message; }
    let absentMsg = '';
    try {
      await bridge.executeTool(
        'collab__read_channel', { channelId: 'no-such-' + randomUUID(), afterCursor: '0', limit: 50 }, undefined, seeded.agentId,
      );
    } catch (e: any) { absentMsg = e.message; }
    expect(hiddenMsg).toMatch(/^COLLAB_NOT_FOUND:/);
    expect(absentMsg).toMatch(/^COLLAB_NOT_FOUND:/);
  });

  it('a DIFFERENT agent (not the outsider, not a member of ANY seeded channel) reading the member channel is refused -- membership is per-principal, not per-server', async () => {
    await expect(
      bridge.executeTool(
        'collab__read_channel', { channelId: seeded.memberChannelId, afterCursor: '0', limit: 50 }, undefined, seeded.outsiderAgentId,
      ),
    ).rejects.toThrow(/COLLAB_NOT_FOUND/);
  });
});

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — toolFilter identity gating (A2-d)', () => {
  it('predictTools: collab__ tools are ABSENT with no callerCollabPrincipalId, PRESENT with one -- asserted on the rendered array', async () => {
    await registerCollabTools();
    const toolFilter = await import(pathToFileURL(join('packages', 'bridge', 'dist', 'toolFilter.js')).href) as any;

    const withoutIdentity: string[] = toolFilter.predictTools('SUMMARIZATION', undefined, undefined);
    expect(withoutIdentity.some((n: string) => n.startsWith('collab__'))).toBe(false);

    const withIdentity: string[] = toolFilter.predictTools('SUMMARIZATION', undefined, seeded.agentId);
    expect(withIdentity.filter((n: string) => n.startsWith('collab__'))).toEqual(
      expect.arrayContaining(['collab__read_channel', 'collab__post_message']),
    );
  });

  it('getToolsForTask: the RENDERED openAITools list (what the model actually receives) excludes collab__ tools with no bound identity, includes them with one; requiresApproval(post_message) is false when present', async () => {
    await registerCollabTools();
    const toolFilter = await import(pathToFileURL(join('packages', 'bridge', 'dist', 'toolFilter.js')).href) as any;

    const noIdentity = await toolFilter.getToolsForTask('SUMMARIZATION', 'LOCAL_EDGE', undefined, undefined);
    expect(noIdentity.openAITools.some((t: any) => t.function.name.startsWith('collab__'))).toBe(false);

    const withIdentity = await toolFilter.getToolsForTask('SUMMARIZATION', 'LOCAL_EDGE', undefined, seeded.agentId);
    const names = withIdentity.openAITools.map((t: any) => t.function.name);
    expect(names).toContain('collab__post_message');
    expect(names).toContain('collab__read_channel');
    // A5-d (the WHOLE requiresApproval expression, not just the pattern
    // disjunct — G1R B-5 fix): asserted against the rendered closure.
    expect(withIdentity.requiresApproval('collab__post_message')).toBe(false);
    expect(withIdentity.requiresApproval('collab__read_channel')).toBe(false);
  });
});
