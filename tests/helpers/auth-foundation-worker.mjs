import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'node:fs';
import { readAuthRuntimeMarker, runAuthFoundationMigration } from '../../packages/gateway/src/authRuntimeMarker.ts';

const [databasePath, readyPath, releasePath, collisionMode] = process.argv.slice(2);
if (!databasePath || !readyPath || !releasePath) process.exit(2);

writeFileSync(readyPath, String(process.pid), 'utf8');
const deadline = Date.now() + 10_000;
while (!existsSync(releasePath)) {
  if (Date.now() >= deadline) process.exit(3);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

if (collisionMode === 'toctou-autoindex' || collisionMode?.startsWith('autoindex-')) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA writable_schema=ON');
  const variant = collisionMode === 'toctou-autoindex' ? 'non-null' : collisionMode.slice('autoindex-'.length);
  if (variant === 'missing') {
    db.prepare(`DELETE FROM sqlite_master WHERE type='index' AND name='sqlite_autoindex_gateway_schema_migrations_1'`).run();
  } else if (variant === 'extra') {
    db.prepare(`INSERT INTO sqlite_master(type,name,tbl_name,rootpage,sql)
      VALUES ('index','sqlite_autoindex_auth_runtime_state_1','auth_runtime_state',0,NULL)`).run();
  } else {
    db.prepare(`UPDATE sqlite_master SET sql=? WHERE type='index' AND name='sqlite_autoindex_gateway_schema_migrations_1'`)
      .run('CREATE INDEX sqlite_autoindex_gateway_schema_migrations_1 ON gateway_schema_migrations(id)');
  }
  db.exec('PRAGMA writable_schema=OFF');
  db.close();
  process.stdout.write(JSON.stringify({ result: 'autoindex-mutated' }) + '\n');
  process.exit(0);
}

const db = new Database(databasePath);
try {
  if (collisionMode === 'toctou-writer') {
    db.exec('CREATE TABLE auth_runtime_state (collision INTEGER)');
    process.stdout.write(JSON.stringify({ result: 'collision-committed' }) + '\n');
  }
  if (collisionMode === 'temp') db.exec('CREATE TEMP TABLE auth_runtime_state (collision INTEGER)');
  if (collisionMode === 'attach') {
    db.exec("ATTACH ':memory:' AS aux");
    db.exec('CREATE TABLE aux.auth_runtime_state (collision INTEGER)');
  }
  if (collisionMode === 'toctou-writer' || collisionMode === 'toctou-autoindex') {
    // The parent performed its initial read fence before releasing us; this
    // committed collision is the inter-process TOCTOU mutation.
  } else if (collisionMode) {
    try {
      readAuthRuntimeMarker(db);
      process.stdout.write(JSON.stringify({ result: 'accepted' }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ result: 'refused', error: error instanceof Error ? error.name : 'unknown' }) + '\n');
    }
  } else {
    const outcome = runAuthFoundationMigration(db);
    process.stdout.write(JSON.stringify({ outcome }) + '\n');
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.name : 'unknown' }) + '\n');
  process.exitCode = 1;
} finally {
  db.close();
}
