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
    file: 'packages/contracts/src/profile.ts',
    before: "    allowedCapabilities: ['read'],\n    allowedSideEffects: ['none'],\n    allowedTiers: ['LOCAL_EDGE'],",
    after: "    allowedCapabilities: ['read', 'write'],\n    allowedSideEffects: ['none', 'process'],\n    allowedTiers: ['LOCAL_EDGE'],",
    testFile: 'tests/profile-conformance-runtime.test.ts',
    testName: 'P1b',
    redNeedles: [
      'P1b control-plane exposure denies shell write under read_only',
      'P1b direct-execution denies shell write before client lookup',
    ],
    mutant: 'P1b',
  },
  {
    id: 'P2-namespace',
    file: 'packages/bridge/src/profilePolicy.ts',
    before: "  return namespaces.includes('*') || namespaces.includes(namespace);",
    after: "  return namespaces.includes('*') || namespaces.includes(namespace) || namespace === 'unreviewed';",
    testFile: 'tests/profile-conformance-runtime.test.ts',
    testName: 'P2 namespace conjunct',
    redNeedle: 'terminal_power denies an unreviewed write/process tool',
    mutant: 'P2-namespace',
  },
  {
    id: 'P2-capability',
    file: 'packages/bridge/src/profilePolicy.ts',
    before: "        definition.allowedCapabilities.includes(tool.capability as CapabilityClass) &&",
    after: "        true && // MUTANT: capability conjunct removed",
    testFile: 'tests/profile-conformance-runtime.test.ts',
    testName: 'P2 capability conjunct',
    redNeedle: 'read_only denies filesystem write when every other conjunct is admitted',
    mutant: 'P2-capability',
  },
  {
    id: 'P2-side-effect',
    file: 'packages/bridge/src/profilePolicy.ts',
    before: "        definition.allowedSideEffects.includes(sideEffectFor(tool)),",
    after: "        true, // MUTANT: side-effect conjunct removed",
    testFile: 'tests/profile-conformance-runtime.test.ts',
    testName: 'P2 side-effect conjunct',
    redNeedle: 'workspace_write exposure changes only when filesystem effect is removed',
    mutant: 'P2-side-effect',
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
    file: 'packages/bridge/src/profilePolicy.ts',
    before: "  return createHash('sha256').update(canonicalizePolicy(material)).digest('hex');",
    after: "  return createHash('sha256').update('PROFILE_POLICY_V2\\0').update(canonicalizePolicy(material)).digest('hex');",
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
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
    ], {
      env: mutation.mutant
        ? { ...process.env, TORQ_PROFILE_CONFORMANCE_MUTANT: mutation.mutant }
        : { ...process.env },
    });
    const output = `${test.stdout}${test.stderr}`;
    createReceipt(`${mutation.id}.test.log`, output);
    createReceipt(`${mutation.id}.test.exit.txt`, `EXIT_CODE=${test.status}\n`);
    const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
    if (test.error || test.signal || test.status === null) {
      throw new Error(`${mutation.id}: Vitest spawn failed (${test.error ?? test.signal ?? 'null status'})`);
    }
    const redNeedles = mutation.redNeedles ?? [mutation.redNeedle];
    if (
      test.status === 0
      || !plain.includes('Failed Tests')
      || !plain.includes(mutation.testName)
      || redNeedles.some((needle) => !plain.includes(needle))
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
