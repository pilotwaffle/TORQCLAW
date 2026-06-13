import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw');
mkdirSync(DATA_DIR, { recursive: true });

export const db: Database.Database = new Database(join(DATA_DIR, 'state.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const here = dirname(fileURLToPath(import.meta.url));
db.exec(readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8'));

// Idempotent migration: add tasks.telemetry_json on an existing dev DB without
// the column (PRAGMA check, not a bare ALTER that throws on second boot).
const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
if (!taskCols.some((c) => c.name === 'telemetry_json')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN telemetry_json TEXT`);
}

export { DATA_DIR };
