// ADBPD — telemetry event queue + recovery incidents (SQLite-backed).
//
// All device-state changes, wedges, recoveries, etc. are enqueued here.
// When FM.exe is enabled (config.fm.enabled), the bridge polls and
// publishes; until then, rows just accumulate (fm_synced = 0) and can
// be replayed when the flag flips. The WebSocket hub also subscribes
// via onPush so live clients see events as they happen.

import type { Database } from 'bun:sqlite';
import { getLogger } from '../utils/logger.ts';

const log = getLogger('events');

export type EventType =
  | 'device.online'
  | 'device.offline'
  | 'device.wedged'
  | 'device.recovered'
  | 'emulator.started'
  | 'emulator.stopped'
  | 'maestro.started'
  | 'maestro.completed'
  | 'proxy.error'
  | 'health.pulse';

export interface QueuedEvent {
  id: number;
  eventType: EventType;
  serial: string | null;
  payload: Record<string, unknown>;
  fmSynced: boolean;
  createdAt: number;
}

export type EventListener = (
  eventType: EventType,
  serial: string | null,
  payload: Record<string, unknown>,
  id: number,
) => void;

interface RawRow {
  id: number;
  event_type: EventType;
  serial: string | null;
  payload: string;
  fm_synced: number;
  created_at: number;
}

export class EventQueue {
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly db: Database) {
    // Migration v2 (in events.ts to keep co-located): add incidents.
    db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        serial        TEXT NOT NULL,
        incident_type TEXT NOT NULL,
        detail        TEXT,
        auto_resolved INTEGER NOT NULL DEFAULT 0,
        resolution    TEXT,
        duration_ms   INTEGER,
        created_at    INTEGER NOT NULL,
        resolved_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_serial_active
        ON incidents (serial) WHERE resolved_at IS NULL;
    `);
  }

  push(eventType: EventType, serial: string | null, payload: Record<string, unknown>): number {
    const row = this.db
      .query<{ id: number }, [string, string | null, string, number]>(
        `INSERT INTO events (event_type, serial, payload, created_at)
         VALUES (?, ?, ?, ?) RETURNING id`,
      )
      .get(eventType, serial, JSON.stringify(payload), Date.now());
    if (row === null) throw new Error('events insert failed');
    log.debug({ id: row.id, eventType, serial }, 'event queued');
    for (const l of this.listeners) {
      try {
        l(eventType, serial, payload, row.id);
      } catch (err) {
        log.warn({ err }, 'event listener threw');
      }
    }
    return row.id;
  }

  onPush(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pendingForFm(limit = 100): QueuedEvent[] {
    return this.db
      .query<RawRow, [number]>(
        `SELECT id, event_type, serial, payload, fm_synced, created_at
         FROM events WHERE fm_synced = 0 ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit)
      .map(rowToEvent);
  }

  /** Page through events for /api/events. Newest first. */
  recent(limit = 100, sinceId?: number): QueuedEvent[] {
    if (sinceId === undefined) {
      return this.db
        .query<RawRow, [number]>(
          `SELECT id, event_type, serial, payload, fm_synced, created_at
           FROM events ORDER BY id DESC LIMIT ?`,
        )
        .all(limit)
        .map(rowToEvent);
    }
    return this.db
      .query<RawRow, [number, number]>(
        `SELECT id, event_type, serial, payload, fm_synced, created_at
         FROM events WHERE id > ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sinceId, limit)
      .map(rowToEvent);
  }

  markSynced(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .query(`UPDATE events SET fm_synced = 1 WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  pendingCount(): number {
    const row = this.db
      .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM events WHERE fm_synced = 0')
      .get();
    return row?.c ?? 0;
  }

  openIncident(serial: string, type: string, detail?: string): number {
    const row = this.db
      .query<{ id: number }, [string, string, string | null, number]>(
        `INSERT INTO incidents (serial, incident_type, detail, created_at)
         VALUES (?, ?, ?, ?) RETURNING id`,
      )
      .get(serial, type, detail ?? null, Date.now());
    if (row === null) throw new Error('incidents insert failed');
    return row.id;
  }

  closeIncident(id: number, autoResolved: boolean, resolution?: string): void {
    const opened = this.db
      .query<{ created_at: number }, [number]>(
        'SELECT created_at FROM incidents WHERE id = ?',
      )
      .get(id);
    const now = Date.now();
    const duration = opened === null ? null : now - opened.created_at;
    this.db
      .query(
        `UPDATE incidents
         SET resolved_at = ?, auto_resolved = ?, resolution = ?, duration_ms = ?
         WHERE id = ?`,
      )
      .run(now, autoResolved ? 1 : 0, resolution ?? null, duration, id);
  }

  listIncidents(opts: { activeOnly?: boolean; limit?: number } = {}): Array<{
    id: number;
    serial: string;
    incidentType: string;
    detail: string | null;
    autoResolved: boolean;
    resolution: string | null;
    durationMs: number | null;
    createdAt: number;
    resolvedAt: number | null;
  }> {
    const where = opts.activeOnly === true ? 'WHERE resolved_at IS NULL' : '';
    const limit = opts.limit ?? 100;
    type R = {
      id: number;
      serial: string;
      incident_type: string;
      detail: string | null;
      auto_resolved: number;
      resolution: string | null;
      duration_ms: number | null;
      created_at: number;
      resolved_at: number | null;
    };
    return this.db
      .query<R, [number]>(
        `SELECT id, serial, incident_type, detail, auto_resolved, resolution,
                duration_ms, created_at, resolved_at
         FROM incidents ${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => ({
        id: r.id,
        serial: r.serial,
        incidentType: r.incident_type,
        detail: r.detail,
        autoResolved: r.auto_resolved === 1,
        resolution: r.resolution,
        durationMs: r.duration_ms,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }));
  }
}

function rowToEvent(r: RawRow): QueuedEvent {
  return {
    id: r.id,
    eventType: r.event_type,
    serial: r.serial,
    payload: safeParse(r.payload),
    fmSynced: r.fm_synced === 1,
    createdAt: r.created_at,
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _raw: s };
  }
}
