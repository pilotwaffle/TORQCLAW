import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type SourceSet = {
  storage: string;
  marker: string;
  contracts: string;
  wire: string;
  server: string;
  authz: string;
  guidance: string;
};

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const baseline: SourceSet = {
  storage: read('packages/gateway/src/storage.ts'),
  marker: read('packages/gateway/src/authRuntimeMarker.ts'),
  contracts: read('packages/gateway/src/v2Contracts.ts'),
  wire: read('packages/gateway/src/strictWire.ts'),
  server: read('packages/gateway/src/server.ts'),
  authz: read('packages/gateway/src/authz.ts'),
  guidance: read('packages/gateway/src/skillDecision.ts'),
};

type Mutant = {
  name: string;
  mutate: (source: SourceSet) => SourceSet;
  assertion: (source: SourceSet) => void;
};

const clone = (source: SourceSet): SourceSet => ({ ...source });
const replaceOnce = (value: string, from: string, to: string): string => {
  if (from === to) throw new Error(`named mutant mutation is a no-op: ${from}`);
  const index = value.indexOf(from);
  if (index < 0) throw new Error(`mutation anchor missing: ${from}`);
  return value.slice(0, index) + to + value.slice(index + from.length);
};

const mutants: Mutant[] = [
  {
    name: 'fence-after-write',
    mutate: (source) => {
      const result = clone(source);
      result.storage = replaceOnce(
        result.storage,
        'assertV1CompatibleState(opened);',
        "opened.pragma('journal_mode = WAL');\n    assertV1CompatibleState(opened);",
      );
      return result;
    },
    assertion: (source) => {
      const reader = source.storage.indexOf('assertV1CompatibleState(opened);');
      const migration = source.storage.indexOf('runAuthFoundationMigration(opened);');
      const pragma = source.storage.indexOf("opened.pragma('journal_mode = WAL');");
      expect(reader).toBeGreaterThanOrEqual(0);
      expect(reader).toBeLessThan(migration);
      expect(migration).toBeLessThan(pragma);
    },
  },
  {
    name: 'skip-post-begin-recheck',
    mutate: (source) => {
      const result = clone(source);
      result.marker = replaceOnce(result.marker, 'const current = validateState(db, []);', "const current = { state: 'legacy' as const };");
      return result;
    },
    assertion: (source) => {
      const begin = source.marker.indexOf("db.exec('BEGIN IMMEDIATE');");
      const recheck = source.marker.indexOf('const current = validateState(db, []);');
      const ddl = source.marker.indexOf('const [ledgerDdl, markerDdl]');
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(recheck).toBeGreaterThan(begin);
      expect(recheck).toBeLessThan(ddl);
    },
  },
  {
    name: 'case-sensitive-collision',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'asciiFold(row.name)', 'row.name') }),
    assertion: (source) => expect(source.marker).toContain('asciiFold(row.name)'),
  },
  {
    name: 'table-only-collision',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'return foldedName === folded || foldedTable === folded;', 'return foldedTable === folded;') }),
    assertion: (source) => expect(source.marker).toContain('return foldedName === folded || foldedTable === folded;'),
  },
  {
    name: 'name-only-collision',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'foldedName === folded || foldedTable === folded', 'foldedName === folded') }),
    assertion: (source) => expect(source.marker).toContain('foldedName === folded || foldedTable === folded'),
  },
  {
    name: 'omit-temp-scan',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'if (inventory.temp.length !== 0) fail(AUTH_RUNTIME_MARKER_TEMP_SHADOW);', 'if (false) fail();') }),
    assertion: (source) => expect(source.marker).toContain('if (inventory.temp.length !== 0) fail(AUTH_RUNTIME_MARKER_TEMP_SHADOW);'),
  },
  {
    name: 'omit-database-list',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'const attached = databaseList(db);', "const attached = [{ seq: 0, name: 'main', file: '' }];") }),
    assertion: (source) => expect(source.marker).toContain('const attached = databaseList(db);'),
  },
  {
    name: 'omit-attachment-check',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, "attached.slice(1).some((entry) => entry.name !== 'temp' || entry.file !== '')", 'false') }),
    assertion: (source) => expect(source.marker).toContain("entry.name !== 'temp' || entry.file !== ''"),
  },
  {
    name: 'unqualified-catalog',
    mutate: (source) => ({ ...source, marker: source.marker.replaceAll('main.sqlite_schema', 'sqlite_schema') }),
    assertion: (source) => expect(source.marker).toContain('main.sqlite_schema'),
  },
  {
    name: 'unqualified-pragma',
    mutate: (source) => ({ ...source, marker: source.marker.replaceAll('PRAGMA main.', 'PRAGMA ') }),
    assertion: (source) => expect(source.marker).toContain('PRAGMA main.'),
  },
  {
    name: 'unqualified-marker-select',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'FROM main.auth_runtime_state', 'FROM auth_runtime_state') }),
    assertion: (source) => expect(source.marker).toContain('FROM main.auth_runtime_state'),
  },
  {
    name: 'weaken-collision-cardinality',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'collisions.length !== 3', 'collisions.length < 3') }),
    assertion: (source) => expect(source.marker).toContain('collisions.length !== 3'),
  },
  {
    name: 'weaken-catalog-byte-equality',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'rows[0]!.sql !== expectedTableSql(name)', 'false') }),
    assertion: (source) => expect(source.marker).toContain('rows[0]!.sql !== expectedTableSql(name)'),
  },
  {
    name: 'weaken-autoindex',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'indexes.length !== 1', 'indexes.length < 1') }),
    assertion: (source) => expect(source.marker).toContain('indexes.length !== 1'),
  },
  {
    name: 'weaken-autoindex-sql-null',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, "row.name === 'sqlite_autoindex_gateway_schema_migrations_1' && row.sql !== null", 'false') }),
    assertion: (source) => expect(source.marker).toContain("row.name === 'sqlite_autoindex_gateway_schema_migrations_1' && row.sql !== null"),
  },
  {
    name: 'weaken-index-list',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'indexes[0]?.name !== indexName', 'false') }),
    assertion: (source) => expect(source.marker).toContain('indexes[0]?.name !== indexName'),
  },
  {
    name: 'weaken-index-info',
    mutate: (source) => ({ ...source, marker: replaceOnce(source.marker, 'indexInfo[0]?.name !== pkColumn', 'false') }),
    assertion: (source) => expect(source.marker).toContain('indexInfo[0]?.name !== pkColumn'),
  },
  {
    name: 'weaken-foreign-key-list',
    mutate: (source) => ({ ...source, marker: source.marker.replaceAll("pragmaRows(db, 'foreign_key_list', name).length !== 0", 'false') }),
    assertion: (source) => expect((source.marker.match(/pragmaRows\(db, 'foreign_key_list', name\)\.length !== 0/g) ?? []).length).toBe(2),
  },
  {
    name: 'accept-schema2',
    mutate: (source) => {
      const result = clone(source);
      result.marker = replaceOnce(result.marker, 'row.state_schema !== 1', 'row.state_schema === 999');
      return result;
    },
    assertion: (source) => expect(source.marker).toContain('row.state_schema !== 1'),
  },
  {
    name: 'accept-half-state',
    mutate: (source) => {
      const result = clone(source);
      result.marker = replaceOnce(result.marker, 'if (!hasLedger || !hasMarker) fail();', 'if (hasLedger && hasMarker) fail();');
      return result;
    },
    assertion: (source) => expect(source.marker).toContain('if (!hasLedger || !hasMarker) fail();'),
  },
  {
    name: 'accept-wrong-checksum',
    mutate: (source) => {
      const result = clone(source);
      result.marker = replaceOnce(result.marker, 'row.checksum_sha256 === AUTH_FOUNDATION_MIGRATION_CHECKSUM', 'row.checksum_sha256 !== AUTH_FOUNDATION_MIGRATION_CHECKSUM');
      return result;
    },
    assertion: (source) => expect(source.marker).toContain('row.checksum_sha256 === AUTH_FOUNDATION_MIGRATION_CHECKSUM'),
  },
  {
    name: 'accept-extra-ledger',
    mutate: (source) => {
      const result = clone(source);
      result.marker = replaceOnce(result.marker, 'if (rows.length !== 1) return false;', 'if (rows.length < 1) return false;');
      return result;
    },
    assertion: (source) => expect(source.marker).toContain('if (rows.length !== 1) return false;'),
  },
  {
    name: 'overwrite-marker',
    mutate: (source) => {
      const result = clone(source);
      result.marker += "\ndb.exec('UPDATE auth_runtime_state SET mode=\\'V1_COMPAT\\'');\n";
      return result;
    },
    assertion: (source) => {
      expect(source.marker).not.toMatch(/\b(?:UPDATE|DELETE|DROP)\s+(?:FROM\s+)?auth_runtime_state\b/i);
    },
  },
  {
    name: 'weaken-strict-unknown-fields',
    mutate: (source) => {
      const result = clone(source);
      result.contracts = replaceOnce(result.contracts, '}).strict();', '}).passthrough();');
      return result;
    },
    assertion: (source) => expect(source.contracts).not.toContain('.passthrough('),
  },
  {
    name: 'weaken-duplicate-key-rejection',
    mutate: (source) => {
      const result = clone(source);
      result.wire = replaceOnce(result.wire, 'if (keys.has(key.value)) throw new StrictWireError();', 'if (false) throw new StrictWireError();');
      return result;
    },
    assertion: (source) => expect(source.wire).toContain('if (keys.has(key.value)) throw new StrictWireError();'),
  },
  {
    name: 'weaken-utf8-text-only-boundary',
    mutate: (source) => {
      const result = clone(source);
      result.wire = replaceOnce(result.wire, "if (typeof input !== 'string') throw new StrictWireError();", "if (typeof input !== 'string') return { text: '', bytes: 0 };");
      return result;
    },
    assertion: (source) => expect(source.wire).toContain("if (typeof input !== 'string') throw new StrictWireError();"),
  },
  {
    name: 'weaken-binary-rejection',
    mutate: (source) => {
      const result = clone(source);
      result.wire = replaceOnce(result.wire, "input: string): { text: string; bytes: number }", "input: string | Uint8Array): { text: string; bytes: number }");
      return result;
    },
    assertion: (source) => expect(source.wire).toContain("function asUtf8(input: string): { text: string; bytes: number }"),
  },
  {
    name: 'live-v2-import',
    mutate: (source) => ({ ...source, server: `${source.server}\nimport './v2Contracts.js';\n` }),
    assertion: (source) => {
      expect(source.server).not.toMatch(/(?:v2Contracts|strictWire)/);
    },
  },
  {
    name: 'break-phase4-approve-predicate',
    mutate: (source) => {
      const result = clone(source);
      result.authz = replaceOnce(result.authz, "cmd.action === 'APPROVE_SKILL'", "cmd.action === 'MUTANT'");
      return result;
    },
    assertion: (source) => expect(source.authz).toContain("cmd.action === 'APPROVE_SKILL'"),
  },
  {
    name: 'break-phase4-guidance',
    mutate: (source) => ({ ...source, guidance: source.guidance.replaceAll('describeSkillDecision', 'describeSkillDecisionMutant') }),
    assertion: (source) => expect(source.guidance).toMatch(/\bdescribeSkillDecision\s*\(/),
  },
];

describe('Phase 1 named mutant gate', () => {
  it('rejects a named no-op mutation before it can count as an alternative-form mutant', () => {
    expect(() => replaceOnce('canonical', 'canonical', 'canonical')).toThrow(/mutation is a no-op/);
  });

  it('passes every baseline named invariant', () => {
    expect(mutants.map((mutant) => mutant.name)).toEqual([
      'fence-after-write',
      'skip-post-begin-recheck',
      'case-sensitive-collision',
      'table-only-collision',
      'name-only-collision',
      'omit-temp-scan',
      'omit-database-list',
      'omit-attachment-check',
      'unqualified-catalog',
      'unqualified-pragma',
      'unqualified-marker-select',
      'weaken-collision-cardinality',
      'weaken-catalog-byte-equality',
      'weaken-autoindex',
      'weaken-autoindex-sql-null',
      'weaken-index-list',
      'weaken-index-info',
      'weaken-foreign-key-list',
      'accept-schema2',
      'accept-half-state',
      'accept-wrong-checksum',
      'accept-extra-ledger',
      'overwrite-marker',
      'weaken-strict-unknown-fields',
      'weaken-duplicate-key-rejection',
      'weaken-utf8-text-only-boundary',
      'weaken-binary-rejection',
      'live-v2-import',
      'break-phase4-approve-predicate',
      'break-phase4-guidance',
    ]);
    for (const mutant of mutants) mutant.assertion(baseline);
  });

  for (const mutant of mutants) {
    it(`turns the named assertion red: ${mutant.name}`, () => {
      const mutated = mutant.mutate(baseline);
      expect(() => mutant.assertion(mutated), mutant.name).toThrow();
    });
  }
});
