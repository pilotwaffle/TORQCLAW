import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureGatewayBuild, ROOT } from './helpers/collab-gateway-harness.js';

const OPERATOR_SCRIPT = join(ROOT, 'ops', 'bootstrap-operator.mjs');
const AGENT_SCRIPT = join(ROOT, 'ops', 'bootstrap-agent.mjs');

beforeAll(async () => { await ensureGatewayBuild(); }, 200000);

function run(script: string, dataDir: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, TORQCLAW_DATA_DIR: dataDir },
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('ops/bootstrap-agent.mjs', () => {
  it('provisions an audited agent membership and reruns without duplication or secret disclosure', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-agent-bootstrap-'));
    const operator = run(OPERATOR_SCRIPT, dataDir);
    expect(operator.status, operator.stderr).toBe(0);

    const args = ['--agent-name', 'Build Partner', '--channel-name', 'human-build-room'];
    const first = run(AGENT_SCRIPT, dataDir, args);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).not.toMatch(/tq1_[A-Za-z0-9_-]+/);

    const credentialFiles = readdirSync(dataDir).filter((name) => /^agent-.*-credential\.token$/.test(name));
    expect(credentialFiles).toHaveLength(1);
    const credentialBefore = readFileSync(join(dataDir, credentialFiles[0]!), 'utf8');
    expect(credentialBefore.trim()).toMatch(/^tq1_[A-Za-z0-9_-]+$/);

    const db = new Database(join(dataDir, 'collab.db'));
    const agent = db.prepare(
      "SELECT id, status FROM principals WHERE kind = 'agent' AND display_name = ?",
    ).get('Build Partner') as { id: string; status: string };
    const channel = db.prepare(
      'SELECT id, owner_principal_id AS ownerId FROM collab_channels WHERE name = ?',
    ).get('human-build-room') as { id: string; ownerId: string };
    const membership = db.prepare(
      'SELECT role, state FROM collab_members WHERE channel_id = ? AND principal_id = ?',
    ).get(channel.id, agent.id) as { role: string; state: string };
    expect(agent.status).toBe('active');
    expect(membership).toEqual({ role: 'agent', state: 'active' });
    expect(channel.ownerId).not.toBe(agent.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM collab_audit WHERE kind = 'credential_created' AND subject_principal_id = ?").get(agent.id)).toEqual({ count: 1 });
    db.close();

    const second = run(AGENT_SCRIPT, dataDir, args);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('already provisioned');
    expect(second.stdout).not.toMatch(/tq1_[A-Za-z0-9_-]+/);
    expect(readFileSync(join(dataDir, credentialFiles[0]!), 'utf8')).toBe(credentialBefore);

    const verify = new Database(join(dataDir, 'collab.db'));
    expect(verify.prepare("SELECT COUNT(*) AS count FROM principals WHERE kind = 'agent'").get()).toEqual({ count: 1 });
    expect(verify.prepare('SELECT COUNT(*) AS count FROM collab_channels').get()).toEqual({ count: 1 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM collab_members WHERE role = 'agent'").get()).toEqual({ count: 1 });
    verify.close();
  }, 60000);
});
