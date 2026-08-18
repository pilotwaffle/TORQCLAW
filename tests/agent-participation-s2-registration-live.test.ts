/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — the REAL server.ts registration
 * call site, booted end-to-end (not this repo's own test helper's
 * registration call — agent-participation-s2.test.ts drives
 * connectInProcessServer directly; this file instead imports the actual
 * built `dist/server.js` so server.ts:791-797's own call to
 * connectInProcessServer(COLLAB_AGENT_SERVER_ID, buildCollabAgentMcpServer(),
 * { capabilities: COLLAB_AGENT_TOOL_CAPABILITIES }) is what runs).
 *
 * OPERATOR RULING (binding, received during this slice's build): "the agent
 * is posting a message free ... make it seamless so the agents can chat and
 * learn from each other." collab__post_message is SPEECH, is FREE, and does
 * NOT require human approval — an approval gate on every sentence would make
 * agent-to-agent conversation impossible, which is the capability this PRD
 * exists to build. This does NOT widen anything else: every other
 * write-capable tool still requires approval on both tiers (talking is free,
 * ACTING is not — R-3b, unchanged), the authority boundary is untouched (an
 * agent may post only where it holds an active collab_members row; a
 * non-member still gets byte-identical COLLAB_NOT_FOUND — protection 6), and
 * collab__read_channel follows the identical explicit-config discipline.
 *
 * Protection 4 (G1R §1.4 item 4 / capability.ts:172's fail-closed default):
 * capability must be an EXPLICIT config decision at the call site, never
 * obtained by omission and never obtained by the tool NAME (post_message
 * happens to match none of registry.ts's seven DEFAULT_WRITE_PATTERNS, but
 * the name must never be the thing carrying the policy — G1R N-7). Falsified
 * live during this slice's build (verbatim RED transcript in the report):
 * removing `{ capabilities: COLLAB_AGENT_TOOL_CAPABILITIES }` from server.ts's
 * call let classifyCapability fall through to P4 name-pattern matching --
 * `post_message` tokenizes to `post`, which IS in P4_SEND, so the tool
 * silently became capability:'send' (write-class), requiresApproval:true.
 * This file pins that the SHIPPED call site keeps the explicit config, by
 * booting the real artifact and reading the real registry entry -- not by
 * re-reading collabAgentTools.ts's source, and not by asserting
 * requiresApproval directly: `requiresApproval` below is read off the SAME
 * registry entry `registry.ts:164` computed via
 * `isWriteClass(cap) || patterns.some(...)` — never hand-set — so this test
 * is pinning the real expression's OUTPUT for the real config, not a
 * restated belief about what it should be.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

const GATEWAY_DIST_DIR = join(GATEWAY_DIST_ENTRY, '..');

describe('PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — live boot, real server.ts registration call site', () => {
  it('the SHIPPED server.ts call registers collab__post_message with EXPLICIT capability:"read" and requiresApproval:false -- proven by booting the real dist/server.js, not by reading source', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-s2-live-'));
    process.env.TORQCLAW_DATA_DIR = dataDir;
    process.env.TORQCLAW_COLLAB_ENABLED = '1';
    process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS = '1';
    process.env.TORQCLAW_AGENT_PARTICIPATION = '1';
    process.env.TORQCLAW_PORT = String(20000 + Math.floor(Math.random() * 10000));
    process.env.TORQCLAW_GATEWAY_TOKEN = 'unused';
    process.env.TORQCLAW_CHANNEL_SERVICE_TOKEN = 'unused-cst';

    // Import the REAL built server.js -- its top-level code runs
    // connectBridge() then the S2 registration block exactly as a real
    // gateway boot would (server.ts:774-798). No websocket client of this
    // test ever connects; the listener binds but is unused (same posture
    // as collab-c2-s0-flag-independent-fence.test.ts's live-artifact import).
    await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'server.js')).href);

    const bridge = await import(pathToFileURL(join('packages', 'bridge', 'dist', 'index.js')).href) as any;
    const registry = bridge.getRegistry();
    const postTool = registry.find((t: any) => t.name === 'collab__post_message');
    const readTool = registry.find((t: any) => t.name === 'collab__read_channel');

    expect(postTool, 'collab__post_message must be registered by the real boot').toBeDefined();
    expect(readTool, 'collab__read_channel must be registered by the real boot').toBeDefined();
    // THE load-bearing assertions for protection 4 -- if server.ts ever
    // drops the explicit `capabilities` option, these turn RED (verified
    // live during this slice's build; see the report for the RED
    // transcript: capability flips to 'send', requiresApproval to true).
    expect(postTool.capability).toBe('read');
    expect(postTool.requiresApproval).toBe(false);
    expect(readTool.capability).toBe('read');
    expect(readTool.requiresApproval).toBe(false);
  }, 30000);
});
