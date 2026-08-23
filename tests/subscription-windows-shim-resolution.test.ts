import { describe, expect, it } from 'vitest';
import {
  resolveSpawnTarget,
  type SpawnTargetResolverEnv,
} from '../packages/gateway/src/safeSubscriptionProcess.js';

// Verbatim shape of an npm-generated Windows .cmd shim (what %APPDATA%\npm\claude-agent-acp.cmd
// contains). Reproduced 2026-08-22: spawn('claude-agent-acp',{shell:false}) -> ENOENT and
// spawn('claude-agent-acp.cmd',{shell:false}) -> EINVAL on Node 22, so the only shell:false path
// is the shim's node target.
const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  '
  + '"%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js" %*',
].join('\r\n');

const NPM_DIR = 'C:\\Users\\op\\AppData\\Roaming\\npm';
const ENTRY = `${NPM_DIR}\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js`;

function fakeEnv(files: Record<string, string | true>, overrides: Partial<SpawnTargetResolverEnv> = {}): SpawnTargetResolverEnv {
  return {
    platform: 'win32',
    pathEnv: `C:\\Windows\\system32;${NPM_DIR};C:\\tools`,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    exists: (file) => file in files,
    readText: (file) => {
      const value = files[file];
      if (typeof value !== 'string') throw new Error('EISDIR');
      return value;
    },
    ...overrides,
  };
}

describe('resolveSpawnTarget (Windows npm shim resolution, shell:false)', () => {
  it('rewrites a bare npm bin name to node + the shim entry, preserving args', () => {
    const env = fakeEnv({ [`${NPM_DIR}\\claude-agent-acp.cmd`]: NPM_SHIM, [ENTRY]: true });
    expect(resolveSpawnTarget('claude-agent-acp', ['--flag'], env))
      .toEqual({ command: env.execPath, args: [ENTRY, '--flag'] });
  });

  it('is a no-op off Windows', () => {
    const env = fakeEnv({ [`${NPM_DIR}\\claude-agent-acp.cmd`]: NPM_SHIM, [ENTRY]: true }, { platform: 'linux' });
    expect(resolveSpawnTarget('claude-agent-acp', [], env)).toEqual({ command: 'claude-agent-acp', args: [] });
  });

  it('leaves the plan unchanged when nothing on PATH matches (ENOENT surfaces as not_found)', () => {
    expect(resolveSpawnTarget('claude-agent-acp', [], fakeEnv({})))
      .toEqual({ command: 'claude-agent-acp', args: [] });
  });

  it('prefers a real .exe on PATH over a later .cmd shim', () => {
    const env = fakeEnv({
      'C:\\Windows\\system32\\claude-agent-acp.exe': true,
      [`${NPM_DIR}\\claude-agent-acp.cmd`]: NPM_SHIM, [ENTRY]: true,
    });
    expect(resolveSpawnTarget('claude-agent-acp', [], env)).toEqual({ command: 'claude-agent-acp', args: [] });
  });

  it('does not rewrite commands that already carry a path or an extension', () => {
    const env = fakeEnv({ [`${NPM_DIR}\\claude-agent-acp.cmd`]: NPM_SHIM, [ENTRY]: true });
    expect(resolveSpawnTarget('claude-agent-acp.cmd', [], env).command).toBe('claude-agent-acp.cmd');
    expect(resolveSpawnTarget(`${NPM_DIR}\\claude-agent-acp`, [], env).command).toBe(`${NPM_DIR}\\claude-agent-acp`);
  });

  it('refuses a shim whose target is not the npm template or escapes node_modules', () => {
    const escaping = NPM_SHIM.replace(
      '"%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js"',
      '"%dp0%\\node_modules\\..\\..\\evil.js"',
    );
    const env = fakeEnv({ [`${NPM_DIR}\\claude-agent-acp.cmd`]: escaping, 'C:\\Users\\op\\AppData\\evil.js': true });
    expect(resolveSpawnTarget('claude-agent-acp', [], env).command).toBe('claude-agent-acp');

    const foreign = fakeEnv({ [`${NPM_DIR}\\claude-agent-acp.cmd`]: '@echo off\r\npowershell -c evil' });
    expect(resolveSpawnTarget('claude-agent-acp', [], foreign).command).toBe('claude-agent-acp');
  });

  it('leaves the plan unchanged when the shim target file is missing', () => {
    const env = fakeEnv({ [`${NPM_DIR}\\claude-agent-acp.cmd`]: NPM_SHIM });
    expect(resolveSpawnTarget('claude-agent-acp', [], env).command).toBe('claude-agent-acp');
  });
});
