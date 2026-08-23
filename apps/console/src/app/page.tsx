import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import TorqTerminal from '@/components/TorqTerminal';

export const dynamic = 'force-dynamic';

function operatorCredential(): string {
  const configured = String(process.env.TORQCLAW_OPERATOR_CREDENTIAL ?? '').trim();
  if (configured) return configured;

  const dataDir = process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw');
  try {
    const credential = readFileSync(join(dataDir, 'operator-credential.token'), 'utf8').trim();
    if (credential) return credential;
  } catch {
    // Report a stable error below without exposing filesystem details.
  }
  throw new Error('Operator credential unavailable; bootstrap an operator before starting the console');
}

export default function Home() {
  return (
    <main className="min-h-screen bg-bg">
      <TorqTerminal operatorCredential={operatorCredential()} />
    </main>
  );
}
