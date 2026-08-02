import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, doctorPassed, formatDoctor, DEFAULT_ROOT } from './doctor-core.mjs';

export function parseArgs(argv) {
  const modes = argv.filter((arg) => arg === '--preflight' || arg === '--runtime');
  if (modes.length !== 1) throw new Error('doctor requires exactly one of --preflight or --runtime');
  return {
    mode: modes[0].slice(2),
    json: argv.includes('--json'),
    production: argv.includes('--production'),
    liveRequested: argv.includes('--live'),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const records = await runDoctor({ ...options, root: DEFAULT_ROOT });
  process.stdout.write(`${formatDoctor(records, options.json)}\n`);
  return doctorPassed(records) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'doctor failed'}\n`);
    process.exitCode = 2;
  }
}
