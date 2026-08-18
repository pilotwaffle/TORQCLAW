/**
 * Live-wire proof for `ops/bootstrap-operator.mjs` -- the script that closes
 * the gap where `bootstrapOperator` (packages/collab/src/bootstrap.ts) had
 * ZERO production callers. This file does not hand-construct a credential
 * with the exported bootstrap function directly (that is already covered by
 * tests/collab-secret-store-live-wire.test.ts, which proves the SUBSTRATE
 * works); this file proves the OPERATOR-FACING WIRING works, by actually
 * spawning `ops/bootstrap-operator.mjs` as a real child process -- exactly
 * as an operator would run it -- and using whatever it prints/writes, with
 * no shortcuts.
 *
 * Every gateway launch below passes useTestPreload=false to launchGateway
 * (see helpers/collab-gateway-harness.ts): the child gets NO `--import` and
 * NO NODE_ENV=test, i.e. the real production module-load path.
 *
 * Covers:
 *   1. POSITIVE CONTROL -- the credential ops/bootstrap-operator.mjs prints
 *      (and writes to its token file) authenticates against the real built
 *      gateway.
 *   2. NEGATIVE CONTROL -- a wrong credential against that same installation
 *      still gets AUTH_FAILED + close(4001).
 *   3. IDEMPOTENCY -- running the script a second time (after removing the
 *      token file, simulating an operator who copied it) does NOT create a
 *      second operator or rotate anything: it exits non-zero with a plain
 *      refusal, and the FIRST credential still authenticates afterward. This
 *      is the assertion that would catch a silent rotation.
 *   4. TOKEN-FILE REFUSAL -- running the script again while the token file
 *      from run #1 still exists refuses without touching the database at
 *      all.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureGatewayBuild, launchGateway, connectAndCollect, closeWire, lastFrame,
  ROOT, type GatewayHandle,
} from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

const SCRIPT = join(ROOT, 'ops', 'bootstrap-operator.mjs');

type ScriptResult = { status: number | null; stdout: string; stderr: string };

/** Runs the REAL ops/bootstrap-operator.mjs as a child process, exactly the
 *  way an operator invokes it -- no in-process shortcuts, no direct import
 *  of bootstrapOperator by this test file. */
function runBootstrapScript(dataDir: string, extraArgs: string[] = []): ScriptResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, TORQCLAW_DATA_DIR: dataDir },
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function tokenFilePath(dataDir: string): string {
  return join(dataDir, 'operator-credential.token');
}

/** Extracts the printed token from the script's stdout banner. */
function extractPrintedToken(stdout: string): string {
  const match = stdout.match(/tq1_[A-Za-z0-9_-]+/);
  if (!match) throw new Error('no tq1_ token found in bootstrap script stdout:\n' + stdout);
  return match[0];
}

describe('ops/bootstrap-operator.mjs live-wire proof: real script, real built gateway, NO test preload', () => {
  it('POSITIVE CONTROL: the credential the real script prints and writes authenticates against the real built gateway', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-ops-bootstrap-pos-'));

    const run = runBootstrapScript(dataDir, ['--display-name', 'Live Wire Operator']);
    expect(run.status, 'bootstrap script stderr:\n' + run.stderr).toBe(0);

    const printedToken = extractPrintedToken(run.stdout);

    // The token file must exist, contain the SAME token, and be a regular
    // file the script created (not something left over from a prior run --
    // this dataDir is freshly minted per-test).
    const filePath = tokenFilePath(dataDir);
    expect(existsSync(filePath)).toBe(true);
    const fileToken = readFileSync(filePath, 'utf8').trim();
    expect(fileToken).toBe(printedToken);

    const collabPath = join(dataDir, 'collab.db');
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_COLLAB_DB_PATH: collabPath,
      TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: '',
    }, /* useTestPreload */ false);
    await gateway.ready;

    const result = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'x',
      clientInfo: { name: 'ops-bootstrap-pos', version: '0.1.0' },
      auth: { kind: 'surface', credential: printedToken },
    });

    expect(result.frames.some((f: any) => f.type === 'ERROR')).toBe(false);
    expect(lastFrame(result)?.type).toBe('CONNECTED');
    await closeWire(result);
  }, 45000);

  it('NEGATIVE CONTROL: a wrong credential against the same script-bootstrapped installation still gets AUTH_FAILED + close(4001)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-ops-bootstrap-neg-'));
    const run = runBootstrapScript(dataDir);
    expect(run.status, 'bootstrap script stderr:\n' + run.stderr).toBe(0);

    const collabPath = join(dataDir, 'collab.db');
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_COLLAB_DB_PATH: collabPath,
      TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: '',
    }, false);
    await gateway.ready;

    const badToken = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'x',
      clientInfo: { name: 'ops-bootstrap-neg', version: '0.1.0' },
      auth: { kind: 'surface', credential: 'tq1_' + 'deadbeef-dead-beef-dead-beefdeadbeef' + '_notreal' },
    });
    expect(badToken.rawMessages).toEqual(['{"type":"ERROR","code":"AUTH_FAILED"}']);
    expect(badToken.close).toEqual({ code: 4001, reason: 'auth failed' });
  }, 45000);

  it('TOKEN-FILE REFUSAL: running the script again while the token file from run 1 still exists refuses cleanly without touching the DB', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-ops-bootstrap-fileguard-'));
    const first = runBootstrapScript(dataDir);
    expect(first.status).toBe(0);

    const collabPath = join(dataDir, 'collab.db');
    const collabMtimeBefore = statSync(collabPath).mtimeMs;

    const second = runBootstrapScript(dataDir);
    expect(second.status).toBe(2);
    expect(second.stderr).toMatch(/already exists/);
    expect(second.stdout).toBe('');

    // The DB was not reopened/rewritten by the refused second run -- the
    // refusal happens before any collab.db work.
    const collabMtimeAfter = statSync(collabPath).mtimeMs;
    expect(collabMtimeAfter).toBe(collabMtimeBefore);
  }, 45000);

  it('IDEMPOTENCY: a second run (token file removed, simulating a copied token) creates no second operator, rotates nothing, and the FIRST credential still authenticates', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-ops-bootstrap-idem-'));

    const first = runBootstrapScript(dataDir, ['--display-name', 'Original Operator']);
    expect(first.status, 'first run stderr:\n' + first.stderr).toBe(0);
    const firstToken = extractPrintedToken(first.stdout);

    // Simulate the operator having copied the token and deleted the file,
    // exactly as the script instructs them to.
    rmSync(tokenFilePath(dataDir));

    const pepperPath = join(dataDir, 'secrets', 'TORQCLAW_principal-pepper.secret');
    const pepperMtimeBefore = statSync(pepperPath).mtimeMs;
    const pepperBytesBefore = readFileSync(pepperPath);

    const second = runBootstrapScript(dataDir, ['--display-name', 'Second Attempt Operator']);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already has an operator principal/);

    // No second token file was written by the refused run.
    expect(existsSync(tokenFilePath(dataDir))).toBe(false);

    // The pepper file is byte-identical and untouched -- proves run 2 did
    // not rotate the pepper backing every already-issued credential.
    const pepperMtimeAfter = statSync(pepperPath).mtimeMs;
    const pepperBytesAfter = readFileSync(pepperPath);
    expect(pepperMtimeAfter).toBe(pepperMtimeBefore);
    expect(pepperBytesAfter.equals(pepperBytesBefore)).toBe(true);

    // THE assertion that catches a silent rotation: the FIRST credential
    // must still authenticate against the real built gateway after the
    // second (refused) run.
    const collabPath = join(dataDir, 'collab.db');
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dataDir,
      TORQCLAW_COLLAB_DB_PATH: collabPath,
      TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: '',
    }, false);
    await gateway.ready;

    const result = await connectAndCollect(gateway.url, {
      role: 'operator', token: 'x',
      clientInfo: { name: 'ops-bootstrap-idem', version: '0.1.0' },
      auth: { kind: 'surface', credential: firstToken },
    });
    expect(result.frames.some((f: any) => f.type === 'ERROR')).toBe(false);
    expect(lastFrame(result)?.type).toBe('CONNECTED');
    await closeWire(result);
  }, 60000);
});
