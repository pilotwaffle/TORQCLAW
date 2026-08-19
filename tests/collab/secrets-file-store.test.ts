/**
 * FileSecretStore unit tests (packages/collab/src/secrets.ts).
 *
 * This is the production SecretStore that replaces the throwing
 * WindowsCredentialManagerStore stub as the default in
 * packages/gateway/src/collabIdentity.ts's getSecretStore(). These tests
 * cover the store's own contract in isolation (permissions, atomicity,
 * overwrite refusal, persistence) -- the end-to-end proof that a real
 * gateway process authenticates against it lives in
 * tests/collab-secret-store-live-wire.test.ts.
 *
 * Per vitest.config.ts's header comment, tests under tests/collab/ are
 * "pure-logic... no filesystem" EXCEPT where a module insists on the
 * filesystem -- FileSecretStore is exactly that carve-out (it is, by
 * design, a filesystem-backed store), so this file legitimately uses a
 * real mkdtempSync temp directory rather than an in-memory fake.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import { FileSecretStore, SecretAlreadyExistsError } from '../../packages/collab/src/secrets.js';

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'torq-filesecretstore-'));
}

describe('FileSecretStore', () => {
  it('reports isPersistent = true', () => {
    const store = new FileSecretStore(tempDataDir());
    expect(store.isPersistent).toBe(true);
  });

  it('get() returns undefined for a name that was never set', () => {
    const store = new FileSecretStore(tempDataDir());
    expect(store.get('TORQCLAW/principal-pepper')).toBeUndefined();
  });

  it('round-trips a 32-byte secret through set()/get()', () => {
    const store = new FileSecretStore(tempDataDir());
    const value = Buffer.alloc(32, 0x42);
    store.set('TORQCLAW/principal-pepper', value);
    const readBack = store.get('TORQCLAW/principal-pepper');
    expect(readBack).toBeDefined();
    expect(readBack!.equals(value)).toBe(true);
  });

  it('stores different names independently', () => {
    const store = new FileSecretStore(tempDataDir());
    const a = Buffer.alloc(32, 0xaa);
    const b = Buffer.alloc(32, 0xbb);
    store.set('TORQCLAW/principal-pepper', a);
    store.set('TORQCLAW/recovery-pepper', b);
    expect(store.get('TORQCLAW/principal-pepper')!.equals(a)).toBe(true);
    expect(store.get('TORQCLAW/recovery-pepper')!.equals(b)).toBe(true);
  });

  it('creates the secret file under "<dataDir>/secrets/"', () => {
    const dataDir = tempDataDir();
    const store = new FileSecretStore(dataDir);
    store.set('TORQCLAW/principal-pepper', Buffer.alloc(32, 1));
    const secretsDir = join(dataDir, 'secrets');
    expect(existsSync(secretsDir)).toBe(true);
    const files = readdirSync(secretsDir).filter((f) => !f.startsWith('.tmp-'));
    expect(files.length).toBe(1);
    expect(files[0]).toBe('TORQCLAW_principal-pepper.secret');
  });

  it('never leaves a stray .tmp- file behind after a successful set()', () => {
    const dataDir = tempDataDir();
    const store = new FileSecretStore(dataDir);
    store.set('TORQCLAW/principal-pepper', Buffer.alloc(32, 1));
    const secretsDir = join(dataDir, 'secrets');
    const tmpFiles = readdirSync(secretsDir).filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toEqual([]);
  });

  it('set() throws SecretAlreadyExistsError on a second set() for the same name, and does NOT change the stored value', () => {
    const store = new FileSecretStore(tempDataDir());
    const original = Buffer.alloc(32, 0x11);
    const attempted = Buffer.alloc(32, 0x22);
    store.set('TORQCLAW/principal-pepper', original);
    expect(() => store.set('TORQCLAW/principal-pepper', attempted)).toThrow(SecretAlreadyExistsError);
    const stillOriginal = store.get('TORQCLAW/principal-pepper');
    expect(stillOriginal!.equals(original)).toBe(true);
  });

  it('a rejected overwrite leaves no tmp file behind', () => {
    const dataDir = tempDataDir();
    const store = new FileSecretStore(dataDir);
    store.set('TORQCLAW/principal-pepper', Buffer.alloc(32, 1));
    try {
      store.set('TORQCLAW/principal-pepper', Buffer.alloc(32, 2));
    } catch {
      /* expected */
    }
    const secretsDir = join(dataDir, 'secrets');
    const tmpFiles = readdirSync(secretsDir).filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toEqual([]);
  });

  it('a fresh FileSecretStore instance over the SAME dataDir reads what a prior instance wrote (persistence across instances, simulating process restart)', () => {
    const dataDir = tempDataDir();
    const first = new FileSecretStore(dataDir);
    const value = Buffer.alloc(32, 0x77);
    first.set('TORQCLAW/principal-pepper', value);

    const second = new FileSecretStore(dataDir);
    const readBack = second.get('TORQCLAW/principal-pepper');
    expect(readBack).toBeDefined();
    expect(readBack!.equals(value)).toBe(true);
  });

  // POSIX-only: Windows file `mode` bits are advisory (see secrets.ts's
  // documented caveat) and NTFS does not expose the same permission bits
  // via fs.statSync().mode, so asserting an exact 0o600 mode on Windows
  // would be asserting something the platform does not actually guarantee.
  // This test exists specifically to prove the load-bearing case: on a
  // platform where mode IS enforced, the bits are correct.
  (platform() === 'win32' ? it.skip : it)(
    'creates the secret file with mode 0600 on POSIX platforms',
    () => {
      const dataDir = tempDataDir();
      const store = new FileSecretStore(dataDir);
      store.set('TORQCLAW/principal-pepper', Buffer.alloc(32, 1));
      const path = join(dataDir, 'secrets', 'TORQCLAW_principal-pepper.secret');
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it('get() and set() work with an already-existing "secrets" directory (mkdirSync recursive no-ops cleanly)', () => {
    const dataDir = tempDataDir();
    const first = new FileSecretStore(dataDir);
    first.set('TORQCLAW/principal-pepper', Buffer.alloc(32, 1));
    // Constructing a second store over the same dir must not fail because
    // the "secrets" subdirectory already exists.
    const second = new FileSecretStore(dataDir);
    second.set('TORQCLAW/recovery-pepper', Buffer.alloc(32, 2));
    expect(second.get('TORQCLAW/principal-pepper')).toBeDefined();
    expect(second.get('TORQCLAW/recovery-pepper')).toBeDefined();
  });
});
