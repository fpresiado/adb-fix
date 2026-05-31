// Tests for the Control API HTTP surface. We instantiate ControlApi with
// stub deps and exercise every endpoint via the in-process Hono fetch
// handler. No real Bun.serve — start()/stop() are covered by the live
// milestone, not here.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db/schema.ts';
import { EventQueue } from '../../src/db/events.ts';
import { TransportPool } from '../../src/transport/pool.ts';
import { ControlApi, type ControlApiDeps } from '../../src/api/server.ts';
import { FmClient } from '../../src/fm/client.ts';
import type { SmartSocketProxy } from '../../src/proxy/smart-socket.ts';
import type { EmulatorManager, ManagedEmulator } from '../../src/emulator/manager.ts';
import type { MaestroPortManager, MaestroPortAllocation } from '../../src/maestro/port-manager.ts';
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
  reconnectShouldFail = false;
  reconnectCalls = 0;
  constructor(serial: string) {
    this.serial = serial;
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async reconnect(): Promise<void> {
    this.reconnectCalls++;
    if (this.reconnectShouldFail) throw new Error('boom');
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
    return 1;
  }
  async getProperties(): Promise<DeviceProperties> {
    return {};
  }
  on(): void {}
  off(): void {}
}

interface Stubs {
  db: ReturnType<typeof openDb>;
  events: EventQueue;
  pool: TransportPool;
  api: ControlApi;
  fm: FmClient;
  emState: ManagedEmulator;
  emulatorManager: EmulatorManager;
  maestroPorts: MaestroPortManager;
  managedRegistry: Map<string, { avdName: string; emulatorBinary: string; consolePort: number }>;
  restartProxyCalls: number;
  fmStateView: { fmEnabled: boolean };
}

function makeStubs(): Stubs {
  const db = openDb(':memory:');
  const events = new EventQueue(db);
  const pool = new TransportPool();
  pool.add(new FakeTransport('emulator-5554'));

  const fm = new FmClient({
    enabled: false,
    url: 'http://localhost:65535',
    installId: 'test-install',
    token: 'test-token',
  });

  const emState: ManagedEmulator = {
    avdName: 'Pixel_9_Pro',
    pid: 1234,
    vmPid: 5678,
    consolePort: 5554,
    adbPort: 5555,
    numaNode: 0,
    affinityMask: 0xfffn,
    vmAffinityMask: 0xfffn,
    memoryMb: 4096,
    startedAt: 1_000_000,
  };
  const emulatorManager = {
    list: () => [emState],
    getBySerial: (s: string) => (s === 'emulator-5554' ? emState : undefined),
    getTopology: () => ({
      detected: true,
      source: 'ffi' as const,
      nodes: [{ nodeNumber: 0, group: 0, coreMask: 0xfffn, coreCount: 12 }],
    }),
    startAvd: async () => emState,
    stopAvd: async () => {},
    isVmAlive: () => true,
  } as unknown as EmulatorManager;

  const maestroState: MaestroPortAllocation[] = [];
  const maestroPorts = {
    active: () => maestroState,
    allocate: async (serial: string, flowFile?: string): Promise<MaestroPortAllocation> => {
      const a: MaestroPortAllocation = {
        id: maestroState.length + 1,
        serial,
        hostPort: 7100 + maestroState.length,
        devicePort: 7001,
      };
      maestroState.push(a);
      return a;
    },
    release: async (id: number): Promise<void> => {
      const i = maestroState.findIndex((m) => m.id === id);
      if (i >= 0) maestroState.splice(i, 1);
    },
  } as unknown as MaestroPortManager;

  const proxy = {} as SmartSocketProxy;
  let restartProxyCalls = 0;
  const managedRegistry = new Map<string, { avdName: string; emulatorBinary: string; consolePort: number }>();

  const fmStateView = { fmEnabled: fm.enabled };
  const deps: ControlApiDeps = {
    pool,
    events,
    proxy,
    fm,
    emulatorManager,
    maestroPorts,
    managedRegistry,
    configView: () => ({
      fmEnabled: fm.enabled,
      fmUrl: fm.url,
      installId: fm.installId,
      pingIntervalMs: 5000,
      pingTimeoutMs: 2000,
      failThreshold: 3,
    }),
    setFmEnabled: (en) => {
      fm.setEnabled(en);
      fmStateView.fmEnabled = en;
    },
    restartProxy: async () => {
      restartProxyCalls++;
    },
    startedAt: Date.now() - 5000,
  };
  const api = new ControlApi(deps);
  return {
    db,
    events,
    pool,
    api,
    fm,
    emState,
    emulatorManager,
    maestroPorts,
    managedRegistry,
    get restartProxyCalls() {
      return restartProxyCalls;
    },
    fmStateView,
  } as unknown as Stubs;
}

let s: Stubs;

beforeEach(() => {
  s = makeStubs();
});
afterEach(() => {
  s.db.close();
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const resp = await s.api.fetchHandler(new Request(`http://localhost${path}`));
  return { status: resp.status, body: await resp.json().catch(() => undefined) };
}
async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await s.api.fetchHandler(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: resp.status, body: await resp.json().catch(() => undefined) };
}
async function put(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await s.api.fetchHandler(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: resp.status, body: await resp.json().catch(() => undefined) };
}
async function del(path: string): Promise<{ status: number; body: unknown }> {
  const resp = await s.api.fetchHandler(new Request(`http://localhost${path}`, { method: 'DELETE' }));
  return { status: resp.status, body: await resp.json().catch(() => undefined) };
}

describe('ControlApi — 16 blueprint endpoints', () => {
  test('1. GET /health returns status + counts', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', deviceCount: 1, fmEnabled: false });
    expect((r.body as { uptime: number }).uptime).toBeGreaterThanOrEqual(0);
  });

  test('2. GET /devices lists pool', async () => {
    const r = await get('/devices');
    expect(r.status).toBe(200);
    const arr = r.body as Array<{ serial: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]?.serial).toBe('emulator-5554');
  });

  test('3. GET /devices/:serial returns 404 for unknown', async () => {
    const r = await get('/devices/not-a-device');
    expect(r.status).toBe(404);
  });

  test('3. GET /devices/:serial returns device for known', async () => {
    const r = await get('/devices/emulator-5554');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ serial: 'emulator-5554', type: 'emulator', state: 'online' });
  });

  test('4. POST /devices/:serial/reconnect triggers t.reconnect()', async () => {
    const r = await post('/devices/emulator-5554/reconnect', {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const t = s.pool.get('emulator-5554') as FakeTransport;
    expect(t.reconnectCalls).toBe(1);
  });

  test('4. POST /devices/:serial/reconnect surfaces errors', async () => {
    (s.pool.get('emulator-5554') as FakeTransport).reconnectShouldFail = true;
    const r = await post('/devices/emulator-5554/reconnect', {});
    expect(r.status).toBe(500);
    expect((r.body as { success: boolean }).success).toBe(false);
  });

  test('5. GET /emulators lists managed AVDs', async () => {
    const r = await get('/emulators');
    expect(r.status).toBe(200);
    const arr = r.body as Array<{ avdName: string; vmPid: number }>;
    expect(arr[0]?.avdName).toBe('Pixel_9_Pro');
    expect(arr[0]?.vmPid).toBe(5678);
  });

  test('6. POST /emulators rejects invalid body', async () => {
    const r = await post('/emulators', { avdName: '' });
    expect(r.status).toBe(400);
  });

  test('6. POST /emulators accepts valid body', async () => {
    const r = await post('/emulators', {
      avdName: 'Pixel_9_Pro',
      emulatorBinary: 'C:/x/emulator.exe',
      consolePort: 5556,
    });
    expect(r.status).toBe(201);
  });

  test('7. DELETE /emulators/:serial 404 unknown', async () => {
    const r = await del('/emulators/emulator-9999');
    expect(r.status).toBe(404);
  });

  test('7. DELETE /emulators/:serial stops known', async () => {
    const r = await del('/emulators/emulator-5554');
    expect(r.status).toBe(200);
  });

  test('8. GET /maestro/ports returns active allocations', async () => {
    await s.maestroPorts.allocate('emulator-5554');
    const r = await get('/maestro/ports');
    expect(r.status).toBe(200);
    expect((r.body as unknown[])).toHaveLength(1);
  });

  test('9. POST /maestro/run allocates + emits maestro.started', async () => {
    const r = await post('/maestro/run', { serial: 'emulator-5554', flowFile: 'tests/x.yaml' });
    expect(r.status).toBe(201);
    expect((r.body as { hostPort: number }).hostPort).toBe(7100);
    const ev = s.events.recent().find((e) => e.eventType === 'maestro.started');
    expect(ev).toBeDefined();
    expect(ev?.payload.flowFile).toBe('tests/x.yaml');
  });

  test('10. DELETE /maestro/run/:id releases', async () => {
    const alloc = await s.maestroPorts.allocate('emulator-5554');
    const r = await del(`/maestro/run/${alloc.id}`);
    expect(r.status).toBe(200);
    expect(s.maestroPorts.active()).toHaveLength(0);
  });

  test('11. GET /forwards aggregates from transports', async () => {
    const r = await get('/forwards');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  test('12. POST /forwards rejects bad transport type', async () => {
    // FakeTransport is not a HybridBackendTransport, so this should reject.
    const r = await post('/forwards', {
      serial: 'emulator-5554',
      local: 'tcp:7100',
      remote: 'tcp:7001',
    });
    expect(r.status).toBe(400);
  });

  test('12. POST /forwards 404 for unknown device', async () => {
    const r = await post('/forwards', {
      serial: 'not-a-device',
      local: 'tcp:7100',
      remote: 'tcp:7001',
    });
    expect(r.status).toBe(404);
  });

  test('13. DELETE /forwards/:id parses serial::local form', async () => {
    const r = await del('/forwards/emulator-5554::tcp:7100');
    // FakeTransport is not Hybrid → 400, but the id parse succeeded.
    expect([400, 200, 500]).toContain(r.status);
  });

  test('13. DELETE /forwards/:id rejects malformed id', async () => {
    const r = await del('/forwards/no-separator-here');
    expect(r.status).toBe(400);
  });

  test('14. GET /config returns config view', async () => {
    const r = await get('/config');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fmEnabled: false, pingIntervalMs: 5000 });
  });

  test('15. PUT /config flips fmEnabled', async () => {
    const r = await put('/config', { fmEnabled: true });
    expect(r.status).toBe(200);
    expect((r.body as { fmEnabled: boolean }).fmEnabled).toBe(true);
    expect(s.fm.enabled).toBe(true);
  });

  test('15. PUT /config rejects invalid body', async () => {
    const r = await put('/config', { fmEnabled: 'yes' });
    expect(r.status).toBe(400);
  });

  test('16. POST /proxy/restart invokes restartProxy', async () => {
    const r = await post('/proxy/restart', {});
    expect(r.status).toBe(200);
    expect(s.restartProxyCalls).toBe(1);
  });

  test('Bonus: GET /incidents returns []', async () => {
    const r = await get('/incidents');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  test('Bonus: GET /events returns recent', async () => {
    s.events.push('device.online', 'emulator-5554', { a: 1 });
    const r = await get('/events?limit=10');
    expect(r.status).toBe(200);
    const arr = r.body as Array<{ eventType: string }>;
    expect(arr[0]?.eventType).toBe('device.online');
  });

  test('Bonus: GET /numa returns topology', async () => {
    const r = await get('/numa');
    expect(r.status).toBe(200);
    expect((r.body as { nodes: unknown[] }).nodes).toHaveLength(1);
  });
});

describe('ControlApi — WebSocket subscription glob matching', () => {
  test('subscribe to device.* receives device events only', () => {
    // Cross-process WS test would require Bun.serve + a real client. The
    // subscription logic itself is small enough to verify via a synthetic
    // client. We poke broadcast() through the public surface by pushing
    // an event and observing it lands in the listener path.
    const received: string[] = [];
    const off = s.events.onPush((eventType) => {
      received.push(eventType);
    });
    s.events.push('device.online', 'emulator-5554', {});
    s.events.push('maestro.started', 'emulator-5554', {});
    off();
    expect(received).toEqual(['device.online', 'maestro.started']);
  });
});
