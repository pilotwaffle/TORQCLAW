import { createHash } from 'node:crypto';

export const COLLAB_AUTH_IDENTITY_MIGRATION_ID = 'collab-auth-identity-reconciliation-002';
export type AuthPhase2AStep = { readonly kind: 'assert' | 'ddl' | 'receipt-boundary'; readonly name: string; readonly payload: string };

const COLLATION_ASSERT = 'AUTH_PHASE2A_ASSERT_V1';
export const COLLAB_AUTH_IDENTITY_STEP_MANIFEST: readonly AuthPhase2AStep[] = [
  { kind: 'assert', name: 'collab-current-base', payload: `${COLLATION_ASSERT}:collab-base-v1` },
  { kind: 'ddl', name: 'collab-create-ledger', payload: `CREATE TABLE IF NOT EXISTS collab_auth_schema_migrations (\n  id TEXT PRIMARY KEY,\n  checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256)=64 AND checksum_sha256 GLOB '[0-9a-f]*'),\n  applied_at TEXT NOT NULL\n);` },
  { kind: 'assert', name: 'collab-ledger-empty-exact', payload: `${COLLATION_ASSERT}:collab-ledger-empty-v1` },
  { kind: 'ddl', name: 'collab-add-connection-class', payload: `ALTER TABLE surfaces ADD COLUMN connection_class TEXT NOT NULL DEFAULT 'none' CHECK(connection_class IN ('none','browser_bff','channel_dedicated','agent_node','diagnostic','benchmark_submit','acceptance_submit','fixture_operator'));` },
  { kind: 'ddl', name: 'collab-add-connection-class-revision', payload: `ALTER TABLE surfaces ADD COLUMN connection_class_revision INTEGER NOT NULL DEFAULT 1 CHECK(connection_class_revision > 0);` },
  { kind: 'assert', name: 'collab-post-schema-before-receipt', payload: `${COLLATION_ASSERT}:collab-post-schema-v1` },
  { kind: 'assert', name: 'collab-receipt-absent', payload: `${COLLATION_ASSERT}:collab-receipt-absent-v1` },
  { kind: 'receipt-boundary', name: 'collab-receipt-boundary', payload: '' },
  { kind: 'assert', name: 'collab-post-schema-with-receipt', payload: `${COLLATION_ASSERT}:collab-post-schema-receipt-v1` },
] as const;

export const COLLAB_AUTH_IDENTITY_MIGRATION_SQL = COLLAB_AUTH_IDENTITY_STEP_MANIFEST
  .filter((step) => step.kind === 'ddl').map((step) => step.payload).join('\n');

function utf8Length(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function normalizePayload(value: string): string { return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n'); }
export function serializeAuthPhase2AProgram(manifest: readonly AuthPhase2AStep[]): string {
  return `AUTH_PHASE2A_PROGRAM_V1\n${manifest.map((step) => {
    if (/[\r]/.test(step.kind) || /[\r]/.test(step.name)) throw new Error('AUTH_PHASE2A_MANIFEST_INVALID');
    const payload = normalizePayload(step.payload);
    return `kind=${step.kind}\nnameBytes=${utf8Length(step.name)}\n${step.name}\npayloadBytes=${utf8Length(payload)}\n${payload}\n`;
  }).join('')}`;
}

export const COLLAB_AUTH_IDENTITY_SERIALIZED_PROGRAM = serializeAuthPhase2AProgram(COLLAB_AUTH_IDENTITY_STEP_MANIFEST);
export const COLLAB_AUTH_IDENTITY_PROGRAM_UTF8_HEX = Buffer.from(COLLAB_AUTH_IDENTITY_SERIALIZED_PROGRAM, 'utf8').toString('hex');
export function phase2aMigrationChecksum(id: string, serializedProgram: string): string {
  return createHash('sha256').update(`${id}\n${serializedProgram}`, 'utf8').digest('hex');
}
export const COLLAB_AUTH_IDENTITY_MIGRATION_CHECKSUM = 'f28b9517452ce28987e20e906cd7149ce723f092fcccaf314c91f8c6208342fb';

export const PHASE2A_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
