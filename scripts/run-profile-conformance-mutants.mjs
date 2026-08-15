import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const evidenceFlag = process.argv.indexOf('--evidence-dir');
const expectedHeadFlag = process.argv.indexOf('--expected-head');
if (evidenceFlag < 0 || !process.argv[evidenceFlag + 1]) {
  throw new Error('missing --evidence-dir <new-external-directory>');
}
if (expectedHeadFlag < 0 || !/^[0-9a-f]{40}$/.test(process.argv[expectedHeadFlag + 1] ?? '')) {
  throw new Error('missing --expected-head <40-hex-C4-object>');
}
const evidenceDir = resolve(process.argv[evidenceFlag + 1]);
const expectedHead = process.argv[expectedHeadFlag + 1];
if (existsSync(evidenceDir)) {
  throw new Error(`evidence directory must be new: ${evidenceDir}`);
}
mkdirSync(evidenceDir);
const vitestEntrypoint = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestEntrypoint)) {
  throw new Error(`repo-local Vitest entrypoint is absent: ${vitestEntrypoint}`);
}

const C3_PARENT = 'fec1f0d4eb7121108ed0c2314157b495cf98cf32';
const EXPECTED_C4_PATHS = [
  'scripts/run-profile-conformance-mutants.mjs',
  'tests/profile-conformance-runtime.test.ts',
];

const mutations = [
  {
    id: 'P1a',
    file: 'packages/contracts/src/profile.ts',
    before: "  read_only: {\n    profileId: 'read_only',\n    profileVersion: PROFILE_VERSION,\n    allowedNamespaces: ['*'],\n    allowedCapabilities: ['read'],",
    after: "  read_only: {\n    profileId: 'read_only',\n    profileVersion: PROFILE_VERSION,\n    allowedNamespaces: ['*'],\n    allowedCapabilities: ['read', 'write'],",
    testFile: 'tests/profile-conformance-declared.test.ts',
    testName: 'AC-1 exact manifest',
    redNeedle: 'all fields of all four definitions',
    selectors: [{
      id: 'manifest',
      fullName: 'AC-1 declared profile manifest > AC-1 exact manifest: all fields of all four definitions equal the pinned golden',
      matcherNeedles: ['AssertionError: expected', 'allowedCapabilities'],
      location: 'tests/profile-conformance-declared.test.ts:22:',
    }],
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
    selectors: [
      {
        id: 'control-plane',
        fullName: 'P1b control-plane and direct-execution exposure > P1b control-plane exposure denies shell write under read_only',
        matcherNeedles: ['P1B_CONTROL_DENIAL: read_only control plane must exclude shell__write'],
        location: 'tests/profile-conformance-runtime.test.ts:353:',
      },
      {
        id: 'direct-execution',
        fullName: 'P1b control-plane and direct-execution exposure > P1b direct-execution denies shell write before client lookup',
        matcherNeedles: [
          'P1B_DIRECT_DENIAL: read_only execution must stop before shell client lookup',
          "No MCP client connected for server 'shell'",
        ],
        location: 'tests/profile-conformance-runtime.test.ts:379:',
      },
    ],
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
    selectors: [{
      id: 'namespace',
      fullName: 'mutation-only conjunct isolation > P2 namespace conjunct: terminal_power denies an unreviewed write/process tool',
      matcherNeedles: ['P2_NAMESPACE_DENIAL: terminal_power must exclude unreviewed__write'],
      location: 'tests/profile-conformance-runtime.test.ts:296:',
    }],
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
    setup: {
      file: 'packages/contracts/src/profile.ts',
      before: "    allowedCapabilities: ['read'],\n    allowedSideEffects: ['none'],\n    allowedTiers: ['LOCAL_EDGE'],",
      after: "    allowedCapabilities: ['read'],\n    allowedSideEffects: ['none', 'filesystem_write'],\n    allowedTiers: ['LOCAL_EDGE'],",
    },
    selectors: [{
      id: 'capability',
      fullName: 'mutation-only conjunct isolation > P2 capability conjunct: read_only denies filesystem write when every other conjunct is admitted',
      matcherNeedles: ['P2_CAPABILITY_DENIAL: read_only capability gate must exclude filesystem__write_file'],
      location: 'tests/profile-conformance-runtime.test.ts:315:',
    }],
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
    setup: {
      file: 'packages/contracts/src/profile.ts',
      before: "    allowedCapabilities: ['read', 'write'],\n    allowedSideEffects: ['none', 'filesystem_write'],\n    allowedTiers: ['LOCAL_EDGE', 'FRONTIER'],",
      after: "    allowedCapabilities: ['read', 'write'],\n    allowedSideEffects: ['none'],\n    allowedTiers: ['LOCAL_EDGE', 'FRONTIER'],",
    },
    selectors: [{
      id: 'side-effect',
      fullName: 'mutation-only conjunct isolation > P2 side-effect conjunct: workspace_write denies filesystem write when only its effect is disallowed',
      matcherNeedles: ['P2_SIDE_EFFECT_DENIAL: workspace_write effect gate must exclude filesystem__write_file'],
      location: 'tests/profile-conformance-runtime.test.ts:340:',
    }],
  },
  {
    id: 'P3a',
    file: 'packages/bridge/src/capability.ts',
    before: "  if (tokens.some((t) => P4_SEND.has(t))) return 'send';",
    after: "  if (tokens.some((t) => P4_SEND.has(t))) return 'exec';",
    testFile: 'tests/profile-conformance-declared.test.ts',
    testName: 'P3a real classifier label',
    redNeedle: 'send is reachable',
    selectors: [{
      id: 'classifier-label',
      fullName: 'AC-2 executable classifier inventory > P3a real classifier label: send is reachable but no built-in declares send admission',
      matcherNeedles: ["expected 'exec' to be 'send'"],
      location: 'tests/profile-conformance-declared.test.ts:70:',
    }],
  },
  {
    id: 'P3b',
    file: 'packages/bridge/src/profilePolicy.ts',
    before: "  return createHash('sha256').update(canonicalizePolicy(material)).digest('hex');",
    after: "  return createHash('sha256').update('PROFILE_POLICY_V2\\0').update(canonicalizePolicy(material)).digest('hex');",
    testFile: 'tests/profile-conformance-c2.test.ts',
    testName: 'AC-C2-0 fixed checked-in',
    redNeedle: 'fixed checked-in UTF-8 preimage',
    selectors: [{
      id: 'hasher-label',
      fullName: 'AC-C2 canonical policy/hash vectors > AC-C2-0 fixed checked-in UTF-8 preimage and SHA reproduce from live modules',
      matcherNeedles: ['AssertionError: expected', '3ef1dd5f3fdec47f77830e64d1e2eb2da624a434824b0fb3c5645af2996e67a5'],
      location: 'tests/profile-conformance-c2.test.ts:57:',
    }],
  },
  {
    id: 'P4',
    file: 'packages/inference/src/ollama.ts',
    before: '        const toolResult = await executeTool(realName, toolArgs, req.effectiveProfile);',
    after: '        const toolResult = await executeTool(realName, toolArgs);',
    testFile: 'tests/profile-conformance-caller-audit.test.ts',
    testName: 'inventories every resolved executeTool caller',
    redNeedle: 'proves effectiveProfile forwarding',
    selectors: [{
      id: 'caller-forwarding',
      fullName: 'AC-10A TypeScript compiler-API production caller audit > inventories every resolved executeTool caller and proves effectiveProfile forwarding',
      matcherNeedles: ['AssertionError: expected', 'req.effectiveProfile'],
      location: 'tests/profile-conformance-caller-audit.test.ts:19:',
    }],
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

function normalizedPath(path) {
  return path.replaceAll('\\', '/');
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function plainOutput(result) {
  return `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
}

function assertProcessCompleted(result, label) {
  if (result.error || result.signal || result.status === null) {
    throw new Error(`${label}: process failed (${result.error ?? result.signal ?? 'null status'})`);
  }
}

const INFRASTRUCTURE_RED = [
  'Failed Suites',
  'No test files found',
  'Cannot find module',
  'ERR_MODULE_NOT_FOUND',
  'Failed to load',
  'Hook timed out',
  'Test timed out',
  'Unhandled Error',
  'Unhandled Rejection',
  'SyntaxError:',
  'ReferenceError:',
  'TypeError:',
];

function runSelector(mutation, selector, phase) {
  const result = run(process.execPath, [
    vitestEntrypoint,
    'run',
    mutation.testFile,
    '--reporter=verbose',
    '-t',
    `^${regexEscape(selector.fullName.replaceAll(' > ', ' '))}$`,
  ], {
    env: mutation.mutant
      ? { ...process.env, TORQ_PROFILE_CONFORMANCE_MUTANT: mutation.mutant }
      : { ...process.env, TORQ_PROFILE_CONFORMANCE_MUTANT: '' },
  });
  const stem = `${mutation.id}.${selector.id}.${phase}`;
  createReceipt(`${stem}.log`, `${result.stdout}${result.stderr}`);
  createReceipt(`${stem}.exit.txt`, `EXIT_CODE=${result.status}\nSIGNAL=${result.signal ?? ''}\nERROR=${result.error ?? ''}\n`);
  assertProcessCompleted(result, stem);
  return { result, plain: plainOutput(result) };
}

function requireGreen(mutation, selector, phase) {
  const { result, plain } = runSelector(mutation, selector, phase);
  if (
    result.status !== 0
    || !plain.includes(selector.fullName)
    || !/Tests\s+1 passed/.test(plain)
    || plain.includes('Failed Tests')
    || INFRASTRUCTURE_RED.some((needle) => plain.includes(needle))
  ) {
    throw new Error(`${mutation.id}/${selector.id}: ${phase} was not the exact one-test GREEN control`);
  }
}

function requireRelevantRed(mutation, selector) {
  const { result, plain } = runSelector(mutation, selector, 'red');
  if (
    result.status !== 1
    || !plain.includes(`${mutation.testFile} > ${selector.fullName}`)
    || !/Failed Tests 1/.test(plain)
    || !/Tests\s+1 failed/.test(plain)
    || selector.matcherNeedles.some((needle) => !plain.includes(needle))
    || !plain.includes(selector.location)
    || INFRASTRUCTURE_RED.some((needle) => plain.includes(needle))
  ) {
    throw new Error(`${mutation.id}/${selector.id}: RED was not the exact named assertion failure`);
  }
}

function requireClean(label) {
  const working = run('git', ['diff', '--exit-code']);
  const staged = run('git', ['diff', '--cached', '--exit-code']);
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  if (
    working.status !== 0
    || staged.status !== 0
    || status.status !== 0
    || status.stdout !== ''
  ) {
    throw new Error(`${label}: working tree, index, or porcelain is not clean`);
  }
}

function declaredStages(mutation) {
  const stages = [];
  if (mutation.setup) stages.push({ id: 'setup', ...mutation.setup });
  stages.push({
    id: 'target',
    file: mutation.file,
    before: mutation.before,
    after: mutation.after,
  });
  return stages;
}

function countDiffHunks(diff) {
  return (diff.match(/^@@/gm) ?? []).length;
}

function assertAppliedDiff(mutation, stages, phase) {
  const files = [...new Set(stages.map((stage) => stage.file))].sort();
  const names = run('git', ['diff', '--name-only']);
  assertProcessCompleted(names, `${mutation.id}/${phase}/diff-names`);
  const actual = names.stdout.trim().split(/\r?\n/).filter(Boolean).map(normalizedPath).sort();
  if (JSON.stringify(actual) !== JSON.stringify(files)) {
    throw new Error(`${mutation.id}/${phase}: diff files ${JSON.stringify(actual)} do not equal ${JSON.stringify(files)}`);
  }
  for (const file of files) {
    const diff = run('git', ['diff', '--unified=0', '--', file]);
    assertProcessCompleted(diff, `${mutation.id}/${phase}/${file}`);
    createReceipt(`${mutation.id}.${phase}.${file.replaceAll('/', '_')}.diff`, `${diff.stdout}${diff.stderr}`);
    if (countDiffHunks(diff.stdout) !== 1) {
      throw new Error(`${mutation.id}/${phase}: ${file} must have exactly one diff hunk`);
    }
  }
}

const head = run('git', ['rev-parse', 'HEAD']);
const parents = run('git', ['rev-list', '--parents', '-n', '1', 'HEAD']);
const detached = run('git', ['symbolic-ref', '-q', 'HEAD']);
assertProcessCompleted(head, 'preflight HEAD');
assertProcessCompleted(parents, 'preflight parents');
if (head.stdout.trim() !== expectedHead) throw new Error(`HEAD ${head.stdout.trim()} is not expected C4 ${expectedHead}`);
if (detached.status !== 1) throw new Error('runner requires detached HEAD');
if (parents.stdout.trim() !== `${expectedHead} ${C3_PARENT}`) throw new Error('C4 must have exactly C3 as its single parent');
requireClean('preflight');

const c4Paths = run('git', ['diff', '--name-only', C3_PARENT, expectedHead]);
assertProcessCompleted(c4Paths, 'C3..C4 path inventory');
const actualC4Paths = c4Paths.stdout.trim().split(/\r?\n/).filter(Boolean).map(normalizedPath).sort();
if (JSON.stringify(actualC4Paths) !== JSON.stringify([...EXPECTED_C4_PATHS].sort())) {
  throw new Error(`C3..C4 paths are ${JSON.stringify(actualC4Paths)}`);
}
createReceipt('runner-preflight.json', `${JSON.stringify({
  head: expectedHead,
  parent: C3_PARENT,
  detached: true,
  clean: true,
  c4Paths: actualC4Paths,
}, null, 2)}\n`);

const allMutationFiles = [...new Set(mutations.flatMap((mutation) => declaredStages(mutation).map((stage) => stage.file)))];
const headBuffers = new Map();
for (const file of allMutationFiles) {
  const disk = readFileSync(resolve(root, file));
  const committed = run('git', ['show', `${expectedHead}:${file}`], { encoding: null });
  if (committed.error || committed.signal || committed.status !== 0 || !Buffer.isBuffer(committed.stdout)) {
    throw new Error(`${file}: cannot read exact committed bytes`);
  }
  if (!disk.equals(committed.stdout)) throw new Error(`${file}: disk bytes differ from C4 HEAD`);
  headBuffers.set(file, Buffer.from(disk));
}

const summaryPath = resolve(evidenceDir, 'mutation-summary.jsonl');
for (const mutation of mutations) {
  requireClean(`${mutation.id}/before`);
  const stages = declaredStages(mutation);
  const originals = new Map(stages.map((stage) => [stage.file, Buffer.from(headBuffers.get(stage.file))]));
  const originalShas = Object.fromEntries([...originals].map(([file, buffer]) => [file, sha256(buffer)]));
  for (const stage of stages) {
    const original = originals.get(stage.file).toString('utf8');
    if (occurrences(original, stage.before) !== 1) throw new Error(`${mutation.id}/${stage.id}: preimage cardinality is not one`);
    if (occurrences(original, stage.after) !== 0) throw new Error(`${mutation.id}/${stage.id}: replacement already exists`);
  }

  let primaryError;
  const applied = [];
  try {
    for (const selector of mutation.selectors) requireGreen(mutation, selector, 'precontrol');

    for (const stage of stages) {
      const absolute = resolve(root, stage.file);
      const current = readFileSync(absolute, 'utf8');
      if (occurrences(current, stage.before) !== 1 || occurrences(current, stage.after) !== 0) {
        throw new Error(`${mutation.id}/${stage.id}: live cardinality changed before application`);
      }
      const changed = current.replace(stage.before, stage.after);
      writeFileSync(absolute, changed, 'utf8');
      applied.push(stage);
      if (occurrences(readFileSync(absolute, 'utf8'), stage.after) !== 1) {
        throw new Error(`${mutation.id}/${stage.id}: replacement cardinality is not one`);
      }
      assertAppliedDiff(mutation, applied, stage.id);
      if (stage.id === 'setup') {
        for (const selector of mutation.selectors) requireGreen(mutation, selector, 'setup-control');
      }
    }

    for (const selector of mutation.selectors) requireRelevantRed(mutation, selector);
  } catch (error) {
    primaryError = error;
  }

  const restorationErrors = [];
  for (const [file, buffer] of originals) {
    try {
      writeFileSync(resolve(root, file), buffer);
      if (sha256(readFileSync(resolve(root, file))) !== originalShas[file]) {
        restorationErrors.push(`${file}: restored SHA-256 mismatch`);
      }
    } catch (error) {
      restorationErrors.push(`${file}: ${String(error)}`);
    }
  }
  try {
    requireClean(`${mutation.id}/restored`);
  } catch (error) {
    restorationErrors.push(String(error));
  }
  for (const selector of mutation.selectors) {
    try {
      requireGreen(mutation, selector, 'postcontrol');
    } catch (error) {
      restorationErrors.push(String(error));
    }
  }

  if (primaryError || restorationErrors.length > 0) {
    throw new Error(`${mutation.id}: ${String(primaryError ?? 'mutation failed')} restoration=${restorationErrors.join(' | ')}`);
  }

  appendFileSync(summaryPath, `${JSON.stringify({
    id: mutation.id,
    files: [...originals.keys()],
    originalSha256: originalShas,
    selectors: mutation.selectors.map((selector) => selector.fullName),
    relevantAssertionRed: true,
    restoredSha256: originalShas,
    clean: true,
    precontrolGreen: true,
    setupControlGreen: Boolean(mutation.setup),
    postcontrolGreen: true,
  })}\n`, { encoding: 'utf8', flag: 'a' });
}

requireClean('final');
console.log(`profile-conformance mutants: ${mutations.length}/${mutations.length} relevant RED, restored clean`);
