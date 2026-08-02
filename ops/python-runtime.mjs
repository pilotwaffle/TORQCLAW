import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the Hermes project interpreter for Node-launched Python fixtures. */
export function pythonRuntime(root) {
  const engineRoot = join(root, 'engines', 'hermes_kernel');
  const interpreter = join(
    engineRoot,
    process.platform === 'win32' ? '.venv' : '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    'python.exe',
  );
  const unixInterpreter = join(engineRoot, '.venv', 'bin', 'python');
  const selected = process.platform === 'win32' ? interpreter : unixInterpreter;
  if (existsSync(selected)) return { command: selected, argsPrefix: [], cwd: engineRoot };
  return {
    command: process.platform === 'win32' ? 'uv.exe' : 'uv',
    argsPrefix: ['run', 'python'],
    cwd: engineRoot,
  };
}
