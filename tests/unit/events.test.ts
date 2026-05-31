import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db/schema.ts';
import { EventQueue } from '../../src/db/events.ts';

let db: ReturnType<typeof openDb>;
let q: EventQueue;

beforeEach(() => {
  db = openDb(':memory:');
  q = new EventQueue(db);
});
afterEach(() => {
  db.close();
});

describe('EventQueue', () => {
  test('push then pendingForFm returns the queued event', () => {
    const id = q.push('device.online', 'emulator-5554', { sdk: 34 });
    const pending = q.pendingForFm();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id,
      eventType: 'device.online',
      serial: 'emulator-5554',
      fmSynced: false,
    });
    expect(pending[0]?.payload).toEqual({ sdk: 34 });
  });

  test('markSynced removes the row from pendingForFm', () => {
    const a = q.push('device.online', 'em1', {});
    const b = q.push('device.online', 'em2', {});
    q.markSynced([a]);
    const pending = q.pendingForFm();
    expect(pending.map((e) => e.id)).toEqual([b]);
  });

  test('pendingCount tracks the queue size', () => {
    expect(q.pendingCount()).toBe(0);
    q.push('device.online', 'em1', {});
    q.push('device.offline', 'em1', {});
    expect(q.pendingCount()).toBe(2);
    q.markSynced([1]);
    expect(q.pendingCount()).toBe(1);
  });

  test('openIncident + closeIncident records duration', async () => {
    const id = q.openIncident('em1', 'device_offline', 'state=offline');
    await new Promise((r) => setTimeout(r, 5));
    q.closeIncident(id, true, 'ping_recovered');
    const row = db
      .query<{ resolved_at: number; auto_resolved: number; resolution: string; duration_ms: number }, [number]>(
        'SELECT resolved_at, auto_resolved, resolution, duration_ms FROM incidents WHERE id = ?',
      )
      .get(id);
    expect(row).not.toBeNull();
    expect(row?.auto_resolved).toBe(1);
    expect(row?.resolution).toBe('ping_recovered');
    expect(row?.duration_ms ?? 0).toBeGreaterThanOrEqual(0);
  });

  test('payload that contains nested objects round-trips through JSON', () => {
    q.push('emulator.started', 'em1', { numaNode: 0, mask: '0xfff', meta: { cores: 12 } });
    const out = q.pendingForFm()[0]!.payload as Record<string, unknown>;
    expect(out).toEqual({ numaNode: 0, mask: '0xfff', meta: { cores: 12 } });
  });
});
