import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const evidenceFlag = process.argv.indexOf('--evidence-dir');
if (evidenceFlag < 0 || !process.argv[evidenceFlag + 1]) {
  throw new Error('usage: node scripts/run-profile-conformance-mutants.mjs --evidence-dir <external-directory>');
}
const evidenceDir = resolve(process.argv[evidenceFlag + 1]);
mkdirSync(evidenceDir, { recursive: true });
const vitestEntrypoint = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestEntrypoint)) {
  throw new Error(`repo-local Vitest entrypoint is absent: ${vitestEntrypoint}`);
}

const mutations = [
  {
    id: 'P1a',
    file: 'packages/contracts/src/profile.ts',
    before: "  read_only: {\n    profileId: 'read_only',\n    profileVersion: PROFILE_VERSION,\n    allowedNamespaces: ['*'],\n    allowedCapabilities: ['read'],",
    after: "  read_only: {\n    profileId: 'read_only',\n    profileVersion: PROFILE_VERSION,\n    allowedNamespaces: ['*'],\n    allowedCapabilities: ['read', 'write'],",
    testFile: 'tests/profile-conformance-declared.test.ts',
    testName: 'AC-1 exact manifest',
    redNeedle: 'all fields of all four definitions',
  },
  {
    id: 'P1b',
    file: 'docs/security/profile-conformance.md',
    before: '| read_only | * | read | none | LOCAL_EDGE |',
    after: '| read_only | * | read, write | none | LOCAL_EDGE |',
    testFile: 'tests/profile-conformance-declared.test.ts',
    testName: 'AC-1 documentation',
    redNeedle: 'marker-delimited GFM table',
  },
  {
    id: 'P2-namespace',
    file: 'packages/contracts/src/profile.ts',
    before: "  workspace_write: {\n    profileId: 'workspace_write',\n    profileVersion: PROFILE_VERSION,\n    allowedNamespaces: ['filesystem'],",
    after: "  workspace_write: {\n    profileId: 'workspace_write',\n    profileVersion: PROFILE_VERSION,\n    allowedNamespaces: ['filesystem', 'shell'],",
    testFile: 'tests/profile-conformance-runtime.test.ts',
    testName: 'P2 namespace conjunct',
    redNeedle: 'all built-ins match an immutable',
  },
  {
    id: 'P2-capability',
    file: 'packages/contracts/src/profile.ts',
    before: "    allowedCapabilities: ['read', 'write'],\n    allowedSideEffects: ['none', 'filesystem_write'],",
    after: "    allowedCapabilities: ['read'],\n    allowedSideEffects: ['none', 'filesystem_write'],",
    testFile: 'tests/profile-conformance-runtime.test.ts',
    testName: 'P2 capability conjunct',
    redNeedle: 'namespace match cannot bypass',
  },
  {
    id: 'P2-side-effect',
    file: 'packages/contracts/src/profile.ts',
    before: "    allowedCapabilities: ['read', 'write'],\n    allowedSideEffects: ['none', 'filesystem_write'],",
    after: "    allowedCapabilities: ['read', 'write'],\n    allowedSideEffects: ['none'],",
    testFile: 'tests/profile-conformance-runtime.test.ts',
    testName: 'P2 side-effect conjunct',
    redNeedle: 'matching namespace and capability',
  },
  {
    id: 'P3a',
    file: 'packages/bridge/src/capability.ts',
    before: "  if (tokens.some((t) => P4_SEND.has(t))) return 'send';",
    after: "  if (tokens.some((t) => P4_SEND.has(t))) return 'exec';",
    testFile: 'tests/profile-conformance-declared.test.ts',
    testName: 'P3a real classifier label',
    redNeedle: 'send is reachable',
  },
  {
    id: 'P3b',
    file: 'packages/contracts/src/profile.ts',
    before: "export const TOOL_REGISTRY_VERSION = 'torqclaw.tools/v1' as const;",
    after: "export const TOOL_REGISTRY_VERSION = 'torqclaw.tools/v2' as const;",
    testFile: 'tests/profile-conformance-c2.test.ts',
    testName: 'AC-C2-0 fixed checked-in',
    redNeedle: 'fixed checked-in UTF-8 preimage',
  },
  {
    id: 'P4',
    file: 'packages/inference/src/ollama.ts',
    before: '        const toolResult = await executeTool(realName, toolArgs, req.effectiveProfile);',
    after: '        const toolResult = await executeTool(realName, toolArgs);',
    testFile: 'tests/profile-conformance-caller-audit.test.ts',
    testName: 'inventories every resolved executeTool caller',
    redNeedle: 'proves effectiveProfile forwarding',
  },
];

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function occurrences(text, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ...result,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function createReceipt(name, content) {
  writeFileSync(resolve(evidenceDir, name), content, { encoding: 'utf8', flag: 'wx' });
}

const summaryPath = resolve(evidenceDir, 'mutation-summary.jsonl');
for (const mutation of mutations) {
  const absolute = resolve(root, mutation.file);
  const original = readFileSync(absolute, 'utf8');
  const originalSha = sha256(original);
  if (occurrences(original, mutation.before) !== 1) {
    throw new Error(`${mutation.id}: exact preimage must occur once`);
  }
  if (occurrences(original, mutation.after) !== 0) {
    throw new Error(`${mutation.id}: replacement unexpectedly exists before mutation`);
  }
  let restored = false;
  try {
    const mutated = original.replace(mutation.before, mutation.after);
    if (occurrences(mutated, mutation.before) !== 0 || occurrences(mutated, mutation.after) !== 1) {
      throw new Error(`${mutation.id}: replacement cardinality is not exact`);
    }
    writeFileSync(absolute, mutated, 'utf8');
    const diff = run('git', ['diff', '--', mutation.file]);
    createReceipt(`${mutation.id}.diff`, `${diff.stdout}${diff.stderr}`);

    const test = run(process.execPath, [
      vitestEntrypoint,
      'run',
      mutation.testFile,
      '-t',
      mutation.testName,
    ]);
    const output = `${test.stdout}${test.stderr}`;
    createReceipt(`${mutation.id}.test.log`, output);
    createReceipt(`${mutation.id}.test.exit.txt`, `EXIT_CODE=${test.status}\n`);
    const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
    if (test.error || test.signal || test.status === null) {
      throw new Error(`${mutation.id}: Vitest spawn failed (${test.error ?? test.signal ?? 'null status'})`);
    }
    if (
      test.status === 0
      || !plain.includes('Failed Tests')
      || !plain.includes(mutation.testName)
      || !plain.includes(mutation.redNeedle)
    ) {
      throw new Error(`${mutation.id}: targeted test did not prove the relevant assertion RED (exit ${test.status})`);
    }
  } finally {
    const current = readFileSync(absolute, 'utf8');
    if (occurrences(current, mutation.after) !== 1 || occurrences(current, mutation.before) !== 0) {
      throw new Error(`${mutation.id}: restore precondition failed; retained dirty state for inspection`);
    }
    const restoredText = current.replace(mutation.after, mutation.before);
    writeFileSync(absolute, restoredText, 'utf8');
    if (sha256(readFileSync(absolute, 'utf8')) !== originalSha) {
      throw new Error(`${mutation.id}: reverse replacement did not restore the original SHA-256`);
    }
    restored = true;
  }

  const diffCheck = run('git', ['diff', '--exit-code']);
  const statusCheck = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!restored || diffCheck.status !== 0 || statusCheck.status !== 0 || statusCheck.stdout.trim() !== '') {
    throw new Error(`${mutation.id}: worktree not clean after reverse replacement`);
  }
  appendFileSync(summaryPath, `${JSON.stringify({
    id: mutation.id,
    file: mutation.file,
    originalSha256: originalSha,
    relevantAssertionRed: true,
    restoredSha256: originalSha,
    clean: true,
  })}\n`, { encoding: 'utf8', flag: 'a' });
}

console.log(`profile-conformance mutants: ${mutations.length}/${mutations.length} relevant RED, restored clean`);
