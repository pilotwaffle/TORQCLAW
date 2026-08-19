import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

/**
 * Collab tool registration must FAIL CLOSED, not degrade to a warning.
 *
 * server.ts previously caught a registration failure, logged one
 * `console.warn`, and continued booting -- citing CLAUDE.md §4 ("a malformed
 * or unreachable server must degrade only that server"). That rule is about
 * EXTERNAL MCP servers from servers.json. This is an IN-PROCESS server built
 * from this repo's own code, reached only because the operator explicitly set
 * TORQCLAW_AGENT_PARTICIPATION on top of the whole flag chain.
 *
 * WHY DEGRADING IS WORSE THAN FAILING. resolveEffectiveProfile materializes
 * allowedOperationIds FROM THE TOOL REGISTRY (profilePolicy.ts), so with the
 * collab tools absent every profile resolves with an empty operation set.
 * Every auto-reply turn then fails its §5A pre-dispatch assertion and throws
 * -- deterministically, for the entire life of the process -- while the
 * gateway reports healthy and that single warn line scrolls away in startup
 * output. The operator sees agents that never speak, and no error explaining
 * why. A structural inability to act must never resolve to the same state as
 * a deliberate choice not to act.
 *
 * WHAT THIS PINS, and honestly what it does not. buildCollabAgentMcpServer()
 * is pure construction with no injectable failure, so this does not
 * manufacture a fake registration error and assert on a contrived throw.
 * It pins two real, independently checkable properties of the SHIPPED
 * artifact:
 *   1. dist/server.js contains the refusal on that path and no longer
 *      contains the degrade-and-continue warn (read off the built file, not
 *      the TypeScript source -- a stale dist has previously let a "fixed"
 *      control stay open in this repo).
 *   2. the success path still boots and still registers both tools, so the
 *      fail-closed change did not break the ordinary case.
 */

const GATEWAY_DIST_DIR = join(GATEWAY_DIST_ENTRY, '..');

describe('collab tool registration fails closed', () => {
  it('the BUILT artifact refuses to start rather than degrading to a warning', () => {
    const built = readFileSync(GATEWAY_DIST_ENTRY, 'utf8');

    // The refusal must be present...
    expect(
      built,
      'dist/server.js must refuse to start when collab tools cannot register',
    ).toContain('Refusing to start: without these tools');
    // ...and it must name the flag the operator can unset, so the message is
    // actionable rather than merely loud.
    expect(built).toContain('TORQCLAW_AGENT_PARTICIPATION');

    // NEGATIVE HALF -- this is the assertion that would have caught the
    // original defect. The degrade-and-continue path must be GONE, not merely
    // accompanied by a throw somewhere else in the file.
    expect(
      built,
      'the degrade-and-continue warn must be gone, not just supplemented',
    ).not.toContain('agent participation tools unavailable this session');
  });

  it('POSITIVE CONTROL: the success path still boots and registers both collab tools', async () => {
    // Without this, the assertions above would pass against a server.ts that
    // throws unconditionally -- i.e. against a gateway that can never start.
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-failclosed-'));
    process.env.TORQCLAW_DATA_DIR = dataDir;
    process.env.TORQCLAW_COLLAB_ENABLED = '1';
    process.env.TORQCLAW_COLLAB_SURFACE_COMMANDS = '1';
    process.env.TORQCLAW_AGENT_PARTICIPATION = '1';
    process.env.TORQCLAW_PORT = String(20000 + Math.floor(Math.random() * 10000));
    process.env.TORQCLAW_GATEWAY_TOKEN = 'unused';
    process.env.TORQCLAW_CHANNEL_SERVICE_TOKEN = 'unused-cst';

    await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'server.js')).href);

    const bridge = await import(
      pathToFileURL(join('packages', 'bridge', 'dist', 'index.js')).href
    ) as any;
    const registry = bridge.getRegistry();

    expect(
      registry.find((t: any) => t.name === 'collab__post_message'),
      'the ordinary boot must still register collab tools',
    ).toBeDefined();
    expect(registry.find((t: any) => t.name === 'collab__read_channel')).toBeDefined();
  }, 30000);
});
