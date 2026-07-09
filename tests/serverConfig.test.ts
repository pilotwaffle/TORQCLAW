import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadServerConfigs } from '../packages/bridge/src/serverConfig.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'torq-servers-'));
  process.env.TORQCLAW_DATA_DIR = dir;
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // silence expected warnings
});
afterEach(() => {
  delete process.env.TORQCLAW_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const write = (obj: unknown) => writeFileSync(join(dir, 'servers.json'), JSON.stringify(obj));

describe('loadServerConfigs', () => {
  it('returns [] when the file is absent', () => {
    expect(loadServerConfigs()).toEqual([]);
  });

  it('parses a valid stdio + streamable-http roster', () => {
    write({
      servers: [
        { id: 'fs', transport: { type: 'stdio', command: 'npx', args: ['srv'] } },
        { id: 'remote', transport: { type: 'streamable-http', url: 'http://x/mcp', token: 't' } },
      ],
    });
    const cfgs = loadServerConfigs();
    expect(cfgs).toHaveLength(2);
    expect(cfgs[0]!.id).toBe('fs');
    expect(cfgs[1]!.transport).toMatchObject({ type: 'streamable-http', url: 'http://x/mcp' });
  });

  it('skips everything on malformed JSON', () => {
    writeFileSync(join(dir, 'servers.json'), '{ not json');
    expect(loadServerConfigs()).toEqual([]);
  });

  it('skips everything on failed schema validation (bad id)', () => {
    write({ servers: [{ id: 'BAD ID', transport: { type: 'stdio', command: 'x' } }] });
    expect(loadServerConfigs()).toEqual([]);
  });

  it('drops disabled entries', () => {
    write({
      servers: [
        { id: 'on', transport: { type: 'stdio', command: 'a' } },
        { id: 'off', transport: { type: 'stdio', command: 'b' }, enabled: false },
      ],
    });
    const cfgs = loadServerConfigs();
    expect(cfgs.map((c) => c.id)).toEqual(['on']);
  });

  it('compiles approvalPatterns into case-insensitive RegExps', () => {
    write({
      servers: [{ id: 'fs', transport: { type: 'stdio', command: 'a' }, approvalPatterns: ['write'] }],
    });
    const [cfg] = loadServerConfigs();
    expect(cfg!.approvalPatterns?.[0]?.test('WRITE_FILE')).toBe(true);
  });

  it('parses a capabilities map and threads it onto the returned config', () => {
    write({
      servers: [
        {
          id: 'fs',
          transport: { type: 'stdio', command: 'a' },
          capabilities: { innocuous_tool: 'write' },
        },
      ],
    });
    const [cfg] = loadServerConfigs();
    expect(cfg!.capabilities).toEqual({ innocuous_tool: 'write' });
  });
});
