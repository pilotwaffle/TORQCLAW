/**
 * Live-wire proof: the production `FileSecretStore` closes the blocker
 * where the collab feature was entirely inert (secrets.ts's
 * `WindowsCredentialManagerStore` stub unconditionally threw
 * `NotImplementedError` on both `get` and `set`, so `getSecretStore()` in
 * collabIdentity.ts always failed and every credential fell through to
 * AUTH_FAILED). `tests/collab-built-artifact-boot.test.ts:36-45` documents
 * that failure and is deliberately left UNCHANGED by this slice (see the
 * report for why: it exercises the case where the pepper is genuinely never
 * persisted, which is still true today for a data dir this test never
 * bootstrapped -- that premise did not become false).
 *
 * THIS file proves the opposite, now-true case end to end, with NO test
 * preload and NO TORQCLAW_COLLAB_TEST_PEPPER:
 *
 *   1. POSITIVE CONTROL -- a credential whose pepper was persisted by
 *      `bootstrapOperator` (which itself calls the real, production
 *      `FileSecretStore.set()`, not a fixture double) authenticates
 *      successfully against the real built gateway.
 *   2. NEGATIVE CONTROL -- a wrong/garbage credential against that SAME
 *      installation still gets AUTH_FAILED + close(4001), proving this is
 *      not "everything passes now".
 *   3. PERSISTENCE ACROSS RESTART -- the pepper is written to disk by one
 *      process (bootstrapOperator running standalone, no gateway involved),
 *      then a BRAND NEW gateway child process (fresh `FileSecretStore`
 *      instance, fresh module state) reads it back off disk and
 *      authenticates. This is the entire point of `isPersistent`.
 *
 * Every gateway launch below passes `useTestPreload=false` to
 * `launchGateway` (see helpers/collab-gateway-harness.ts) -- the child
 * process gets NO `--import` and NO `NODE_ENV=test`, i.e. exactly the
 * production module-load path through `collabIdentity.ts`'s
 * `getSecretStore()` -> `new FileSecretStore(DATA_DIR)`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runCollaborationMigration } from '../packages/collab/src/migration.js';
import { bootstrapOperator, nodeRandomSource } from '../packages/collab/src/bootstrap.js';
import { DeterministicClock, DeterministicUuids } from '../packages/collab/src/harness.js';
import { FileSecretStore } from '../packages/collab/src/secrets.js';
import type { BootstrapDb } from '../packages/collab/src/bootstrap.js';
import {
  ensureGatewayBuild, launchGateway, connectAndCollect, closeWire, lastFrame,
  type GatewayHandle,
} from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

/**
 * Runs the REAL production `bootstrapOperator` against a real sqlite file
 * and a real `FileSecretStore(dataDir)` -- the exact class collabIdentity.ts
 * now wires in production, not a fixture double. Returns the operator's
 * plaintext credential token, which the caller presents over the wire.
 */
function bootstrapRealInstallation(dataDir: string, installationId: string): { credentialToken: string; operatorPrincipalId: string } {
  const collabPath = join(dataDir, 'collab.db');
  const sqlite = new Database(collabPath);
  runCollaborationMigration(sqlite);
  const db: BootstrapDb = {
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
    transaction: (fn) => sqlite.transaction(fn) as never,
  };
  const secretStore = new FileSecretStore(dataDir);
  const clock = new DeterministicClock();
  const uuids = new DeterministicUuids(installationId);

  const result = bootstrapOperator(
    { db, secretStore, clock, uuids, rng: nodeRandomSource },
    { operatorDisplayName: 'Operator', installationId, schemaVersion: 1 },
  );

  result.principalPepper.fill(0);
  result.recoveryPepper.fill(0);
  result.recoverySecret.fill(0);
  sqlite.close();

  return { credentialToken: result.operatorCredential, operatorPrincipalId: result.operatorPrincipalId };
}

describe('FileSecretStore live-wire proof: production path, NO test preload', () => {
  it('POSITIVE CONTROL: a credential bootstrapped through the real FileSecretStore authenticates against the real built gateway with no preload', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-filestore-pos-'));
    const collabPath = join(dataDir, 'collab.db');
    const { credentialToken } = bootstrapRealInstallation(dataDir, 'install-filestore-pos');

    // Confirm the pepper actually landed on disk under TORQCLAW_DATA_DIR,
    // not merely in this test process's memory.
    const pepperPath = join(dataDir, 'secrets', 'TORQCLAW_principal-pepper.secret');
    expect(existsSync(pepperPath)).toBe(true);
    expect(statSync(pepperPath).size).toBe(32);

    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_COLLAB_DB_PATH: collabPath,
      TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: '',
    }, /* useTestPreload */ false);
    await gateway.ready;

    const result = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'x',
      clientInfo: { name: 'filestore-pos', version: '0.1.0' },
      auth: { kind: 'surface', credential: credentialToken },
    });

    expect(result.frames.some((f: any) => f.type === 'ERROR')).toBe(false);
    expect(lastFrame(result)?.type).toBe('CONNECTED');
    await closeWire(result);
  }, 45000);

  it('NEGATIVE CONTROL: a wrong credential against the same real-pepper installation still gets AUTH_FAILED + close(4001)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-filestore-neg-'));
    const collabPath = join(dataDir, 'collab.db');
    bootstrapRealInstallation(dataDir, 'install-filestore-neg');

    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_COLLAB_DB_PATH: collabPath,
      TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: '',
    }, /* useTestPreload */ false);
    await gateway.ready;

    // A surface credential is presented (auth.kind = 'surface'), so this
    // exercises resolveConnectIdentity's real verification path rather than
    // the harness's separate tokenless-legacy-dev-mode branch (which a bare
    // no-`auth` frame would hit instead and is not this store's concern).
    const badToken = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'x',
      clientInfo: { name: 'filestore-neg-bad-token', version: '0.1.0' },
      auth: { kind: 'surface', credential: 'tq1_' + 'deadbeef-dead-beef-dead-beefdeadbeef' + '_notreal' },
    });
    expect(badToken.rawMessages).toEqual(['{"type":"ERROR","code":"AUTH_FAILED"}']);
    expect(badToken.close).toEqual({ code: 4001, reason: 'auth failed' });
  }, 45000);

  it('PERSISTENCE ACROSS PROCESS RESTART: pepper written by one process is read back by a BRAND NEW gateway process and authenticates', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-filestore-restart-'));
    const collabPath = join(dataDir, 'collab.db');
    // Bootstrap happens entirely OUTSIDE any gateway process -- proves the
    // pepper is durable storage, not something living in one process's
    // memory that happens to still be running.
    const { credentialToken } = bootstrapRealInstallation(dataDir, 'install-filestore-restart');

    // First gateway process: boot, authenticate once, then fully stop it
    // (SIGKILL via gateway.stop()) -- the process and all its in-memory
    // state (including any module-level defaultSecretStore singleton) is
    // gone after this.
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_COLLAB_DB_PATH: collabPath,
      TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: '',
    }, false);
    await gateway.ready;
    const first = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'x',
      clientInfo: { name: 'filestore-restart-1', version: '0.1.0' },
      auth: { kind: 'surface', credential: credentialToken },
    });
    expect(lastFrame(first)?.type).toBe('CONNECTED');
    await closeWire(first);
    await gateway.stop();
    gateway = null;

    // Second, entirely NEW gateway child process against the SAME data
    // dir. No env carries the pepper -- only the file FileSecretStore wrote
    // during bootstrap does.
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_COLLAB_DB_PATH: collabPath,
      TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: '',
    }, false);
    await gateway.ready;
    const second = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'x',
      clientInfo: { name: 'filestore-restart-2', version: '0.1.0' },
      auth: { kind: 'surface', credential: credentialToken },
    });
    expect(second.frames.some((f: any) => f.type === 'ERROR')).toBe(false);
    expect(lastFrame(second)?.type).toBe('CONNECTED');
    await closeWire(second);
  }, 60000);
});
