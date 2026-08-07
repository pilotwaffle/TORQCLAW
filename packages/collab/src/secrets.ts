/**
 * SecretStore abstraction for the Collaboration Substrate.
 *
 * Per PRD v0.14 Section 6.1/6.3: `principalPepper` and the recovery pepper
 * are stored OUTSIDE SQLite, in Windows Credential Manager
 * (`TORQCLAW/principal-pepper`, `TORQCLAW/recovery-pepper`). This interface
 * abstracts that storage so bootstrap/store code can be tested against an
 * in-memory implementation while production wires the real Windows
 * Credential Manager adapter.
 *
 * G1R explicit answer (a): SecretStore injection is sufficient for the
 * Slice 1 gate. The Windows Credential Manager adapter may ship as a stub
 * that throws NOT_IMPLEMENTED on both get and set — conditional on
 * bootstrap refusing to report "healthy" when the injected store is not
 * persistent (see bootstrap.ts `assertPersistentSecretStore`). The real
 * adapter lands with the CLI slice.
 */

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
 * Stub for the real Windows Credential Manager-backed SecretStore.
 *
 * `isPersistent` is `true` because the REAL adapter (once implemented)
 * backs onto Windows Credential Manager, which is persistent storage — the
 * flag describes the backend's intended durability contract, not this
 * stub's current (non-functional) behavior. Both `get` and `set` throw
 * `NotImplementedError` unconditionally; this stub exists so callers can
 * wire the interface today and swap in the real adapter later without an
 * interface change. The real adapter lands with the CLI slice.
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
