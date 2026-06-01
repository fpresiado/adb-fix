// ADBPD — FM telemetry bridge.
//
// Polls the SQLite events queue, pushes batches to FM, marks rows as synced.
// While disabled it does nothing (events still accumulate, ready for replay).

import { getLogger } from '../utils/logger.ts';
import type { FmClient } from './client.ts';
import type { EventQueue } from '../db/events.ts';

const log = getLogger('fm-telemetry');

export interface FmTelemetryOptions {
  events: EventQueue;
  client: FmClient;
  intervalMs?: number;
  batchSize?: number;
}

export class FmTelemetry {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly events: EventQueue;
  private readonly client: FmClient;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private inFlight = false;

  constructor(opts: FmTelemetryOptions) {
    this.events = opts.events;
    this.client = opts.client;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.batchSize = opts.batchSize ?? 50;
  }

  start(): void {
    if (this.timer !== undefined) return;
    if (!this.client.enabled) {
      log.info('FM telemetry start: client disabled, queue will accumulate locally');
      return;
    }
    log.info({ intervalMs: this.intervalMs }, 'FM telemetry started');
    this.timer = setInterval(() => void this.flushOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Public for tests + manual replay after flipping fm.enabled. */
  async flushOnce(): Promise<{ pushed: number; failed: number }> {
    if (!this.client.enabled) return { pushed: 0, failed: 0 };
    if (this.inFlight) return { pushed: 0, failed: 0 };
    this.inFlight = true;
    let pushed = 0;
    let failed = 0;
    try {
      const batch = this.events.pendingForFm(this.batchSize);
      if (batch.length === 0) return { pushed, failed };
      const synced: number[] = [];
      for (const ev of batch) {
        try {
          const resp = await this.client.request({
            method: 'POST',
            path: '/api/hub/events',
            body: {
              event: ev.eventType,
              serial: ev.serial,
              payload: ev.payload,
              timestamp: ev.createdAt,
            },
          });
          if (resp.status >= 200 && resp.status < 300) {
            synced.push(ev.id);
            pushed++;
          } else {
            log.warn({ id: ev.id, status: resp.status }, 'FM rejected event');
            failed++;
          }
        } catch (err) {
          failed++;
          log.warn({ id: ev.id, err: err instanceof Error ? err.message : String(err) }, 'FM push error');
          break; // stop on first network failure; retry next tick
        }
      }
      if (synced.length > 0) this.events.markSynced(synced);
    } finally {
      this.inFlight = false;
    }
    return { pushed, failed };
  }
}
