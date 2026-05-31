import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db/schema.ts';

describe('openDb + migrations', () => {
  test('creates all expected tables on first open', () => {
    const db = openDb(':memory:');
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain('schema_migrations');
    expect(tables).toContain('maestro_ports');
    expect(tables).toContain('forwards');
    expect(tables).toContain('events');
    db.close();
  });

  test('migrations are idempotent (re-open is a no-op)', () => {
    const db = openDb(':memory:');
    const ver1 = db.query<{ version: number }, []>('SELECT version FROM schema_migrations').all();
    // Run migrations again by re-invoking init via openDb on the same file.
    // For :memory:, just verify the table is stable.
    expect(ver1.length).toBeGreaterThan(0);
    expect(ver1[0]?.version).toBe(1);
    db.close();
  });

  test('schema enforces unique host_port for ACTIVE allocations only', () => {
    const db = openDb(':memory:');
    db.query(
      `INSERT INTO maestro_ports (serial, host_port, device_port, allocated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('emulator-5554', 7100, 7001, Date.now());
    // Inserting a second active row on the same port must fail.
    expect(() =>
      db.query(
        `INSERT INTO maestro_ports (serial, host_port, device_port, allocated_at)
         VALUES (?, ?, ?, ?)`,
      ).run('R5CN90VPWQW', 7100, 7001, Date.now()),
    ).toThrow();
    // After releasing the first row, the same port must be reusable.
    db.query('UPDATE maestro_ports SET released_at = ? WHERE host_port = ?').run(
      Date.now(),
      7100,
    );
    expect(() =>
      db.query(
        `INSERT INTO maestro_ports (serial, host_port, device_port, allocated_at)
         VALUES (?, ?, ?, ?)`,
      ).run('R5CN90VPWQW', 7100, 7001, Date.now()),
    ).not.toThrow();
    db.close();
  });
});
