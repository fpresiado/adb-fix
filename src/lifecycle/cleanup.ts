// ADBPD — Cleanup sweep on device disconnect / daemon shutdown.
//
// Fires automatically when:
//   1. A transport state transitions to 'offline' or 'disconnected' — sweep
//      that one device (release Maestro ports, kill the process, verify
//      kernel released the port).
//   2. The daemon is shutting down (SIGINT/SIGTERM/SIGBREAK) — sweep all
//      devices then exit.
//
// Per-device sweep does this:
//   a. Look up active Maestro allocations for the serial.
//   b. For each allocation: kill the recorded PID with SIGTERM, wait 1.5s,
//      then SIGKILL if still alive. Maestro is a JVM and can ignore SIGTERM
//      mid-flow.
//   c. Remove the device-side adb forward (idempotent — swallows
//      "listener not found" via removeForward).
//   d. Mark the row released_at.
//   e. Verify the host port is actually released via
//      Get-NetTCPConnection — if it isn't, log a warning so the soak can
//      flag a leak.

import type { Database } from 'bun:sqlite';
import { getLogger } from '../utils/logger.ts';
import type { TransportPool } from '../transport/pool.ts';
import { HybridBackendTransport } from '../transport/hybrid-backend.ts';

const log = getLogger('cleanup');

const SIGTERM_GRACE_MS = 1_500;

interface MaestroRow {
  id: number;
  host_port: number;
  pid: number | null;
}

export interface CleanupOptions {
  db: Database;
  pool: TransportPool;
  /** Override for testing — defaults to PowerShell Get-NetTCPConnection. */
  isPortFree?(port: number): Promise<boolean>;
}

export class DeviceCleaner {
  private readonly db: Database;
  private readonly pool: TransportPool;
  private readonly isPortFree: (port: number) => Promise<boolean>;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(opts: CleanupOptions) {
    this.db = opts.db;
    this.pool = opts.pool;
    this.isPortFree = opts.isPortFree ?? defaultIsPortFree;
  }

  /**
   * Sweep one device. Idempotent and re-entrant — if a sweep is already
   * in flight for the same serial, the new call awaits the existing one.
   */
  async sweepDevice(serial: string): Promise<void> {
    const existing = this.inFlight.get(serial);
    if (existing !== undefined) return existing;
    const p = this.doSweep(serial).finally(() => this.inFlight.delete(serial));
    this.inFlight.set(serial, p);
    return p;
  }

  /** Sweep every serial that currently has an active allocation. */
  async sweepAll(): Promise<void> {
    const serials = this.db
      .query<{ serial: string }, []>(
        'SELECT DISTINCT serial FROM maestro_ports WHERE released_at IS NULL',
      )
      .all()
      .map((r) => r.serial);
    log.info({ count: serials.length }, 'sweepAll: starting');
    await Promise.all(serials.map((s) => this.sweepDevice(s)));
  }

  private async doSweep(serial: string): Promise<void> {
    const rows = this.db
      .query<MaestroRow, [string]>(
        'SELECT id, host_port, pid FROM maestro_ports WHERE serial = ? AND released_at IS NULL',
      )
      .all(serial);
    if (rows.length === 0) {
      log.debug({ serial }, 'sweep: no active allocations');
      return;
    }
    log.info({ serial, count: rows.length }, 'sweep: starting');

    const transport = this.pool.get(serial);
    const hybrid = transport instanceof HybridBackendTransport ? transport : undefined;

    for (const row of rows) {
      // a/b: kill the Maestro PID if recorded.
      if (row.pid !== null) {
        await killProcessGracefully(row.pid);
      }

      // c: remove the device-side forward. Idempotent — removeForward
      // swallows "listener not found" / "device offline".
      if (hybrid !== undefined) {
        try {
          await hybrid.removeForward(`tcp:${row.host_port}`);
        } catch (err) {
          log.warn(
            { serial, hostPort: row.host_port, err: errMsg(err) },
            'removeForward unexpected error during sweep',
          );
        }
      }

      // d: mark released in DB.
      this.db
        .query('UPDATE maestro_ports SET released_at = ? WHERE id = ?')
        .run(Date.now(), row.id);

      // e: verify the host port is actually free at the OS level.
      const free = await this.isPortFree(row.host_port);
      if (!free) {
        log.warn(
          { serial, hostPort: row.host_port },
          'sweep: host port still in use after release — potential leak',
        );
      } else {
        log.debug({ serial, hostPort: row.host_port }, 'sweep: port verified free');
      }
    }
  }
}

async function killProcessGracefully(pid: number): Promise<void> {
  try {
    if (!isPidAlive(pid)) {
      log.debug({ pid }, 'kill: already gone');
      return;
    }
  } catch {
    /* fall through to kill */
  }

  // Step 1: polite SIGTERM (on Windows this maps to a graceful exit signal).
  try {
    process.kill(pid, 'SIGTERM');
    log.info({ pid }, 'kill: SIGTERM sent');
  } catch (err) {
    const msg = errMsg(err);
    if (msg.includes('ESRCH')) {
      log.debug({ pid }, 'kill: ESRCH (already dead)');
      return;
    }
    log.warn({ pid, err: msg }, 'kill: SIGTERM failed');
  }

  await sleep(SIGTERM_GRACE_MS);

  // Step 2: SIGKILL if it's still alive.
  try {
    if (!isPidAlive(pid)) {
      log.debug({ pid }, 'kill: exited within grace window');
      return;
    }
    process.kill(pid, 'SIGKILL');
    log.warn({ pid }, 'kill: SIGKILL required after SIGTERM grace');
  } catch (err) {
    const msg = errMsg(err);
    if (!msg.includes('ESRCH')) {
      log.warn({ pid, err: msg }, 'kill: SIGKILL failed');
    }
  }
}

/**
 * `process.kill(pid, 0)` returns true if the process exists, throws ESRCH
 * if not. We wrap so callers get a clean boolean.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (errMsg(err).includes('EPERM')) return true;
    return false;
  }
}

/**
 * Default Windows port-free check via Get-NetTCPConnection. Returns true
 * if no TCP connection (any state) exists on the loopback for this port.
 *
 * This is the authoritative "did the kernel actually release it" check —
 * SQLite tells us we marked it released, but a TIME_WAIT or CLOSE_WAIT
 * socket might still hold the address.
 */
async function defaultIsPortFree(port: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue | Measure-Object).Count`,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return Number.parseInt(out, 10) === 0;
  } catch (err) {
    log.debug({ port, err: errMsg(err) }, 'isPortFree probe failed');
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
