import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INSTALL_STEPS = [
  { command: 'git', args: ['submodule', 'update', '--init', '--recursive'], cwd: 'root' },
  { command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: 'root' },
  { command: 'pnpm', args: ['--filter', '@torqclaw/contracts', 'build'], cwd: 'root' },
  { command: 'uv', args: ['sync', '--locked'], cwd: 'engine' },
  { command: 'uv', args: ['pip', 'install', '--python', '.venv', '-e', './vendor/hermes-agent'], cwd: 'engine' },
  { command: 'uv', args: ['run', 'python', '-c', 'from run_agent import AIAgent'], cwd: 'engine' },
];

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function resolveInvocation(step, { platform, env, comspec }) {
  if (platform === 'win32' && step.command === 'pnpm') {
    const commandLine = ['pnpm.cmd', ...step.args].join(' ');
    return {
      command: comspec || env.ComSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine],
    };
  }
  return { command: step.command, args: step.args };
}

export function runInstall({
  root = ROOT,
  engineDir = path.join(root, 'engines', 'hermes_kernel'),
  spawnSyncImpl = spawnSync,
  platform = process.platform,
  env = process.env,
  comspec,
} = {}) {
  // Deliberately no .env operation: install never creates, edits, or overwrites operator secrets.
  const resolvedSteps = INSTALL_STEPS.map((step) => ({
    ...step,
    ...resolveInvocation(step, { platform, env, comspec }),
    cwd: step.cwd === 'root' ? root : engineDir,
  }));
  for (const step of resolvedSteps) {
    let result;
    try {
      result = spawnSyncImpl(step.command, step.args, {
        cwd: step.cwd,
        env,
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
      });
    } catch {
      throw new Error(`install step failed: ${step.args[0] ?? step.command}`);
    }
    if (result?.error || result?.status !== 0) {
      throw new Error(`install step failed: ${step.args[0] ?? step.command}`);
    }
  }
  return resolvedSteps;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runInstall();
    process.stdout.write('TORQCLAW install complete. Configure .env before starting.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'install failed'}\n`);
    process.exitCode = 1;
  }
}
