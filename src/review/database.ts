import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function databasePath(): string { return resolve(process.env.RECOVERY_DB_PATH ?? 'data/recovery.sqlite'); }

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY) STRICT;');
  for (const name of readdirSync(resolve('migrations')).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    transaction(db, () => {
      if (!db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) {
        db.exec(readFileSync(resolve('migrations', name), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);
      }
    });
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = run(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
