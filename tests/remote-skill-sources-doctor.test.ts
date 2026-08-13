import { describe, expect, it, vi } from 'vitest';

// P4-3 gates: AC-7 (flag-off byte-identity — no remote-skill-sources record,
// no preflight command spawned), AC-8 (doctor preflight red/absent behavior),
// DP-14 (an unset flag must never be treated as truthy).

const { runDoctor } = await import('../ops/doctor-core.mjs');

const baseEnv = {
  TORQCLAW_GATEWAY_TOKEN: 'synthetic-matching-token',
  NEXT_PUBLIC_GATEWAY_TOKEN: 'synthetic-matching-token',
  NEXT_PUBLIC_GATEWAY_URL: 'ws://127.0.0.1:18790/ws',
  TORQCLAW_HOST: '127.0.0.1',
  HERMES_BIND_HOST: '127.0.0.1',
};

const fsImpl = { existsSync: vi.fn(() => true) };
const successfulSpawn = vi.fn(() => ({ status: 0 }));

describe('P4-3 doctor conditional preflight (R-5, AC-7, AC-8)', () => {
  it('AC-7 / SP-1: omits the remote-skill-sources record entirely when the flag is unset', async () => {
    const spawnImpl = vi.fn(() => ({ status: 0 }));
    const records = await runDoctor({
      mode: 'preflight', production: true, root: 'R', env: { ...baseEnv }, fsImpl,
      spawnImpl, nodeVersion: '22.1.0', envFilePresent: true,
      portProbe: vi.fn(async () => true),
    });
    expect(records.find((entry: any) => entry.id === 'preflight.remote-skill-sources')).toBeUndefined();
    // No preflight subprocess invocation should have been made for it — the
    // only spawn calls on a flag-off run are the pre-existing hermes-import
    // check, never `-m mcp_wrapper.remote_preflight`.
    const remoteCalls = spawnImpl.mock.calls.filter((call) =>
      Array.isArray(call[1]) && call[1].includes('mcp_wrapper.remote_preflight'));
    expect(remoteCalls).toHaveLength(0);
  });

  it('DP-14: falsy-looking values (0/false/off/empty/whitespace) never trigger the preflight', async () => {
    for (const value of ['', '  ', '0', 'false', 'no', 'off']) {
      const spawnImpl = vi.fn(() => ({ status: 0 }));
      const records = await runDoctor({
        mode: 'preflight', production: true, root: 'R',
        env: { ...baseEnv, TORQCLAW_REMOTE_SKILL_SOURCES: value }, fsImpl,
        spawnImpl, nodeVersion: '22.1.0', envFilePresent: true,
        portProbe: vi.fn(async () => true),
      });
      expect(records.find((entry: any) => entry.id === 'preflight.remote-skill-sources')).toBeUndefined();
    }
  });

  it('AC-8: reports a red preflight.remote-skill-sources when the flag is on and the check fails', async () => {
    const failingSpawn = vi.fn(() => ({ status: 1 }));
    const records = await runDoctor({
      mode: 'preflight', production: true, root: 'R',
      env: { ...baseEnv, TORQCLAW_REMOTE_SKILL_SOURCES: '1' }, fsImpl,
      spawnImpl: failingSpawn, nodeVersion: '22.1.0', envFilePresent: true,
      portProbe: vi.fn(async () => true),
    });
    const entry = records.find((e: any) => e.id === 'preflight.remote-skill-sources');
    expect(entry).toMatchObject({ status: 'fail', severity: 'error' });
    const call = failingSpawn.mock.calls.find((c) =>
      Array.isArray(c[1]) && c[1].includes('mcp_wrapper.remote_preflight'));
    expect(call).toBeTruthy();
  });

  it('AC-8: reports a pass when the flag is on and the check succeeds', async () => {
    const records = await runDoctor({
      mode: 'preflight', production: true, root: 'R',
      env: { ...baseEnv, TORQCLAW_REMOTE_SKILL_SOURCES: 'true' }, fsImpl,
      spawnImpl: successfulSpawn, nodeVersion: '22.1.0', envFilePresent: true,
      portProbe: vi.fn(async () => true),
    });
    const entry = records.find((e: any) => e.id === 'preflight.remote-skill-sources');
    expect(entry).toMatchObject({ status: 'pass', severity: 'info' });
  });

  it('accepts the four truthy spellings (1/true/yes/on)', async () => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      const spawnImpl = vi.fn(() => ({ status: 0 }));
      const records = await runDoctor({
        mode: 'preflight', production: true, root: 'R',
        env: { ...baseEnv, TORQCLAW_REMOTE_SKILL_SOURCES: value }, fsImpl,
        spawnImpl, nodeVersion: '22.1.0', envFilePresent: true,
        portProbe: vi.fn(async () => true),
      });
      expect(records.find((entry: any) => entry.id === 'preflight.remote-skill-sources')?.status).toBe('pass');
    }
  });
});
