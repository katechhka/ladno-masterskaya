import { flow } from './flow.mjs';
import {mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {projectRoot} from '../services/catalog.mjs';
export function openDatabase(filename = process.env.DATABASE_PATH || 'storage/ladno.sqlite') {
  const path = filename === ':memory:' ? filename : resolve(projectRoot, filename);
  if (path !== ':memory:') mkdirSync(dirname(path), {
    recursive: true
  });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}
export const migrate = flow(function* migrate(db) {
  yield db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT');
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  const applied = new Set((yield db.prepare('SELECT name FROM schema_migrations').all()).map(row => row.name));
  const pending = readdirSync(directory).filter(name => name.endsWith('.sql') && !applied.has(name)).sort();
  if(!pending.length)return 0;
  yield db.transaction(flow(function* () {
    for (const name of pending) {
      yield db.exec(readFileSync(resolve(directory, name), 'utf8'));
      yield db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    }
  })).immediate();
  return pending.length;
});
