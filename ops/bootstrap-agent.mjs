#!/usr/bin/env node
/**
 * Provision one first-class collaboration agent into a human-owned channel.
 *
 * This is an explicit trusted operator action. It reuses CollaborationStore
 * so ownership, audit, authorization, normalization, and idempotency rules
 * remain identical to the gateway command path. The one-time agent
 * credential is written outside the repository with owner-only mode and is
 * never printed.
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

function usage() {
  return 'Usage: node ops/bootstrap-agent.mjs [--agent-name "Torq Builder"] [--channel-name "build-room"]';
}

function parseArgs(argv) {
  let agentName = 'Torq Builder';
  let channelName = 'build-room';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--agent-name' || arg === '--channel-name') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--agent-name') agentName = value;
      else channelName = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { agentName, channelName };
}

function stableKey(kind, ...values) {
  const digest = createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
  return `bootstrap-agent-v1:${kind}:${digest}`;
}

function writeCredential(dataDir, result) {
  if (!result.credentialAvailable) return null;
  let path = join(dataDir, `agent-${result.principalId}-credential.token`);
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    path = join(dataDir, `agent-${result.principalId}-${result.credentialId}-credential.token`);
    fd = openSync(path, 'wx', 0o600);
  }
  try {
    writeSync(fd, `${result.credential}\n`);
  } finally {
    closeSync(fd);
  }
  return path;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${usage()}\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  const dataDir = process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw');
  const collabDbPath = process.env.TORQCLAW_COLLAB_DB_PATH || join(dataDir, 'collab.db');
  mkdirSync(dataDir, { recursive: true });

  let collab;
  try {
    collab = await import('../packages/collab/dist/index.js');
  } catch (error) {
    process.stderr.write(
      `${usage()}\nRefused: could not load @torqclaw/collab build output. ` +
      `Run \`pnpm --filter @torqclaw/collab build\` first.\n` +
      `(${error instanceof Error ? error.constructor.name : 'error'})\n`,
    );
    process.exitCode = 2;
    return;
  }

  const sqlite = new Database(collabDbPath);
  let principalPepper;
  try {
    collab.runCollaborationMigration(sqlite);
    collab.runSurfaceIdentityMigration(sqlite);
    collab.runSurfaceAuditMigration(sqlite);
    collab.runAgentAutoreplyMigration(sqlite);
    collab.runAgentCronMigration(sqlite);

    const secretStore = new collab.FileSecretStore(dataDir);
    principalPepper = secretStore.get('TORQCLAW/principal-pepper');
    if (!principalPepper) {
      throw new Error('operator bootstrap is required before agent provisioning');
    }

    const operator = sqlite
      .prepare("SELECT id FROM principals WHERE kind = 'operator' LIMIT 1")
      .get();
    if (!operator?.id) {
      throw new Error('no operator principal exists; run node ops/bootstrap-operator.mjs first');
    }

    const store = new collab.CollaborationStore({
      db: sqlite,
      clock: collab.systemClock,
      uuids: { next: () => randomUUID() },
      rng: collab.nodeRandomSource,
      principalPepper,
    });
    const caller = { principalId: operator.id, kind: 'operator' };

    const agent = await store.createAgent(
      caller,
      { displayName: args.agentName },
      stableKey('agent', args.agentName),
    );
    const credentialPath = writeCredential(dataDir, agent);

    const channel = await store.createChannel(
      caller,
      { name: args.channelName },
      stableKey('channel', args.channelName),
    );
    await store.addChannelMember(
      caller,
      { channelId: channel.channelId, principalId: agent.principalId },
      stableKey('membership', channel.channelId, agent.principalId),
    );

    process.stdout.write(
      `TORQCLAW collaboration agent ready.\n` +
      `Agent: ${args.agentName} (${agent.principalId})\n` +
      `Channel: ${args.channelName} (${channel.channelId})\n` +
      (credentialPath
        ? `Agent credential written once to: ${credentialPath}\n`
        : 'Agent credential: already provisioned; no credential was reissued.\n'),
    );
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? ` [${String(error.code)}]` : '';
    process.stderr.write(
      `${usage()}\nProvisioning failed${code}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    principalPepper?.fill(0);
    sqlite.close();
  }
}

await main();
