/**
 * Drift gate: re-emits the 4 JSON Schema artifacts into a scratch temp dir
 * and diffs them against the checked-in copies in BOTH
 * packages/contracts/generated/ and engines/hermes_kernel/mcp_wrapper/schemas/.
 *
 * Comparison strategy: JSON.parse both sides and deep-compare the resulting
 * values (parsed-JSON equality), NOT a byte/string comparison. This is
 * deliberate — this repo runs with git core.autocrlf=true on Windows, so a
 * checked-in file can come back from `git checkout` with CRLF line endings
 * even though a freshly emitted file always has LF (see .gitattributes,
 * which pins these paths to `eol=lf` to keep that from happening — but the
 * check must stay correct even if that policy is ever violated, and it must
 * behave identically on Linux CI). Parsing both sides sidesteps line-ending,
 * whitespace, and key-order differences entirely and only fails on an actual
 * semantic difference in the schema.
 */
import { z } from 'zod';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GatewayRequestSchema,
  GatewayEventSchema,
  ClientCommandSchema,
  ConnectFrameSchema,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

const EXPECTED_FILES = [
  'GatewayRequest.json',
  'GatewayEvent.json',
  'ClientCommand.json',
  'ConnectFrame.json',
].sort();

const artifacts: Record<string, z.ZodType> = {
  GatewayRequest: GatewayRequestSchema,
  GatewayEvent: GatewayEventSchema,
  ClientCommand: ClientCommandSchema,
  ConnectFrame: ConnectFrameSchema,
};

const checkedInDirs = [
  join(here, '..', 'generated'),
  join(here, '..', '..', '..', 'engines', 'hermes_kernel', 'mcp_wrapper', 'schemas'),
];

/** Small recursive deep-equal over plain JSON values (object/array/primitive). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false; // primitives already handled by ===

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  for (const key of aKeys) {
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/** Finds the first JSON-path at which two parsed values diverge, for a
 *  useful failure message. Returns null if they're equal. */
function firstDiffPath(a: unknown, b: unknown, path = '$'): string | null {
  if (deepEqual(a, b)) return null;

  if (
    typeof a === 'object' && a !== null &&
    typeof b === 'object' && b !== null &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        if (!deepEqual(a[i], b[i])) {
          const childPath = `${path}[${i}]`;
          if (i >= a.length) return `${childPath} (missing in re-emitted)`;
          if (i >= b.length) return `${childPath} (missing in checked-in)`;
          return firstDiffPath(a[i], b[i], childPath) ?? childPath;
        }
      }
    } else {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;
      const keys = Array.from(new Set([...Object.keys(aObj), ...Object.keys(bObj)])).sort();
      for (const key of keys) {
        if (!(key in aObj)) return `${path}.${key} (missing in re-emitted)`;
        if (!(key in bObj)) return `${path}.${key} (missing in checked-in)`;
        if (!deepEqual(aObj[key], bObj[key])) {
          const childPath = `${path}.${key}`;
          return firstDiffPath(aObj[key], bObj[key], childPath) ?? childPath;
        }
      }
    }
  }

  return path;
}

function main(): void {
  const scratch = mkdtempSync(join(tmpdir(), 'torqclaw-contracts-check-'));
  let failed = false;
  const failures: string[] = [];

  try {
    // Re-emit all 4 artifacts fresh into the scratch dir.
    for (const [name, schema] of Object.entries(artifacts)) {
      writeFileSync(join(scratch, `${name}.json`), JSON.stringify(z.toJSONSchema(schema), null, 2));
    }

    for (const dir of checkedInDirs) {
      // (a) file-set assertion: exactly the 4 expected names, no more, no less.
      let actualFiles: string[];
      try {
        actualFiles = readdirSync(dir).filter((f: string) => f.endsWith('.json')).sort();
      } catch {
        failed = true;
        failures.push(`${dir}: directory missing or unreadable`);
        continue;
      }

      const expectedSet = new Set(EXPECTED_FILES);
      const actualSet = new Set(actualFiles);

      const missing = EXPECTED_FILES.filter((f) => !actualSet.has(f));
      const extra = actualFiles.filter((f: string) => !expectedSet.has(f));

      if (missing.length > 0) {
        failed = true;
        failures.push(`${dir}: missing file(s): ${missing.join(', ')}`);
      }
      if (extra.length > 0) {
        failed = true;
        failures.push(`${dir}: unexpected extra file(s): ${extra.join(', ')}`);
      }

      // (b) content assertion: parsed-JSON equality against the fresh re-emit.
      for (const file of EXPECTED_FILES) {
        if (!actualSet.has(file)) continue; // already reported as missing above
        const checkedInPath = join(dir, file);
        const scratchPath = join(scratch, file);

        let checkedInParsed: unknown;
        let scratchParsed: unknown;
        try {
          checkedInParsed = JSON.parse(readFileSync(checkedInPath, 'utf8'));
        } catch (err) {
          failed = true;
          failures.push(`${dir}/${file}: failed to parse checked-in JSON (${(err as Error).message})`);
          continue;
        }
        try {
          scratchParsed = JSON.parse(readFileSync(scratchPath, 'utf8'));
        } catch (err) {
          failed = true;
          failures.push(`${dir}/${file}: failed to parse freshly-emitted JSON (${(err as Error).message})`);
          continue;
        }

        const diffPath = firstDiffPath(scratchParsed, checkedInParsed);
        if (diffPath !== null) {
          failed = true;
          failures.push(`${dir}/${file}: drifted from source of truth at ${diffPath}`);
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failed) {
    console.error('[contracts:check] DRIFT DETECTED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `[contracts:check] OK — ${EXPECTED_FILES.length} schemas match source of truth in ${checkedInDirs.length} checked-in dirs.`,
  );
  process.exit(0);
}

main();
