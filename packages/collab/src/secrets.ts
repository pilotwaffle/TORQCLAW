/**
 * SecretStore abstraction for the Collaboration Substrate.
 *
 * Per PRD v0.14 Section 6.1/6.3: `principalPepper` and the recovery pepper
 * are stored OUTSIDE SQLite, in durable off-database storage
 * (`TORQCLAW/principal-pepper`, `TORQCLAW/recovery-pepper`). This interface
 * abstracts that storage so bootstrap/store code can be tested against an
 * in-memory implementation while production wires a real persistent
 * adapter.
 *
 * G1R explicit answer (a): SecretStore injection is sufficient for the
 * Slice 1 gate. The Windows Credential Manager adapter may ship as a stub
 * that throws NOT_IMPLEMENTED on both get and set — conditional on
 * bootstrap refusing to report "healthy" when the injected store is not
 * persistent (see bootstrap.ts `assertPersistentSecretStore`).
 *
 * PRODUCTION ADAPTER (this slice): `FileSecretStore`, a file-backed
 * persistent store scoped to a caller-supplied directory (the gateway
 * passes its already-resolved `TORQCLAW_DATA_DIR`). A native OS-keyring
 * binding (`WindowsCredentialManagerStore` below) is explicitly DEFERRED —
 * no native dependency (e.g. `keytar`) is installed, and adding one is its
 * own slice. `FileSecretStore` implements the identical `SecretStore`
 * interface so a keyring backend can drop in behind it later with ZERO
 * call-site changes — the same shape as the upstream Buzz pattern, where
 * `keyring` is a default-on but compile-out-able feature and headless
 * installs fall back to a file/env-backed store.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * A named secret storage backend.
 *
 * `isPersistent` tells callers (notably bootstrap) whether values written
 * here survive process restart / machine reboot. An in-memory store must
 * report `false`; a real OS-credential-manager-backed store must report
 * `true`. Bootstrap uses this flag to refuse "healthy" status when backed
 * by a non-persistent store (Section 6.3 mandates persistent storage for
 * the principal pepper; losing it is equivalent to losing the installation
 * per Section 6.4).
 */
export interface SecretStore {
  readonly isPersistent: boolean;
  get(name: string): Buffer | undefined;
  set(name: string, value: Buffer): void;
}

/**
 * In-memory SecretStore. Not persistent. Suitable for tests and for the
 * fixture harness; production code MUST refuse to report healthy when this
 * (or any other non-persistent store) backs the installation.
 */
export class InMemorySecretStore implements SecretStore {
  readonly isPersistent = false;
  private readonly values = new Map<string, Buffer>();

  get(name: string): Buffer | undefined {
    const v = this.values.get(name);
    return v === undefined ? undefined : Buffer.from(v);
  }

  set(name: string, value: Buffer): void {
    this.values.set(name, Buffer.from(value));
  }
}

/**
 * Error thrown by WindowsCredentialManagerStore's stub methods.
 */
export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED' as const;

  constructor(operation: string) {
    super(`WindowsCredentialManagerStore.${operation} is not implemented; the real adapter ships with the CLI slice`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Stub for a future native Windows Credential Manager-backed SecretStore.
 *
 * DEFERRED, NOT BROKEN. This slice ships `FileSecretStore` (below) as the
 * production default instead — a file-backed persistent store requiring no
 * native dependency. A native OS-keyring binding (`keytar` or similar) was
 * explicitly deferred by the operator as its own slice: no such dependency
 * is installed in this repo. This stub exists so the interface is already
 * proven out and a real keyring adapter can drop in later behind the SAME
 * `SecretStore` interface with zero call-site changes (mirrors the
 * upstream Buzz pattern: keyring is a default-on but compile-out-able
 * feature, and headless/no-keyring installs use a file/env-backed store).
 *
 * `isPersistent` is `true` because the REAL adapter (once implemented)
 * backs onto Windows Credential Manager, which is persistent storage — the
 * flag describes the backend's intended durability contract, not this
 * stub's current (non-functional) behavior. Both `get` and `set` throw
 * `NotImplementedError` unconditionally; do not wire this into production
 * until it is actually implemented.
 */
export class WindowsCredentialManagerStore implements SecretStore {
  readonly isPersistent = true;

  get(_name: string): Buffer | undefined {
    throw new NotImplementedError('get');
  }

  set(_name: string, _value: Buffer): void {
    throw new NotImplementedError('set');
  }
}

/**
 * Error thrown by `FileSecretStore.set()` when a secret already exists
 * under the given name.
 *
 * WHY THROW INSTEAD OF SILENTLY NO-OPPING OR OVERWRITING: `set()` on this
 * interface has exactly one production caller today (`bootstrapOperator`,
 * bootstrap.ts:683-684), which writes the principal pepper and recovery
 * pepper exactly once, at first-ever bootstrap. A second bootstrap run
 * (operator re-runs a setup script, a bug re-invokes it, a race between two
 * startup paths) must NEVER silently rotate a live pepper out from under
 * already-issued credentials — every `secret_hmac` in `principal_credentials`
 * was computed under the OLD pepper, and replacing it makes every existing
 * credential permanently unverifiable with no rollback (this is the same
 * failure mode Section 6.4 calls equivalent to losing the installation). A
 * silent no-op is equally wrong: it would let a caller believe it just
 * rotated a secret when it did not. Throwing is the only option that can
 * never be mistaken for success. The `SecretStore` interface intentionally
 * has no `force`/`overwrite` parameter (this slice must not change the
 * interface). There is deliberately no delete/rotate method on
 * `FileSecretStore` either -- an intentional-rotation use case (operator-
 * initiated pepper rotation) is out of this slice's scope and needs its own
 * explicit, reviewed operation before ever calling `set()` again for an
 * existing name; today the only way to retry is to remove the secret file
 * by hand, which is deliberately not a one-line API call.
 */
export class SecretAlreadyExistsError extends Error {
  readonly code = 'SECRET_ALREADY_EXISTS' as const;

  constructor(name: string) {
    super(`FileSecretStore.set('${name}') refused: a secret already exists under this name. ` +
      'Overwriting it would silently rotate a value that may already back live credentials. ' +
      'This store never overwrites implicitly.');
    this.name = 'SecretAlreadyExistsError';
  }
}

/** Sanitize a secret name into a safe filename component. Secret names in
 *  this codebase are fixed string literals (`TORQCLAW/principal-pepper`,
 *  `TORQCLAW/recovery-pepper`) chosen by our own code, never user input —
 *  this replacement is defense in depth against a future caller passing an
 *  unexpected name, not a security boundary against adversarial input. */
function secretFileName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe}.secret`;
}

/**
 * File-backed persistent SecretStore, scoped to a caller-supplied
 * directory (the gateway passes its already-resolved `TORQCLAW_DATA_DIR`;
 * this package stays filesystem-path-agnostic and never derives that path
 * itself — see collabIdentity.ts for the actual resolution reused here).
 *
 * PERMISSIONS: each secret file is created with mode 0o600 (owner
 * read/write only) ATOMICALLY at creation via `fs.openSync(path, 'wx',
 * 0o600)` — 'wx' fails if the file already exists and never leaves a
 * create-then-chmod window where the file is briefly world-readable.
 *
 * HONEST WINDOWS CAVEAT: this process runs on Windows, where the POSIX
 * `mode` argument to `open`/`chmod` is LARGELY ADVISORY. Node's libuv layer
 * maps a subset of the mode bits onto the file's read-only DOS attribute,
 * but Windows access control is actually governed by NTFS ACLs, which
 * `mode: 0o600` does NOT set. In practice on Windows this means: the file
 * is generally still readable by the same OS user account (that boundary
 * comes from NTFS permissions on the user's own profile/data directory,
 * not from this call), but 0o600 here should NOT be read as "this file is
 * OS-enforced owner-only unreadable by other processes running as the same
 * user," and it provides no protection against another process running
 * under the SAME Windows account. It is real, load-bearing protection only
 * on POSIX systems (Linux/macOS), where `mode` maps directly to
 * permission bits enforced by the kernel. See the report for the full
 * threat-model statement.
 *
 * ATOMIC WRITES: `set()` writes the secret to a temp file in the SAME
 * directory, then `renameSync`s it into place. `rename` within one
 * filesystem/volume is atomic on both POSIX and Windows (NTFS) — a crash
 * mid-write leaves the temp file orphaned (harmless, cleaned up on next
 * attempt) and the real target either fully absent or fully the OLD
 * content, never truncated or partially written.
 *
 * OVERWRITE SEMANTICS: see `SecretAlreadyExistsError`. `set()` throws if a
 * secret already exists under the given name; it never silently overwrites.
 */
export class FileSecretStore implements SecretStore {
  readonly isPersistent = true;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'secrets');
  }

  private pathFor(name: string): string {
    return join(this.dir, secretFileName(name));
  }

  get(name: string): Buffer | undefined {
    const path = this.pathFor(name);
    if (!existsSync(path)) return undefined;
    try {
      return readFileSync(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined; // raced with a concurrent delete/rename
      throw err;
    }
  }

  set(name: string, value: Buffer): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = this.pathFor(name);
    if (existsSync(path)) {
      throw new SecretAlreadyExistsError(name);
    }

    // Atomic creation with the final permission bits set at open() time —
    // never create-then-chmod. A random suffix avoids collisions between
    // concurrent set() calls for different names / retried operations.
    const tmpPath = join(this.dir, `.tmp-${secretFileName(name)}-${randomBytes(8).toString('hex')}`);
    const fd = openSync(tmpPath, 'wx', 0o600);
    try {
      writeSync(fd, value);
    } finally {
      closeSync(fd);
    }

    try {
      // Atomic rename into place. If another writer won the race for the
      // SAME name between our existsSync check and here, renameSync would
      // silently clobber it on POSIX (rename-onto-existing is atomic
      // replace) -- re-check immediately before the rename to keep the
      // no-silent-overwrite guarantee under concurrency, not just in the
      // common single-writer case.
      if (existsSync(path)) {
        unlinkSync(tmpPath);
        throw new SecretAlreadyExistsError(name);
      }
      renameSync(tmpPath, path);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
      throw err;
    }
  }
}
