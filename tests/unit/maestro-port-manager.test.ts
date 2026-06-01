import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db/schema.ts';
import { TransportPool } from '../../src/transport/pool.ts';
import { HybridBackendTransport } from '../../src/transport/hybrid-backend.ts';
import { MaestroPortManager } from '../../src/maestro/port-manager.ts';

// Construct a fake HybridBackendTransport that records forward calls but
// never spawns a real adb. We override the protocol surface by extending
// the class and stubbing `forward`/`removeForward`.

class FakeBackendTransport extends HybridBackendTransport {
  forwards: { local: string; remote: string }[] = [];
  removed: string[] = [];
  private _stateOverride: 'online' | 'offline' = 'online';

  constructor(serial: string) {
    super({
      serial,
      type: 'emulator',
      adbBinaryPath: '/bin/true',
      backendPort: 0, // unused — we never connect
    });
  }

  override get state(): import('../../src/transport/base.ts').TransportState {
    return this._stateOverride;
  }
  setState(s: 'online' | 'offline'): void {
    this._stateOverride = s;
  }

  override async forward(local: string, remote: string): Promise<void> {
    this.forwards.push({ local, remote });
  }

  override async listForwards(): Promise<import('../../src/transport/base.ts').Forward[]> {
    return this.forwards.map((f) => ({ ...f, source: 'adbpd' as const }));
  }

  override async removeForward(local: string): Promise<void> {
    this.removed.push(local);
    this.forwards = this.forwards.filter((f) => f.local !== local);
  }
}

let db: ReturnType<typeof openDb>;
let pool: TransportPool;
let manager: MaestroPortManager;
let t1: FakeBackendTransport;
let t2: FakeBackendTransport;

beforeEach(() => {
  db = openDb(':memory:');
  pool = new TransportPool();
  t1 = new FakeBackendTransport('emulator-5554');
  t2 = new FakeBackendTransport('R5CN90VPWQW');
  pool.add(t1);
  pool.add(t2);
  // cooldownMs: 0 in tests — the cooldown's behavior is exercised by a
  // dedicated test below; default-on would make every other assertion
  // here racy.
  manager = new MaestroPortManager({ db, pool, rangeStart: 7100, rangeEnd: 7102, cooldownMs: 0 });
});

afterEach(() => {
  db.close();
});

describe('MaestroPortManager', () => {
  test('allocates the first port in range for the first request', async () => {
    const a = await manager.allocate('emulator-5554', 'flow.yaml');
    expect(a.serial).toBe('emulator-5554');
    expect(a.hostPort).toBe(7100);
    expect(a.devicePort).toBe(7001);
    expect(t1.forwards).toEqual([{ local: 'tcp:7100', remote: 'tcp:7001' }]);
  });

  test('two concurrent allocations get distinct ports', async () => {
    const a = await manager.allocate('emulator-5554', 'f1.yaml');
    const b = await manager.allocate('R5CN90VPWQW', 'f2.yaml');
    expect(a.hostPort).toBe(7100);
    expect(b.hostPort).toBe(7101);
    expect(t1.forwards).toEqual([{ local: 'tcp:7100', remote: 'tcp:7001' }]);
    expect(t2.forwards).toEqual([{ local: 'tcp:7101', remote: 'tcp:7001' }]);
  });

  test('release frees the port for reuse', async () => {
    const a = await manager.allocate('emulator-5554', 'f1.yaml');
    await manager.release(a.id);
    expect(t1.removed).toContain('tcp:7100');
    const b = await manager.allocate('emulator-5554', 'f2.yaml');
    expect(b.hostPort).toBe(7100); // freed → reallocated
  });

  test('cooldown keeps a just-released port out of the pool', async () => {
    const cooled = new MaestroPortManager({
      db,
      pool,
      rangeStart: 7100,
      rangeEnd: 7102,
      cooldownMs: 60_000,
    });
    const a = await cooled.allocate('emulator-5554', 'f1.yaml');
    await cooled.release(a.id);
    // Port 7100 is in cooldown → next alloc should rotate to 7101.
    const b = await cooled.allocate('emulator-5554', 'f2.yaml');
    expect(b.hostPort).toBe(7101);
  });

  test('throws when range is exhausted', async () => {
    await manager.allocate('emulator-5554', 'f1.yaml'); // 7100
    await manager.allocate('R5CN90VPWQW', 'f2.yaml'); // 7101
    await manager.allocate('emulator-5554', 'f3.yaml'); // 7102
    await expect(manager.allocate('R5CN90VPWQW', 'f4.yaml')).rejects.toThrow(/no free port/);
  });

  test('throws when device is not in the pool', async () => {
    await expect(manager.allocate('emulator-9999', 'f.yaml')).rejects.toThrow(/not in pool/);
  });

  test('throws when device is offline', async () => {
    t1.setState('offline');
    await expect(manager.allocate('emulator-5554', 'f.yaml')).rejects.toThrow(/offline/);
  });

  test('release is idempotent (second release is a no-op)', async () => {
    const a = await manager.allocate('emulator-5554', 'f.yaml');
    await manager.release(a.id);
    await manager.release(a.id); // should not throw
    expect(t1.removed.filter((l) => l === 'tcp:7100')).toHaveLength(1);
  });

  test('active() returns only un-released allocations', async () => {
    const a = await manager.allocate('emulator-5554', 'f1.yaml');
    const b = await manager.allocate('R5CN90VPWQW', 'f2.yaml');
    expect(manager.active()).toHaveLength(2);
    await manager.release(a.id);
    expect(manager.active()).toHaveLength(1);
    expect(manager.active()[0]?.id).toBe(b.id);
  });

  test('releaseAllInDb marks all active as released but does NOT remove forwards', async () => {
    await manager.allocate('emulator-5554', 'f1.yaml');
    await manager.allocate('R5CN90VPWQW', 'f2.yaml');
    manager.releaseAllInDb();
    expect(manager.active()).toHaveLength(0);
    // forwards untouched (they're cleaned up via transport teardown)
    expect(t1.removed).toEqual([]);
    expect(t2.removed).toEqual([]);
  });
});
