import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function defaultDbPath(): string {
  return process.env.DARTS_DB ?? resolve(process.cwd(), 'data', 'darts.db');
}

export function openDb(path = defaultDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_count INTEGER NOT NULL,
      start_score INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_player INTEGER NOT NULL DEFAULT 0,
      current_round INTEGER NOT NULL DEFAULT 1,
      winner INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS players (
      match_id INTEGER NOT NULL REFERENCES matches(id),
      idx INTEGER NOT NULL,
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      round_start_score INTEGER NOT NULL,
      PRIMARY KEY (match_id, idx)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      seq INTEGER NOT NULL,
      round INTEGER NOT NULL,
      player_idx INTEGER NOT NULL,
      dart_index INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      dart_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (match_id, seq),
      UNIQUE (match_id, request_id)
    );
  `);
  return db;
}
