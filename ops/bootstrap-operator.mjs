#!/usr/bin/env node
/**
 * Operator bootstrap for the Collaboration Substrate (PRD v0.14 Section 6.3).
 *
 * WHY THIS EXISTS
 * ----------------
 * `bootstrapOperator` (packages/collab/src/bootstrap.ts) has had ZERO
 * production callers since it shipped -- only tests invoke it. No CLI, no
 * `ops/` script, no gateway boot step ever created a real operator
 * principal + credential outside a test fixture. `9b544ee` closed the prior
 * blocker (the production SecretStore was a throwing stub, so any minted
 * credential could never authenticate); this script closes THIS gap by
 * giving a real operator a real, once-run way to obtain one.
 *
 * SHAPE CHOSEN: an explicit, operator-run `ops/` script (option A), matching
 * this repo's existing standalone-CLI convention (see
 * scripts/auth-phase2a-offline.mjs: dynamic `import('../packages/*\/dist/
 * ...')`, refusal codes instead of stack traces, no live/hot-path wiring).
 * A gateway boot-time auto-bootstrap (option B) was rejected: minting a
 * credential during unattended startup has no consent step and no place to
 * put the plaintext token that isn't either logs (forbidden) or a
 * side-channel file the operator wasn't warned about. An explicit script the
 * operator runs once, deliberately, is auditable and keeps secret minting
 * out of the server's hot path.
 *
 * CREDENTIAL DELIVERY
 * --------------------
 * `bootstrapOperator`'s plaintext `operatorCredential` token is NEVER
 * persisted anywhere in packages/collab -- see bootstrap.ts:606
 * ("plaintext, shown once") and the same "shown once" convention in
 * credentials.ts:84 and surfaceStore.ts:222. Only the PEPPER is persisted
 * (via FileSecretStore, outside this script's job). This script:
 *
 *   1. Prints the token to stdout ONCE, clearly labeled, so the operator can
 *      copy it immediately (matches the codebase's own "shown once" model).
 *   2. ALSO writes it to a single-use file under
 *      `<TORQCLAW_DATA_DIR>/operator-credential.token` using the identical
 *      atomic-create-at-0o600 pattern FileSecretStore.set() uses (open
 *      'wx' + explicit mode, never create-then-chmod), so a lost terminal
 *      scroll-back is not a permanent lockout. The operator is told, in the
 *      same breath, to copy the token to their password manager and then
 *      DELETE the file -- this script does not delete it automatically
 *      because that would make step 1 the only copy if the operator's
 *      terminal already scrolled past it.
 *   3. If the file already exists (a stale credential file from an earlier
 *      run this operator never cleaned up), refuses to overwrite it and
 *      reports the conflict rather than silently clobbering an
 *      un-copied token.
 *
 * This file itself is written OUTSIDE the repo (TORQCLAW_DATA_DIR defaults
 * to `~/.torqclaw`, never a path under this checkout), so it cannot be
 * accidentally `git add`-ed. `.gitignore`'s `.env`/`*.db` rules are
 * irrelevant here for the same reason: nothing this script writes is inside
 * the working tree.
 *
 * IDEMPOTENCY
 * -----------
 * `principals_single_operator` (packages/collab/src/migration.ts:70) is a
 * `CREATE UNIQUE INDEX ON principals(kind) WHERE kind='operator'` -- SQLite
 * itself refuses a second operator-kind principal row, active or revoked.
 * `bootstrapOperator`'s own transaction hits that constraint on a second
 * run and throws before any secret is touched; `FileSecretStore.set()`
 * independently throws `SecretAlreadyExistsError` if a pepper file already
 * exists (belt-and-suspenders -- neither check depends on the other). This
 * script does not pre-check "is there already an operator" itself (that
 * would be a TOCTOU race against the same DB); it lets the real constraint
 * fire and reports the refusal in plain language. A second run therefore:
 *   - creates NO second operator principal,
 *   - mints NO second credential,
 *   - rotates NOTHING (the original pepper file and credential keep working),
 *   - exits non-zero with a clear "already bootstrapped" message instead of
 *     a raw SQLite constraint stack trace.
 *
 * FAILURE PATH
 * ------------
 * `bootstrapOperator` throws `BootstrapSecretPersistError` (with a
 * compensating DB rollback already performed inside bootstrap.ts) if the
 * pepper cannot be persisted after the DB transaction committed. This
 * script catches that by class name specifically and prints its `.message`
 * (which bootstrap.ts already writes in operator-safe language, no raw
 * secret bytes) rather than an unhandled stack trace; every other error is
 * reported by class name + message with the same discipline -- never a full
 * Node stack trace, which could echo an in-progress buffer.
 *
 * USAGE
 *   pnpm --filter @torqclaw/collab build   (dist/ must exist -- this script
 *                                            imports built output, exactly
 *                                            like scripts/auth-phase2a-
 *                                            offline.mjs does)
 *   node ops/bootstrap-operator.mjs [--display-name "Operator"]
 *
 * Reads TORQCLAW_DATA_DIR / TORQCLAW_COLLAB_DB_PATH exactly as the gateway
 * does (collabIdentity.ts), so a bootstrap run against the operator's real
 * install lands in the SAME data dir and collab.db the gateway will open at
 * boot. Tests must override both env vars to a temp dir -- never rely on
 * this script's own defaults, which resolve to the real `~/.torqclaw`.
 */
import { existsSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes as nodeRandomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

function usage() {
  return 'Usage: node ops/bootstrap-operator.mjs [--display-name "Operator"]';
}

function parseArgs(argv) {
  let displayName = 'Operator';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--display-name') {
      if (argv[i + 1] === undefined) throw new Error('--display-name requires a value');
      displayName = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { displayName };
}

/** Production UuidSource backed by Node's CSPRNG-derived randomUUID(),
 *  matching the UuidSource shape (bootstrap.ts) and the same primitive
 *  collabIdentity.ts already uses for surface IDs (`randomUUID()` at
 *  collabIdentity.ts:399). No production UuidSource shipped in
 *  packages/collab itself (only the fixture-seeded DeterministicUuids for
 *  tests), so this script supplies its own minimal adapter rather than
 *  reaching for a test double. */
const productionUuidSource = { next: () => randomUUID() };

async function main() {
  const { displayName } = parseArgs(process.argv.slice(2));

  const dataDir = process.env.TORQCLAW_DATA_DIR || join(osHomedir(), '.torqclaw');
  const collabDbPath = process.env.TORQCLAW_COLLAB_DB_PATH || join(dataDir, 'collab.db');
  const tokenFilePath = join(dataDir, 'operator-credential.token');

  mkdirSync(dataDir, { recursive: true });

  if (existsSync(tokenFilePath)) {
    process.stderr.write(
      `${usage()}\n` +
      `Refused: ${tokenFilePath} already exists.\n` +
      'A previous bootstrap run left an un-cleaned credential file here. ' +
      'If you already copied that token, delete the file and re-run only if ' +
      'you actually need a fresh install (this will still refuse if an ' +
      'operator principal already exists in collab.db -- see below). If you ' +
      'have not copied it yet, read it now instead of re-running.\n'
    );
    process.exitCode = 2;
    return;
  }

  // Dynamic import of BUILT output only, matching scripts/auth-phase2a-
  // offline.mjs's convention exactly -- this script never imports
  // package TypeScript sources directly.
  let bootstrapOperator, nodeRandomSource, systemClock, BootstrapSecretPersistError, BootstrapRefusedError, runCollaborationMigration, FileSecretStore;
  try {
    ({ bootstrapOperator, nodeRandomSource, systemClock, BootstrapSecretPersistError, BootstrapRefusedError, runCollaborationMigration, FileSecretStore } =
      await import('../packages/collab/dist/index.js'));
  } catch (err) {
    process.stderr.write(
      `${usage()}\n` +
      'Refused: could not load @torqclaw/collab build output. Run ' +
      '`pnpm --filter @torqclaw/collab build` first.\n' +
      `(${err instanceof Error ? err.constructor.name : 'error'})\n`
    );
    process.exitCode = 2;
    return;
  }

  let sqlite;
  try {
    sqlite = new Database(collabDbPath);
    runCollaborationMigration(sqlite);

    const db = {
      prepare: (sql) => sqlite.prepare(sql),
      exec: (sql) => sqlite.exec(sql),
      transaction: (fn) => sqlite.transaction(fn),
    };
    const secretStore = new FileSecretStore(dataDir);

    const installationId = randomUUID();
    const result = bootstrapOperator(
      { db, secretStore, clock: systemClock, uuids: productionUuidSource, rng: nodeRandomSource },
      { operatorDisplayName: displayName, installationId, schemaVersion: 1 }
    );

    // credentialToken is a plain string (not a Buffer) -- see bootstrap.ts's
    // own comment ("the encoded response string itself is not zeroable").
    // The three Buffer secrets ARE zeroed here immediately after use, same
    // discipline bootstrap.ts itself follows on every path.
    const credentialToken = result.operatorCredential;
    result.principalPepper.fill(0);
    result.recoveryPepper.fill(0);
    result.recoverySecret.fill(0);

    // Atomic create-at-0o600, identical pattern to FileSecretStore.set():
    // open('wx', 0o600) so the file never exists in a briefly-world-
    // readable or empty state, then write and close. 'wx' itself refuses to
    // overwrite an existing file, which is redundant with the existsSync
    // check above but closes the same race window FileSecretStore's own
    // comment documents (another process/run winning between check and
    // write).
    const fd = openSync(tokenFilePath, 'wx', 0o600);
    try {
      writeSync(fd, `${credentialToken}\n`);
    } finally {
      closeSync(fd);
    }

    process.stdout.write(
      '\n' +
      '=============================================================\n' +
      'TORQCLAW operator bootstrap complete.\n' +
      '=============================================================\n' +
      `Operator principal: ${result.operatorPrincipalId}\n` +
      `Installation:       ${installationId}\n` +
      '\n' +
      'Your operator credential (SHOWN ONCE, never stored by TORQCLAW\n' +
      'itself beyond the file below):\n' +
      '\n' +
      `  ${credentialToken}\n` +
      '\n' +
      `This token was ALSO written to:\n  ${tokenFilePath}\n` +
      '(created with owner-only 0o600 permissions; on Windows this is a\n' +
      'DOS-attribute hint, not an NTFS-enforced boundary -- see secrets.ts\n' +
      'for the full caveat. Treat this like any other secret on disk.)\n' +
      '\n' +
      'ACTION REQUIRED: copy this token into your password manager or\n' +
      'secure notes now, then DELETE the token file above. Nothing in\n' +
      'TORQCLAW can show it to you again -- there is no rotate/recover\n' +
      'path for this specific token today; losing it before copying it\n' +
      'means re-running this script, which will refuse (see below) because\n' +
      'an operator principal already exists.\n' +
      '=============================================================\n\n'
    );
  } catch (err) {
    if (BootstrapRefusedError && err instanceof BootstrapRefusedError) {
      process.stderr.write(
        `${usage()}\n` +
        'Refused: the SecretStore backing this install is not persistent. ' +
        `${err.message}\n`
      );
      process.exitCode = 2;
      return;
    }
    if (BootstrapSecretPersistError && err instanceof BootstrapSecretPersistError) {
      process.stderr.write(
        `${usage()}\n` +
        'Bootstrap partially failed: the database transaction committed but ' +
        'persisting the pepper failed; a compensating rollback already ran ' +
        'inside bootstrapOperator, so this install is back to its ' +
        'pre-bootstrap state and safe to retry.\n' +
        `${err.message}\n`
      );
      process.exitCode = 3;
      return;
    }
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') {
      process.stderr.write(
        `${usage()}\n` +
        'Refused: this installation already has an operator principal ' +
        '(principals_single_operator allows at most one). No second ' +
        'operator was created, no credential was minted, and the existing ' +
        'credential/pepper were not touched. If you lost the original ' +
        'token and need a new installation, that is a deliberate operator ' +
        'decision outside this script\'s scope (there is no rotate here by ' +
        'design -- see secrets.ts SecretAlreadyExistsError).\n'
      );
      process.exitCode = 4;
      return;
    }
    if (code === 'SECRET_ALREADY_EXISTS' || (err && err.name === 'SecretAlreadyExistsError')) {
      process.stderr.write(
        `${usage()}\n` +
        'Refused: a principal pepper already exists on disk for this data ' +
        'directory. No credential was minted. This store never overwrites ' +
        'an existing secret.\n'
      );
      process.exitCode = 4;
      return;
    }
    process.stderr.write(
      `${usage()}\n` +
      `Bootstrap failed: ${err instanceof Error ? err.constructor.name : 'error'}: ` +
      `${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
  } finally {
    try { sqlite?.close(); } catch { /* best-effort cleanup */ }
  }
}

await main();
