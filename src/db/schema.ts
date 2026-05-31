// ADBPD — SQLite schema definitions + migrations.
//
// Uses bun:sqlite (built-in to Bun). Schema is applied lazily at first
// open via initDb(). Each migration is run inside a transaction and
// recorded in `schema_migrations`.

import { Database } from 'bun:sqlite';
import { getLogger } from '../utils/logger.ts';

const log = getLogger('db');

interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS maestro_ports (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        serial       TEXT NOT NULL,
        host_port    INTEGER NOT NULL,
        device_port  INTEGER NOT NULL DEFAULT 7001,
        flow_file    TEXT,
        pid          INTEGER,
        allocated_at INTEGER NOT NULL,
        released_at  INTEGER
      );

      -- Only enforce host_port uniqueness for ACTIVE allocations. A released
      -- row can hold any port; new allocations look up against the partial
      -- index, allowing port reuse after release.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_ports_active_unique
        ON maestro_ports (host_port) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_maestro_ports_serial_active
        ON maestro_ports (serial) WHERE released_at IS NULL;

      CREATE TABLE IF NOT EXISTS forwards (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        serial     TEXT NOT NULL,
        local      TEXT NOT NULL,
        remote     TEXT NOT NULL,
        source     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        removed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        serial     TEXT,
        payload    TEXT NOT NULL,
        fm_synced  INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_unsynced
        ON events (fm_synced, created_at) WHERE fm_synced = 0;
    `,
  },
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Database): void {
  // The schema_migrations table itself may not exist on first open.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const rows = db.query<{ version: number }, []>('SELECT version FROM schema_migrations').all();
  const applied = new Set(rows.map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    log.info({ version: m.version }, 'applying migration');
    db.transaction(() => {
      db.exec(m.up);
      db.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
    })();
  }
}
