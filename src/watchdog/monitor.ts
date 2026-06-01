// ADBPD — Watchdog monitor.
//
// Pings every device transport on a fixed interval. After N consecutive
// failures the device is marked as wedged: an incident is opened, an
// event is queued for FM telemetry, and the recovery cascade fires
// (handled by the caller via the onWedge callback).

import { getLogger } from '../utils/logger.ts';
import type { DeviceTransport, TransportState } from '../transport/base.ts';
import type { TransportPool } from '../transport/pool.ts';
import type { EventQueue } from '../db/events.ts';

const log = getLogger('watchdog');

export interface WatchdogOptions {
  pool: TransportPool;
  events: EventQueue;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  failThreshold?: number;
  /** Called when a transport hits the fail threshold. */
  onWedge?(transport: DeviceTransport, incidentId: number): Promise<void> | void;
  /** Called when a wedged transport returns to online. */
  onRecover?(transport: DeviceTransport, incidentId: number, durationMs: number): void;
}

export type WedgeType =
  | 'port_conflict'
  | 'device_offline'
  | 'maestro_port_collision'
  | 'emulator_crash'
  | 'usb_authorization'
  | 'protocol_error'
  | 'memory_pressure'
  | 'high_latency';

interface TrackedDevice {
  consecutiveFailures: number;
  highLatencyStrikes: number;
  incidentId: number | null;
  lastRttMs: number | null;
}

export class Watchdog {
  private readonly pool: TransportPool;
  private readonly events: EventQueue;
  private readonly opts: Required<Omit<WatchdogOptions, 'pool' | 'events' | 'onWedge' | 'onRecover'>>;
  private readonly onWedge?: WatchdogOptions['onWedge'];
  private readonly onRecover?: WatchdogOptions['onRecover'];
  private readonly tracked = new Map<string, TrackedDevice>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: WatchdogOptions) {
    this.pool = opts.pool;
    this.events = opts.events;
    this.opts = {
      pingIntervalMs: opts.pingIntervalMs ?? 5_000,
      pingTimeoutMs: opts.pingTimeoutMs ?? 2_000,
      failThreshold: opts.failThreshold ?? 3,
    };
    this.onWedge = opts.onWedge;
    this.onRecover = opts.onRecover;
  }

  start(): void {
    if (this.timer !== undefined) return;
    log.info(this.opts, 'watchdog started');
    this.timer = setInterval(() => void this.tick(), this.opts.pingIntervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one round of pings. Public so it can be invoked manually in tests. */
  async tick(): Promise<void> {
    for (const t of this.pool.all()) {
      void this.pingOne(t);
    }
  }

  private async pingOne(t: DeviceTransport): Promise<void> {
    let tracked = this.tracked.get(t.serial);
    if (tracked === undefined) {
      tracked = { consecutiveFailures: 0, highLatencyStrikes: 0, incidentId: null, lastRttMs: null };
      this.tracked.set(t.serial, tracked);
    }

    let rtt: number | null = null;
    try {
      rtt = await withTimeout(t.ping(), this.opts.pingTimeoutMs);
      tracked.lastRttMs = rtt;
    } catch (err) {
      log.debug(
        { serial: t.serial, err: err instanceof Error ? err.message : String(err) },
        'ping failed',
      );
    }

    if (rtt === null) {
      tracked.consecutiveFailures++;
      if (tracked.consecutiveFailures >= this.opts.failThreshold && tracked.incidentId === null) {
        this.openWedgeIncident(t, 'device_offline');
      }
    } else {
      // Success — reset counters.
      if (tracked.consecutiveFailures > 0 && tracked.incidentId !== null) {
        this.closeWedgeIncident(t, tracked);
      }
      tracked.consecutiveFailures = 0;
      // High-latency tracking.
      if (rtt > 500) {
        tracked.highLatencyStrikes++;
        if (tracked.highLatencyStrikes >= 5 && tracked.incidentId === null) {
          this.openWedgeIncident(t, 'high_latency');
        }
      } else {
        tracked.highLatencyStrikes = 0;
      }
    }
  }

  private openWedgeIncident(t: DeviceTransport, wedgeType: WedgeType): void {
    const id = this.events.openIncident(t.serial, wedgeType, `state=${t.state}`);
    const tracked = this.tracked.get(t.serial);
    if (tracked !== undefined) tracked.incidentId = id;
    this.events.push('device.wedged', t.serial, {
      wedgeType,
      state: t.state,
      lastRttMs: tracked?.lastRttMs,
    });
    log.warn({ serial: t.serial, wedgeType, incidentId: id }, 'wedge detected');
    void this.onWedge?.(t, id);
  }

  private closeWedgeIncident(t: DeviceTransport, tracked: TrackedDevice): void {
    if (tracked.incidentId === null) return;
    const id = tracked.incidentId;
    this.events.closeIncident(id, true, 'ping_recovered');
    this.events.push('device.recovered', t.serial, { incidentId: id });
    log.info({ serial: t.serial, incidentId: id }, 'wedge recovered');
    this.onRecover?.(t, id, 0);
    tracked.incidentId = null;
  }

  getTrackedSnapshot(): Array<{ serial: string; consecutiveFailures: number; lastRttMs: number | null; wedged: boolean }> {
    return Array.from(this.tracked.entries()).map(([serial, t]) => ({
      serial,
      consecutiveFailures: t.consecutiveFailures,
      lastRttMs: t.lastRttMs,
      wedged: t.incidentId !== null,
    }));
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
