import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TURBO_CLI = fileURLToPath(new URL('../node_modules/turbo/bin/turbo', import.meta.url));

export function ensureRuntimeBuild({
  root,
  includeHttpChannel = false,
  nodeExecutable = process.execPath,
  spawnSyncImpl = spawnSync,
  env = process.env,
} = {}) {
  const filters = ['--filter=@torqclaw/gateway...'];
  if (includeHttpChannel) filters.push('--filter=@torqclaw/channel-http...');

  const args = [TURBO_CLI, 'run', 'build', ...filters];
  const result = spawnSyncImpl(nodeExecutable, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });

  if (result.error) {
    throw new Error(`runtime build failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`runtime build failed with exit code ${result.status ?? 'unknown'}`);
  }
}
