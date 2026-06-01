import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db/schema.ts';
import { EventQueue } from '../../src/db/events.ts';
import { TransportPool } from '../../src/transport/pool.ts';
import { Watchdog } from '../../src/watchdog/monitor.ts';
import type {
  DeviceProperties,
  DeviceTransport,
  Forward,
  InstallOptions,
  ShellResult,
  TransportState,
  TransportType,
} from '../../src/transport/base.ts';

class FakeTransport implements DeviceTransport {
  readonly serial: string;
  readonly type: TransportType = 'emulator';
  state: TransportState = 'online';
  pingResult: 'success' | 'fail' | 'slow' = 'success';
  pingRttMs = 5;
  reconnectShouldSucceed = true;
  reconnectCalls = 0;

  constructor(serial: string) {
    this.serial = serial;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async reconnect(): Promise<void> {
    this.reconnectCalls++;
    if (!this.reconnectShouldSucceed) throw new Error('reconnect refused');
    this.pingResult = 'success';
    this.state = 'online';
  }
  async shell(_: string): Promise<ShellResult> {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  async push(): Promise<void> {}
  async pull(): Promise<void> {}
  async install(_p: string, _o?: InstallOptions): Promise<void> {}
  async forward(): Promise<void> {}
  async listForwards(): Promise<Forward[]> {
    return [];
  }
  async removeForward(): Promise<void> {}

  async ping(): Promise<number> {
    if (this.pingResult === 'fail') throw new Error('simulated ping fail');
    if (this.pingResult === 'slow') {
      await new Promise((r) => setTimeout(r, this.pingRttMs));
    }
    return this.pingRttMs;
  }
  async getProperties(): Promise<DeviceProperties> {
    return {};
  }
  on(): void {}
  off(): void {}
}

let db: ReturnType<typeof openDb>;
let events: EventQueue;
let pool: TransportPool;
let t: FakeTransport;

beforeEach(() => {
  db = openDb(':memory:');
  events = new EventQueue(db);
  pool = new TransportPool();
  t = new FakeTransport('emulator-5554');
  pool.add(t);
});
afterEach(() => {
  db.close();
});

describe('Watchdog', () => {
  test('healthy device produces no wedge events after multiple ticks', async () => {
    const wd = new Watchdog({ pool, events, pingIntervalMs: 5_000, failThreshold: 3 });
    await wd.tick();
    await wd.tick();
    await wd.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(events.pendingCount()).toBe(0);
  });

  test('failing device opens a wedge after threshold consecutive failures', async () => {
    const wd = new Watchdog({ pool, events, pingTimeoutMs: 50, failThreshold: 3 });
    t.pingResult = 'fail';
    let wedgeCalls = 0;
    const wd2 = new Watchdog({
      pool,
      events,
      pingTimeoutMs: 50,
      failThreshold: 3,
      onWedge: () => {
        wedgeCalls++;
      },
    });
    void wd; // unused — we use wd2
    await wd2.tick();
    await wd2.tick();
    expect(events.pendingCount()).toBe(0); // 2 fails, threshold 3
    await wd2.tick();
    await new Promise((r) => setTimeout(r, 80));
    expect(wedgeCalls).toBe(1);
    const pending = events.pendingForFm();
    expect(pending[0]?.eventType).toBe('device.wedged');
  });

  test('a recovered device closes its incident and emits device.recovered', async () => {
    let recoveredCalls = 0;
    const wd = new Watchdog({
      pool,
      events,
      pingTimeoutMs: 50,
      failThreshold: 2,
      onRecover: () => {
        recoveredCalls++;
      },
    });
    t.pingResult = 'fail';
    await wd.tick();
    await wd.tick(); // wedge opens
    await new Promise((r) => setTimeout(r, 60));
    t.pingResult = 'success';
    await wd.tick(); // success → recovery
    await new Promise((r) => setTimeout(r, 60));
    expect(recoveredCalls).toBe(1);
    const wedgeEvent = events.pendingForFm().find((e) => e.eventType === 'device.wedged');
    const recoverEvent = events.pendingForFm().find((e) => e.eventType === 'device.recovered');
    expect(wedgeEvent).toBeDefined();
    expect(recoverEvent).toBeDefined();
  });

  test('getTrackedSnapshot reflects state correctly', async () => {
    const wd = new Watchdog({ pool, events, pingTimeoutMs: 50, failThreshold: 2 });
    t.pingResult = 'fail';
    await wd.tick();
    await new Promise((r) => setTimeout(r, 60));
    const snap = wd.getTrackedSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.serial).toBe('emulator-5554');
    expect(snap[0]?.consecutiveFailures).toBeGreaterThanOrEqual(1);
  });
});
