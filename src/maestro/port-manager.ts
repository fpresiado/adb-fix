// ADBPD — Maestro port allocator.
//
// Maestro hardcodes gRPC port 7001 inside the device-side test driver.
// When two Maestro sessions run in parallel, both attempt to own the same
// `adb forward host:7001 → device:7001`, producing UNAVAILABLE errors.
//
// We allocate a unique host port per (serial, session) pair from a
// configured range (default 7100..7200), create the forward via the
// device's transport, and persist the allocation in SQLite so we can
// reconcile after a daemon restart.
//
// Lifecycle:
//   manager.allocate(serial)            → { id, hostPort }
//   <run maestro with --device serial>
//   manager.release(id)                 → kills the forward + marks released

import type { Database } from 'bun:sqlite';
import { getLogger } from '../utils/logger.ts';
import type { TransportPool } from '../transport/pool.ts';
import { HybridBackendTransport } from '../transport/hybrid-backend.ts';

const log = getLogger('maestro-ports');

export interface MaestroPortAllocation {
  id: number;
  serial: string;
  hostPort: number;
  devicePort: number;
}

export interface MaestroPortManagerOptions {
  db: Database;
  pool: TransportPool;
  rangeStart?: number;
  rangeEnd?: number;
  devicePort?: number;
}

export class MaestroPortManager {
  private readonly db: Database;
  private readonly pool: TransportPool;
  private readonly rangeStart: number;
  private readonly rangeEnd: number;
  private readonly devicePort: number;

  constructor(opts: MaestroPortManagerOptions) {
    this.db = opts.db;
    this.pool = opts.pool;
    this.rangeStart = opts.rangeStart ?? 7100;
    this.rangeEnd = opts.rangeEnd ?? 7200;
    this.devicePort = opts.devicePort ?? 7001;
  }

  /**
   * Allocate a port for `serial`, create the device-side forward, and
   * return the allocation record. The caller (the process wrapper) is
   * responsible for invoking `release(id)` when the session ends.
   */
  async allocate(serial: string, flowFile?: string, pid?: number): Promise<MaestroPortAllocation> {
    const transport = this.pool.get(serial);
    if (transport === undefined) {
      throw new Error(`MaestroPortManager.allocate: device ${serial} not in pool`);
    }
    if (transport.state !== 'online') {
      throw new Error(
        `MaestroPortManager.allocate: device ${serial} is ${transport.state}, need online`,
      );
    }
    if (!(transport instanceof HybridBackendTransport)) {
      throw new Error(
        `MaestroPortManager.allocate: device ${serial} type ${transport.type} not yet supported`,
      );
    }

    const hostPort = this.findFreePort();
    log.info({ serial, hostPort, devicePort: this.devicePort, flowFile }, 'allocating maestro port');

    try {
      await transport.forward(`tcp:${hostPort}`, `tcp:${this.devicePort}`);
    } catch (err) {
      throw new Error(
        `MaestroPortManager.allocate: forward tcp:${hostPort}->tcp:${this.devicePort} on ${serial} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const now = Date.now();
    const stmt = this.db.query<{ id: number }, [string, number, number, string | null, number | null, number]>(
      `INSERT INTO maestro_ports (serial, host_port, device_port, flow_file, pid, allocated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`,
    );
    const row = stmt.get(serial, hostPort, this.devicePort, flowFile ?? null, pid ?? null, now);
    if (row === null) throw new Error('failed to insert maestro_ports row');

    return {
      id: row.id,
      serial,
      hostPort,
      devicePort: this.devicePort,
    };
  }

  /**
   * Release an allocation: remove the device forward and mark the row
   * released. Safe to call multiple times — subsequent releases no-op.
   */
  async release(id: number): Promise<void> {
    const row = this.db
      .query<
        { serial: string; host_port: number; released_at: number | null },
        [number]
      >('SELECT serial, host_port, released_at FROM maestro_ports WHERE id = ?')
      .get(id);
    if (row === null) {
      log.warn({ id }, 'release: no such allocation');
      return;
    }
    if (row.released_at !== null) {
      log.debug({ id }, 'release: already released, no-op');
      return;
    }

    const transport = this.pool.get(row.serial);
    if (transport instanceof HybridBackendTransport) {
      try {
        await transport.removeForward(`tcp:${row.host_port}`);
      } catch (err) {
        log.warn(
          { id, serial: row.serial, hostPort: row.host_port, err: errMsg(err) },
          'release: removeForward failed (continuing)',
        );
      }
    }

    this.db
      .query('UPDATE maestro_ports SET released_at = ? WHERE id = ?')
      .run(Date.now(), id);
    log.info({ id, serial: row.serial, hostPort: row.host_port }, 'maestro port released');
  }

  /** Return the current active allocation table. */
  active(): MaestroPortAllocation[] {
    return this.db
      .query<
        { id: number; serial: string; host_port: number; device_port: number },
        []
      >(
        'SELECT id, serial, host_port, device_port FROM maestro_ports WHERE released_at IS NULL',
      )
      .all()
      .map((r) => ({
        id: r.id,
        serial: r.serial,
        hostPort: r.host_port,
        devicePort: r.device_port,
      }));
  }

  /**
   * Mark every still-active allocation as released. Used at daemon shutdown.
   * Does NOT attempt to remove forwards (transports may already be torn down).
   */
  releaseAllInDb(): void {
    this.db
      .query('UPDATE maestro_ports SET released_at = ? WHERE released_at IS NULL')
      .run(Date.now());
  }

  private findFreePort(): number {
    const used = new Set(
      this.db
        .query<{ host_port: number }, []>(
          'SELECT host_port FROM maestro_ports WHERE released_at IS NULL',
        )
        .all()
        .map((r) => r.host_port),
    );
    for (let port = this.rangeStart; port <= this.rangeEnd; port++) {
      if (!used.has(port)) return port;
    }
    throw new Error(
      `MaestroPortManager: no free port in [${this.rangeStart}, ${this.rangeEnd}]`,
    );
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
