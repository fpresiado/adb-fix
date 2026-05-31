// ADBPD — Control API (HTTP :3002 + WebSocket :3003).
//
// Blueprint §5.6 specifies the route table verbatim. Every endpoint here
// corresponds to a row in that table. Payload validation uses zod.
//
// Architecture: two Bun.serve instances — HTTP via Hono on 3002, WebSocket
// (subscription + event stream) on 3003.

import { Hono } from 'hono';
import { z } from 'zod';
import { getLogger } from '../utils/logger.ts';
import type { TransportPool } from '../transport/pool.ts';
import type { EventQueue, EventType } from '../db/events.ts';
import type { EmulatorManager, ManagedEmulator } from '../emulator/manager.ts';
import type { MaestroPortManager } from '../maestro/port-manager.ts';
import type { SmartSocketProxy } from '../proxy/smart-socket.ts';
import type { FmClient } from '../fm/client.ts';
import { HybridBackendTransport } from '../transport/hybrid-backend.ts';

const log = getLogger('api');

export interface ManagedAvdSpec {
  avdName: string;
  emulatorBinary: string;
  consolePort: number;
}

export interface AdbpdConfigView {
  fmEnabled: boolean;
  fmUrl: string;
  installId: string;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  failThreshold: number;
}

export interface ControlApiDeps {
  pool: TransportPool;
  events: EventQueue;
  proxy: SmartSocketProxy;
  fm: FmClient;
  emulatorManager?: EmulatorManager;
  maestroPorts?: MaestroPortManager;
  managedRegistry?: Map<string, ManagedAvdSpec>;
  configView(): AdbpdConfigView;
  setFmEnabled(enabled: boolean): void;
  restartProxy(): Promise<void>;
  startedAt: number;
}

const StartEmulatorBody = z.object({
  avdName: z.string().min(1),
  emulatorBinary: z.string().min(1).optional(),
  consolePort: z.number().int().min(5554).max(5680),
  memoryMb: z.number().int().min(512).max(32768).optional(),
});

const MaestroRunBody = z.object({
  serial: z.string().min(1),
  flowFile: z.string().min(1).optional(),
});

const ForwardBody = z.object({
  serial: z.string().min(1),
  local: z.string().regex(/^tcp:\d+$/),
  remote: z.string().regex(/^tcp:\d+$/),
});

const ConfigPatchBody = z.object({
  fmEnabled: z.boolean().optional(),
});

export interface WsEnvelope {
  event: EventType;
  serial: string | null;
  data: Record<string, unknown>;
  timestamp: string;
}

interface SubscribedClient {
  patterns: RegExp[];
}

export class ControlApi {
  private readonly deps: ControlApiDeps;
  private readonly app: Hono;
  private httpServer: ReturnType<typeof Bun.serve> | undefined;
  private wsServer: ReturnType<typeof Bun.serve> | undefined;
  private readonly clients = new Map<unknown, SubscribedClient>();
  private unsubscribeEvents: (() => void) | undefined;

  constructor(deps: ControlApiDeps) {
    this.deps = deps;
    this.app = this.buildApp();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async start(httpPort = 3002, wsPort = 3003): Promise<void> {
    this.httpServer = Bun.serve({
      port: httpPort,
      hostname: '127.0.0.1',
      fetch: (req) => this.app.fetch(req),
    });
    log.info({ port: httpPort }, 'Control API HTTP listening');

    const self = this;
    this.wsServer = Bun.serve({
      port: wsPort,
      hostname: '127.0.0.1',
      fetch(req, server) {
        if (server.upgrade(req)) return undefined as unknown as Response;
        return new Response('expected websocket upgrade', { status: 426 });
      },
      websocket: {
        open(ws): void {
          self.clients.set(ws, { patterns: [/^.*$/] });
          log.debug({ remote: ws.remoteAddress }, 'ws client connected');
        },
        message(ws, msg): void {
          self.handleWsMessage(ws, String(msg));
        },
        close(ws): void {
          self.clients.delete(ws);
          log.debug({ remote: ws.remoteAddress }, 'ws client disconnected');
        },
      },
    });
    log.info({ port: wsPort }, 'Control API WebSocket listening');

    this.unsubscribeEvents = this.deps.events.onPush((eventType, serial, payload) => {
      this.broadcast({
        event: eventType,
        serial,
        data: payload,
        timestamp: new Date(Date.now()).toISOString(),
      });
    });
  }

  async stop(): Promise<void> {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    if (this.httpServer !== undefined) {
      await this.httpServer.stop(true);
      this.httpServer = undefined;
    }
    if (this.wsServer !== undefined) {
      await this.wsServer.stop(true);
      this.wsServer = undefined;
    }
    this.clients.clear();
  }

  /** Test-only access to the Hono app for in-process route testing. */
  get fetchHandler(): (req: Request) => Response | Promise<Response> {
    return (req) => this.app.fetch(req);
  }

  // ─── WebSocket ──────────────────────────────────────────────────────

  private handleWsMessage(ws: unknown, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(ws, { error: 'invalid json' });
      return;
    }
    const Schema = z.object({ subscribe: z.array(z.string()).optional() });
    const result = Schema.safeParse(parsed);
    if (!result.success) {
      sendJson(ws, { error: 'invalid subscribe payload' });
      return;
    }
    const subs = result.data.subscribe;
    if (subs !== undefined) {
      const patterns = subs.map(globToRegExp);
      const client = this.clients.get(ws);
      if (client !== undefined) client.patterns = patterns;
      sendJson(ws, { ok: true, subscribed: subs });
    }
  }

  private broadcast(env: WsEnvelope): void {
    const payload = JSON.stringify(env);
    for (const [ws, client] of this.clients) {
      if (!client.patterns.some((p) => p.test(env.event))) continue;
      try {
        (ws as { send(data: string): void }).send(payload);
      } catch (err) {
        log.warn({ err }, 'ws send failed');
      }
    }
  }

  // ─── Routes ─────────────────────────────────────────────────────────

  private buildApp(): Hono {
    const app = new Hono();
    const d = this.deps;

    // 1. GET /health
    app.get('/health', (c) =>
      c.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - d.startedAt) / 1000),
        deviceCount: d.pool.all().length,
        fmEnabled: d.fm.enabled,
        version: '0.1.0',
      }),
    );

    // 2. GET /devices
    app.get('/devices', (c) => c.json(d.pool.list()));

    // 3. GET /devices/:serial
    app.get('/devices/:serial', (c) => {
      const serial = c.req.param('serial');
      const t = d.pool.get(serial);
      if (t === undefined) return c.json({ error: 'no such device' }, 404);
      return c.json({
        serial: t.serial,
        type: t.type,
        state: t.state,
        port: t.port,
      });
    });

    // 4. POST /devices/:serial/reconnect
    app.post('/devices/:serial/reconnect', async (c) => {
      const serial = c.req.param('serial');
      const t = d.pool.get(serial);
      if (t === undefined) return c.json({ error: 'no such device' }, 404);
      try {
        await t.reconnect();
        return c.json({ success: true });
      } catch (err) {
        return c.json({ success: false, error: errMsg(err) }, 500);
      }
    });

    // 5. GET /emulators
    app.get('/emulators', (c) => {
      if (d.emulatorManager === undefined) return c.json([]);
      return c.json(d.emulatorManager.list().map(emulatorView));
    });

    // 6. POST /emulators
    app.post('/emulators', async (c) => {
      if (d.emulatorManager === undefined) {
        return c.json({ error: 'emulator manager not initialized' }, 503);
      }
      const body = await c.req.json().catch(() => undefined);
      const parsed = StartEmulatorBody.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.issues }, 400);
      try {
        const state = await d.emulatorManager.startAvd({
          avdName: parsed.data.avdName,
          emulatorBinary: parsed.data.emulatorBinary ?? defaultEmulatorBinary(),
          consolePort: parsed.data.consolePort,
          memoryMb: parsed.data.memoryMb,
        });
        if (d.managedRegistry !== undefined) {
          d.managedRegistry.set(`emulator-${state.consolePort}`, {
            avdName: parsed.data.avdName,
            emulatorBinary: parsed.data.emulatorBinary ?? defaultEmulatorBinary(),
            consolePort: parsed.data.consolePort,
          });
        }
        return c.json(emulatorView(state), 201);
      } catch (err) {
        return c.json({ error: errMsg(err) }, 500);
      }
    });

    // 7. DELETE /emulators/:serial
    app.delete('/emulators/:serial', async (c) => {
      if (d.emulatorManager === undefined) {
        return c.json({ error: 'emulator manager not initialized' }, 503);
      }
      const serial = c.req.param('serial');
      const state = d.emulatorManager.getBySerial(serial);
      if (state === undefined) return c.json({ error: 'no such managed emulator' }, 404);
      try {
        await d.emulatorManager.stopAvd(state.avdName, defaultAdbPath());
        d.managedRegistry?.delete(serial);
        return c.json({ success: true });
      } catch (err) {
        return c.json({ success: false, error: errMsg(err) }, 500);
      }
    });

    // 8. GET /maestro/ports
    app.get('/maestro/ports', (c) => {
      if (d.maestroPorts === undefined) return c.json([]);
      return c.json(d.maestroPorts.active());
    });

    // 9. POST /maestro/run
    app.post('/maestro/run', async (c) => {
      if (d.maestroPorts === undefined) {
        return c.json({ error: 'maestro port manager not initialized' }, 503);
      }
      const body = await c.req.json().catch(() => undefined);
      const parsed = MaestroRunBody.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.issues }, 400);
      try {
        const alloc = await d.maestroPorts.allocate(parsed.data.serial, parsed.data.flowFile);
        d.events.push('maestro.started', parsed.data.serial, {
          allocationId: alloc.id,
          hostPort: alloc.hostPort,
          flowFile: parsed.data.flowFile,
        });
        return c.json(alloc, 201);
      } catch (err) {
        return c.json({ error: errMsg(err) }, 500);
      }
    });

    // 10. DELETE /maestro/run/:id
    app.delete('/maestro/run/:id', async (c) => {
      if (d.maestroPorts === undefined) {
        return c.json({ error: 'maestro port manager not initialized' }, 503);
      }
      const id = Number.parseInt(c.req.param('id'), 10);
      if (Number.isNaN(id)) return c.json({ error: 'bad id' }, 400);
      try {
        await d.maestroPorts.release(id);
        return c.json({ success: true });
      } catch (err) {
        return c.json({ success: false, error: errMsg(err) }, 500);
      }
    });

    // 11. GET /forwards
    app.get('/forwards', async (c) => {
      const out: Array<{ serial: string; local: string; remote: string }> = [];
      for (const t of d.pool.all()) {
        if (!(t instanceof HybridBackendTransport)) continue;
        try {
          const fwds = await t.listForwards();
          for (const f of fwds) out.push({ serial: t.serial, local: f.local, remote: f.remote });
        } catch {
          /* skip offline device */
        }
      }
      return c.json(out);
    });

    // 12. POST /forwards
    app.post('/forwards', async (c) => {
      const body = await c.req.json().catch(() => undefined);
      const parsed = ForwardBody.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.issues }, 400);
      const t = d.pool.get(parsed.data.serial);
      if (t === undefined) return c.json({ error: 'no such device' }, 404);
      if (!(t instanceof HybridBackendTransport)) {
        return c.json({ error: 'forwards not supported on this transport type' }, 400);
      }
      try {
        await t.forward(parsed.data.local, parsed.data.remote);
        return c.json(
          { serial: t.serial, local: parsed.data.local, remote: parsed.data.remote },
          201,
        );
      } catch (err) {
        return c.json({ error: errMsg(err) }, 500);
      }
    });

    // 13. DELETE /forwards/:id   (id = "<serial>::<local>")
    app.delete('/forwards/:id', async (c) => {
      const raw = c.req.param('id');
      const sep = raw.indexOf('::');
      if (sep < 0) return c.json({ error: 'id must be <serial>::<local>' }, 400);
      const serial = raw.slice(0, sep);
      const local = raw.slice(sep + 2);
      const t = d.pool.get(serial);
      if (t === undefined) return c.json({ error: 'no such device' }, 404);
      if (!(t instanceof HybridBackendTransport)) {
        return c.json({ error: 'forwards not supported on this transport type' }, 400);
      }
      try {
        await t.removeForward(local);
        return c.json({ success: true });
      } catch (err) {
        return c.json({ success: false, error: errMsg(err) }, 500);
      }
    });

    // 14. GET /config
    app.get('/config', (c) => c.json(d.configView()));

    // 15. PUT /config
    app.put('/config', async (c) => {
      const body = await c.req.json().catch(() => undefined);
      const parsed = ConfigPatchBody.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.issues }, 400);
      if (parsed.data.fmEnabled !== undefined) {
        d.setFmEnabled(parsed.data.fmEnabled);
      }
      return c.json(d.configView());
    });

    // 16. POST /proxy/restart
    app.post('/proxy/restart', async (c) => {
      try {
        await d.restartProxy();
        return c.json({ success: true });
      } catch (err) {
        return c.json({ success: false, error: errMsg(err) }, 500);
      }
    });

    // Bonus read-only endpoints (not in blueprint table 5.6 but trivial):
    app.get('/incidents', (c) => {
      const activeOnly = c.req.query('active') === 'true';
      return c.json(d.events.listIncidents({ activeOnly }));
    });
    app.get('/events', (c) => {
      const limit = Number.parseInt(c.req.query('limit') ?? '100', 10);
      const since = c.req.query('since');
      const sinceId = since === undefined ? undefined : Number.parseInt(since, 10);
      return c.json(d.events.recent(limit, sinceId));
    });
    app.get('/numa', (c) => {
      const topo = d.emulatorManager?.getTopology();
      if (topo === undefined) return c.json(null);
      return c.json({
        detected: topo.detected,
        source: topo.source,
        nodes: topo.nodes.map((n) => ({
          nodeNumber: n.nodeNumber,
          group: n.group,
          coreMask: '0x' + n.coreMask.toString(16),
          coreCount: n.coreCount,
        })),
      });
    });

    return app;
  }
}

function emulatorView(e: ManagedEmulator): Record<string, unknown> {
  return {
    avdName: e.avdName,
    serial: `emulator-${e.consolePort}`,
    pid: e.pid,
    vmPid: e.vmPid,
    consolePort: e.consolePort,
    adbPort: e.adbPort,
    numaNode: e.numaNode,
    affinityMask: `0x${e.affinityMask.toString(16)}`,
    vmAffinityMask: e.vmAffinityMask === undefined ? null : `0x${e.vmAffinityMask.toString(16)}`,
    memoryMb: e.memoryMb,
    startedAt: e.startedAt,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sendJson(ws: unknown, obj: unknown): void {
  try {
    (ws as { send(data: string): void }).send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

/** Convert a glob like `device.*` to a RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function defaultEmulatorBinary(): string {
  return (
    process.env.ADBPD_EMULATOR_BIN ??
    'C:/Users/plusu/AppData/Local/Android/Sdk/emulator/emulator.exe'
  );
}

function defaultAdbPath(): string {
  return process.env.ADBPD_ADB_PATH ?? 'C:/Android/platform-tools/adb.exe';
}
