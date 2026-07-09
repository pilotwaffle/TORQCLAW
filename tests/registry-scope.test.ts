import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { executeTool, getRegistry, type RegisteredTool } from '../packages/bridge/src/registry.js';

// Platform-native absolute fixture paths. Hardcoding `C:\...` made these tests
// resolve relative to cwd on Linux CI, flipping in-scope vs out-of-scope — the
// classifier logic is OS-independent, only the fixtures were not. join() with an
// absolute anchor keeps "allowed" genuinely inside and "outside" genuinely
// outside the write allowlist on both Windows and POSIX.
const ANCHOR = process.platform === 'win32' ? 'C:\\' : '/';
const ALLOWED_DIR = join(ANCHOR, 'torq-scope-allowed');
const ALLOWED_PATH = join(ALLOWED_DIR, 'ok.txt');
const OUTSIDE_PATH = join(ANCHOR, 'torq-scope-outside', 'target.txt');

/** TCLAW-0C regression-proof for the path-scope bug fix at the executeTool
 *  call site (registry.ts ~106-112): scope mode must come from the tool's
 *  CAPABILITY (scopeModeFor), never from the requiresApproval flag.
 *
 *  No live MCP client is needed: the checkPath throw fires BEFORE getClient
 *  is reached, and getRegistry() returns the live registry array by
 *  reference, so tests can register synthetic entries directly — no
 *  production test seam was added.
 */

const TEST_PREFIX = 'scopetest__';

afterEach(() => {
  // getRegistry() is the live array — remove our synthetic entries.
  const reg = getRegistry();
  for (let i = reg.length - 1; i >= 0; i--) {
    if (reg[i]!.name.startsWith(TEST_PREFIX)) reg.splice(i, 1);
  }
});

function register(entry: Omit<RegisteredTool, 'description' | 'inputSchema' | 'sourceServerId'>): void {
  getRegistry().push({
    description: 'synthetic test tool',
    inputSchema: {},
    sourceServerId: 'scopetest',
    ...entry,
  });
}

describe('executeTool() — path-scope mode comes from capability, not requiresApproval', () => {
  it('write-class tool + requiresApproval=false: write allowlist is enforced (old buggy code would have used read mode and let it through)', async () => {
    // Discriminating setup: capability 'write' but requiresApproval false.
    //   OLD code: mode = requiresApproval ? 'write' : 'read' -> 'read';
    //             read allowlist is absent (= unconstrained) -> NO throw,
    //             call proceeds to getClient and fails with a DIFFERENT
    //             error ("No MCP client connected").
    //   NEW code: mode = scopeModeFor('write') -> 'write';
    //             target path is outside the write allowlist -> throws
    //             'Path scope denied ...' before any client lookup.
    register({
      name: `${TEST_PREFIX}sneaky_writer`,
      rawName: 'sneaky_writer',
      capability: 'write',
      requiresApproval: false,
      pathScope: { write: [ALLOWED_DIR] }, // no read list, no deny
    });

    await expect(
      executeTool(`${TEST_PREFIX}sneaky_writer`, { path: OUTSIDE_PATH }),
    ).rejects.toThrow(/Path scope/);
  });

  it('read-class tool + requiresApproval=true: read mode applies, write allowlist is NOT consulted (old code would have wrongly write-scoped it)', async () => {
    // Inverse decoupling proof: a read tool force-gated via approvalPatterns.
    //   OLD code: requiresApproval true -> write mode -> path outside the
    //             write allowlist -> spurious 'Path scope' denial.
    //   NEW code: scopeModeFor('read') -> read mode; read allowlist absent
    //             (= unconstrained) -> path check passes, execution proceeds
    //             to getClient, which fails with the no-client error — the
    //             assertion below proves the path check did NOT block.
    register({
      name: `${TEST_PREFIX}gated_reader`,
      rawName: 'gated_reader',
      capability: 'read',
      requiresApproval: true,
      pathScope: { write: [ALLOWED_DIR] },
    });

    await expect(
      executeTool(`${TEST_PREFIX}gated_reader`, { path: OUTSIDE_PATH }),
    ).rejects.toThrow(/No MCP client connected/);
  });

  it('write-class tool inside its write allowlist passes the path check (reaches the client lookup)', async () => {
    register({
      name: `${TEST_PREFIX}scoped_writer`,
      rawName: 'scoped_writer',
      capability: 'write',
      requiresApproval: true,
      pathScope: { write: [ALLOWED_DIR] },
    });

    // In-scope path: check passes, so the failure is the absent client —
    // NOT a path-scope denial.
    await expect(
      executeTool(`${TEST_PREFIX}scoped_writer`, { path: ALLOWED_PATH }),
    ).rejects.toThrow(/No MCP client connected/);
  });
});
