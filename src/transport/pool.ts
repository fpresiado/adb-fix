// ADBPD — Device transport pool (single source of truth for device state).
//
// P1 ships with an in-memory empty pool. P2 adds emulator transports, P3 adds
// USB transports. The router consults the pool for `host:devices` responses.

import { getLogger } from '../utils/logger.ts';
import type { DeviceTransport, TransportState, TransportType } from './base.ts';

const log = getLogger('transport-pool');

export interface DeviceListEntry {
  serial: string;
  state: TransportState;
  type: TransportType;
  model?: string;
  product?: string;
}

export class TransportPool {
  private readonly transports = new Map<string, DeviceTransport>();
  private readonly listeners = new Set<() => void>();

  add(transport: DeviceTransport): void {
    if (this.transports.has(transport.serial)) {
      log.warn({ serial: transport.serial }, 'transport already in pool; replacing');
    }
    this.transports.set(transport.serial, transport);
    transport.on('state-change', () => this.notify());
    log.info({ serial: transport.serial, type: transport.type }, 'transport added');
    this.notify();
  }

  remove(serial: string): void {
    if (this.transports.delete(serial)) {
      log.info({ serial }, 'transport removed');
      this.notify();
    }
  }

  get(serial: string): DeviceTransport | undefined {
    return this.transports.get(serial);
  }

  all(): DeviceTransport[] {
    return Array.from(this.transports.values());
  }

  /** Return the first transport matching the selector (for transport-any/usb/local). */
  pick(mode: 'any' | 'usb' | 'local'): DeviceTransport | undefined {
    for (const t of this.transports.values()) {
      if (t.state !== 'online') continue;
      if (mode === 'any') return t;
      if (mode === 'usb' && t.type === 'usb') return t;
      if (mode === 'local' && t.type === 'emulator') return t;
    }
    return undefined;
  }

  list(): DeviceListEntry[] {
    return Array.from(this.transports.values()).map((t) => ({
      serial: t.serial,
      state: t.state,
      type: t.type,
    }));
  }

  onChange(handler: () => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private notify(): void {
    for (const handler of this.listeners) {
      try {
        handler();
      } catch (err) {
        log.error({ err }, 'transport pool listener threw');
      }
    }
  }
}
