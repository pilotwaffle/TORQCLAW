/**
 * PB-1(a) — the keyless web-search in-process MCP server
 * (WEB_SEARCH_SERVER_ID = 'research', registered from server.ts) is network
 * egress: it shells out to the DDGS CLI or a configured SEARXNG_URL.
 * CLAUDE.md §6 forbids external network egress without explicit operator
 * approval, so this must default OFF, mirroring the Python twin's gate
 * (hermes__web_search in engines/hermes_kernel/mcp_wrapper/server.py, guarded
 * by `TORQCLAW_WEB_SEARCH_ENABLED == "1"`).
 *
 * Two halves:
 *
 *   1. NEGATIVE, on the REAL shipped artifact. Booting the real built
 *      dist/server.js (its top-level code runs connectBridge() then the
 *      PB-1(a) registration block exactly as a real gateway boot would --
 *      same mechanism as agent-participation-s2-registration-live.test.ts
 *      and agent-participation-registration-fail-closed.test.ts) with
 *      TORQCLAW_WEB_SEARCH_ENABLED unset must leave the real registry with
 *      NO research__-namespaced tool. This is the defect this slice fixes:
 *      the unconditional call site previously registered research__web_search
 *      on every boot regardless of the flag.
 *
 *   2. POSITIVE, on the real registration primitive. `dist/server.js` can
 *      only be booted (and its top-level code run) ONCE per process --
 *      Node's module cache makes a second `import()` of the same real
 *      artifact, with a different env, a silent no-op that would prove
 *      nothing (same reason agent-participation-registration-fail-closed's
 *      negative/positive halves are two separate `it()`s sharing one boot,
 *      never two boots). So the positive half instead calls
 *      connectInProcessServer(WEB_SEARCH_SERVER_ID, buildKeylessWebSearchMcpServer(),
 *      { capabilities: WEB_SEARCH_TOOL_CAPABILITIES }) directly -- the EXACT
 *      same call server.ts's PB-1(a) block makes when webSearchEnabled() is
 *      true, going through the identical "shared registration tail"
 *      (registry.ts's registerFromConnectedClient) every remote and
 *      in-process server uses. This is not a replica dispatch path; it is
 *      the same primitive the gated call site invokes, called the same way.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATEWAY_DIST_ENTRY } from './helpers/collab-gateway-harness.js';

const GATEWAY_DIST_DIR = join(GATEWAY_DIST_ENTRY, '..');

describe('PB-1(a) — research__web_search egress gate (TORQCLAW_WEB_SEARCH_ENABLED)', () => {
  it('NEGATIVE: the real shipped boot registers NO research__-namespaced tool when the flag is unset', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-websearch-off-'));
    delete process.env.TORQCLAW_WEB_SEARCH_ENABLED;
    process.env.TORQCLAW_DATA_DIR = dataDir;
    process.env.TORQCLAW_PORT = String(20000 + Math.floor(Math.random() * 10000));
    process.env.TORQCLAW_GATEWAY_TOKEN = 'unused';
    process.env.TORQCLAW_CHANNEL_SERVICE_TOKEN = 'unused-cst';

    // Import the REAL built server.js -- its top-level code runs
    // connectBridge() then the PB-1(a) registration block exactly as a real
    // gateway boot would. No websocket client of this test ever connects;
    // the listener binds but is unused (same posture as
    // agent-participation-s2-registration-live.test.ts).
    await import(pathToFileURL(join(GATEWAY_DIST_DIR, 'server.js')).href);

    const bridge = await import(
      pathToFileURL(join('packages', 'bridge', 'dist', 'index.js')).href
    ) as any;
    const registry = bridge.getRegistry();

    expect(
      registry.filter((t: any) => typeof t.name === 'string' && t.name.startsWith('research__')),
      'no research__-namespaced tool may be registered when TORQCLAW_WEB_SEARCH_ENABLED is unset -- ' +
      'the whole point of PB-1(a) is that this network-egress tool defaults OFF (CLAUDE.md §6)',
    ).toEqual([]);
    expect(
      registry.find((t: any) => t.name === 'research__web_search'),
      'research__web_search specifically must be absent flag-off',
    ).toBeUndefined();
  }, 30000);

  it('POSITIVE: connectInProcessServer(WEB_SEARCH_SERVER_ID, ...) -- the exact call PB-1(a) gates -- registers research__web_search when reached', async () => {
    const bridge = await import(
      pathToFileURL(join('packages', 'bridge', 'dist', 'index.js')).href
    ) as any;

    await bridge.connectInProcessServer(
      bridge.WEB_SEARCH_SERVER_ID,
      bridge.buildKeylessWebSearchMcpServer(),
      { capabilities: bridge.WEB_SEARCH_TOOL_CAPABILITIES },
    );

    const registry = bridge.getRegistry();
    const tool = registry.find((t: any) => t.name === 'research__web_search');
    expect(
      tool,
      'research__web_search must be registered by the same call PB-1(a) makes when webSearchEnabled() is true',
    ).toBeDefined();
    expect(tool.capability).toBe('read');
    expect(tool.requiresApproval).toBe(false);
  }, 30000);

  it('webSearchEnabled() itself reflects TORQCLAW_WEB_SEARCH_ENABLED -- the predicate the boot-time block reads', async () => {
    const gateway = await import(
      pathToFileURL(join('packages', 'gateway', 'dist', 'collabSurface.js')).href
    ) as any;

    const prev = process.env.TORQCLAW_WEB_SEARCH_ENABLED;
    try {
      delete process.env.TORQCLAW_WEB_SEARCH_ENABLED;
      expect(gateway.webSearchEnabled()).toBe(false);

      process.env.TORQCLAW_WEB_SEARCH_ENABLED = '0';
      expect(gateway.webSearchEnabled()).toBe(false);

      process.env.TORQCLAW_WEB_SEARCH_ENABLED = '1';
      expect(gateway.webSearchEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TORQCLAW_WEB_SEARCH_ENABLED;
      else process.env.TORQCLAW_WEB_SEARCH_ENABLED = prev;
    }
  });
});
