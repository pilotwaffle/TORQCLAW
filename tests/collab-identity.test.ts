import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { issueCredential, nodeRandomSource, runCollaborationMigration, InMemorySecretStore, type BootstrapDb, type SecretStore } from '../packages/collab/src/index.js';

const PRINCIPAL_ID = randomUUID();
const CREDENTIAL_ID = randomUUID();
const REVOKED_CREDENTIAL_ID = randomUUID();
const PEPPER_NAME = 'TORQCLAW/principal-pepper';

function nowIso(): string { return new Date().toISOString(); }

describe('collabIdentity.verifySurfaceCredential - server-derived binding', () => {
  let db: Database.Database;
  let pepper: Buffer;
  let activeToken: string;
  let revokedToken: string;
  let setCollabDbForTest: (db: BootstrapDb | null) => void;
  let setCollabSecretStoreForTest: (s: SecretStore | null) => void;
  let verifySurfaceCredential: (credential: string) => { principalId: string; surfaceId: string } | null;

  beforeEach(async () => {
    db = new Database(':memory:');
    runCollaborationMigration(db);
    pepper = Buffer.alloc(32, 0x77);
    const active = issueCredential(CREDENTIAL_ID, pepper, nodeRandomSource);
    const revoked = issueCredential(REVOKED_CREDENTIAL_ID, pepper, nodeRandomSource);
    activeToken = active.token;
    revokedToken = revoked.token;
    active.secretBytes.fill(0);
    revoked.secretBytes.fill(0);
    const now = nowIso();
    db.prepare("INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES (?, 'operator', 'Test Operator', NULL, 'active', 1, NULL, ?, ?)").run(PRINCIPAL_ID, now, now);
    db.prepare("INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'active', NULL, ?, NULL)").run(CREDENTIAL_ID, PRINCIPAL_ID, active.secretHmac, now);
    db.prepare("INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, 'revoked', ?, ?, NULL)").run(REVOKED_CREDENTIAL_ID, PRINCIPAL_ID, revoked.secretHmac, now, now);

    const mod = await import('../packages/gateway/src/collabIdentity.js');
    setCollabDbForTest = mod.setCollabDbForTest;
    setCollabSecretStoreForTest = mod.setCollabSecretStoreForTest;
    verifySurfaceCredential = mod.verifySurfaceCredential;
    setCollabDbForTest(db);
    const store = new InMemorySecretStore();
    store.set(PEPPER_NAME, pepper);
    setCollabSecretStoreForTest(store);
  });

  afterEach(() => {
    setCollabDbForTest(null);
    setCollabSecretStoreForTest(null);
    db.close();
  });

  it('derives the correct PrincipalBinding for a valid active credential', () => {
    expect(verifySurfaceCredential(activeToken)).toEqual({ principalId: PRINCIPAL_ID, surfaceId: CREDENTIAL_ID });
  });
  it('uses the verified credential id as the documented C0.1 surface stand-in', () => {
    expect(verifySurfaceCredential(activeToken)?.surfaceId).toBe(CREDENTIAL_ID);
  });
  it('returns null for revoked, unknown, and malformed credentials', () => {
    expect(verifySurfaceCredential(revokedToken)).toBeNull();
    expect(verifySurfaceCredential('tq1_' + randomUUID() + '_bogus')).toBeNull();
    expect(verifySurfaceCredential('not-even-a-token')).toBeNull();
  });
  it('fails closed when no pepper is provisioned', () => {
    setCollabSecretStoreForTest(new InMemorySecretStore());
    expect(verifySurfaceCredential(activeToken)).toBeNull();
  });
  it('returns null without throwing when the principal row vanishes after credential verification', () => {
    const vanishedRowDb: BootstrapDb = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (sql.includes('FROM principal_credentials pc')) return { get: () => undefined } as ReturnType<BootstrapDb['prepare']>;
        return statement as ReturnType<BootstrapDb['prepare']>;
      },
    };
    setCollabDbForTest(vanishedRowDb);
    expect(() => verifySurfaceCredential(activeToken)).not.toThrow();
    expect(verifySurfaceCredential(activeToken)).toBeNull();
  });
});
