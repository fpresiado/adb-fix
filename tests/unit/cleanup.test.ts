import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db/schema.ts';
import { TransportPool } from '../../src/transport/pool.ts';
import { DeviceCleaner } from '../../src/lifecycle/cleanup.ts';
import { HybridBackendTransport } from '../../src/transport/hybrid-backend.ts';
import { isHarmlessForwardError } from '../../src/transport/hybrid-backend.ts';

// We can't easily construct a HybridBackendTransport in-process without
// spawning adb. The cleanup module's removeForward call site is guarded by
// `instanceof HybridBackendTransport` — when the pool entry is anything else
// (or absent), the forward removal step is skipped. We exercise the path
// where no transport is in the pool: the row still gets released, the PID
// kill still fires, the port-free probe still runs.

let db: ReturnType<typeof openDb>;
let pool: TransportPool;
let cleaner: DeviceCleaner;

beforeEach(() => {
  db = openDb(':memory:');
  pool = new TransportPool();
});
afterEach(() => {
  db.close();
});

describe('isHarmlessForwardError', () => {
  test('matches "listener not found" patterns', () => {
    expect(isHarmlessForwardError(new Error("listener 'tcp:7100' not found"))).toBe(true);
    expect(isHarmlessForwardError(new Error('cannot remove listener'))).toBe(true);
  });
  test('matches device-gone patterns', () => {
    expect(isHarmlessForwardError(new Error("device 'emulator-5554' not found"))).toBe(true);
    expect(isHarmlessForwardError(new Error('device offline'))).toBe(true);
    expect(isHarmlessForwardError(new Error('no devices/emulators found'))).toBe(true);
  });
  test('does NOT match generic protocol errors', () => {
    expect(isHarmlessForwardError(new Error('backend bad status: WTF'))).toBe(false);
    expect(isHarmlessForwardError(new Error('connect ECONNREFUSED'))).toBe(false);
  });
});

describe('DeviceCleaner.sweepDevice', () => {
  test('marks all rows for the serial released, even with no transport', async () => {
    db.query(
      `INSERT INTO maestro_ports (serial, host_port, device_port, allocated_at)
       VALUES ('emulator-5554', 7100, 7001, ?)`,
    ).run(Date.now());
    db.query(
      `INSERT INTO maestro_ports (serial, host_port, device_port, allocated_at)
       VALUES ('emulator-5554', 7101, 7001, ?)`,
    ).run(Date.now());

    cleaner = new DeviceCleaner({
      db,
      pool,
      isPortFree: async () => true,
    });
    await cleaner.sweepDevice('emulator-5554');

    const released = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM maestro_ports WHERE serial='emulator-5554' AND released_at IS NOT NULL",
      )
      .get();
    expect(released?.n).toBe(2);
  });

  test('is idempotent / re-entrant — concurrent calls collapse', async () => {
    db.query(
      `INSERT INTO maestro_ports (serial, host_port, device_port, allocated_at)
       VALUES ('emulator-5554', 7100, 7001, ?)`,
    ).run(Date.now());
    let probeCalls = 0;
    cleaner = new DeviceCleaner({
      db,
      pool,
      isPortFree: async () => {
        probeCalls++;
        await new Promise((r) => setTimeout(r, 50));
        return true;
      },
    });
    await Promise.all([
      cleaner.sweepDevice('emulator-5554'),
      cleaner.sweepDevice('emulator-5554'),
      cleaner.sweepDevice('emulator-5554'),
    ]);
    // First call enters the work; the other two await the in-flight
    // promise → the probe only runs once.
    expect(probeCalls).toBe(1);
  });

  test('does nothing when no active rows exist', async () => {
    cleaner = new DeviceCleaner({ db, pool, isPortFree: async () => true });
    await cleaner.sweepDevice('emulator-5554');  // does not throw
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM maestro_ports').get();
    expect(count?.n).toBe(0);
  });
});

describe('DeviceCleaner.sweepAll', () => {
  test('sweeps every distinct serial with active allocations', async () => {
    db.query(
      `INSERT INTO maestro_ports (serial, host_port, device_port, allocated_at)
       VALUES ('em1', 7100, 7001, ?)`,
    ).run(Date.now());
    db.query(
      `INSERT INTO maestro_ports (serial, host_port, device_port, allocated_at)
       VALUES ('em2', 7101, 7001, ?)`,
    ).run(Date.now());
    cleaner = new DeviceCleaner({ db, pool, isPortFree: async () => true });
    await cleaner.sweepAll();
    const remaining = db
      .query<{ n: number }, []>(
        'SELECT COUNT(*) AS n FROM maestro_ports WHERE released_at IS NULL',
      )
      .get();
    expect(remaining?.n).toBe(0);
  });
});
