// ADBPD — Smart Socket Proxy.
//
// Sole listener on 127.0.0.1:5037. Speaks the ADB host protocol so every
// existing client (adb.exe, Android Studio, Maestro, gradle) connects without
// modification.
//
// Each connection runs through this state machine:
//   1. HOST: read a length-prefixed host:* request → dispatch to router.
//   2. If reply.upgradeTo === 'transport': switch to TRANSPORT mode and pipe
//      bytes between client and the chosen DeviceTransport's backend.
//   3. host:track-devices is long-lived: stay open and push updates.
//   4. Any protocol error closes the socket.

import * as net from 'node:net';
import { getLogger } from '../utils/logger.ts';
import type { DeviceTransport } from '../transport/base.ts';
import { HybridBackendTransport } from '../transport/hybrid-backend.ts';
import type { TransportPool } from '../transport/pool.ts';
import { encodeOkayData, tryParseRequest } from './protocol.ts';
import type { HostCommand } from './protocol.ts';
import { parseHostCommand } from './protocol.ts';
import { formatDeviceList, handleHostCommand } from './router.ts';
import type { RouterReply } from './router.ts';

const log = getLogger('smart-socket');

const HOST = '127.0.0.1';
const PORT = 5037;

export interface SmartSocketDeps {
  pool: TransportPool;
  onKill(): void;
}

export class SmartSocketProxy {
  private server: net.Server | undefined;
  private readonly deps: SmartSocketDeps;
  private readonly trackSockets = new Set<net.Socket>();
  /**
   * All currently-live sockets — client AND backend sides of every
   * transport bridge, plus host-protocol sockets that haven't ended yet.
   * Used by stop() to force-close everything (analogue of Bun's stop(true)).
   * Without this, server.close() returns immediately but bridge sockets
   * linger in CLOSE_WAIT and the kernel keeps the 5037 listen socket
   * "zombied" until the dead pid's last handle drops.
   */
  private readonly liveSockets = new Set<net.Socket>();
  private unsubscribePool: (() => void) | undefined;

  constructor(deps: SmartSocketDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return;
    await this.reclaimPortIfBusy();

    // EADDRINUSE retry loop. Windows + NSSM occasionally leaves a kernel
    // zombie on 5037 (dead pid still listed as owner). The zombie usually
    // clears within ~30s once NSSM's own handle drops. We retry up to 12 x
    // 5s = 60s of patience before giving up — which is preferable to
    // exiting and letting NSSM relaunch into the SAME zombie.
    const MAX_RETRIES = 12;
    const RETRY_WAIT_MS = 5_000;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.tryListenOnce();
        if (attempt > 1) {
          log.info({ attempt }, 'smart socket listening after retry');
        }
        this.unsubscribePool = this.deps.pool.onChange(() => this.broadcastTrack());
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if ((lastErr as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw lastErr;
        }
        log.warn(
          { attempt, max: MAX_RETRIES, waitMs: RETRY_WAIT_MS },
          'EADDRINUSE — waiting for zombie listener to clear',
        );
        await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
        // Try reclaim again — the ghost may have cleared and stock adb
        // may have replaced it during the wait.
        await this.reclaimPortIfBusy();
      }
    }
    throw lastErr ?? new Error('smart socket: bind failed after retries');
  }

  private async tryListenOnce(): Promise<void> {
    const server = net.createServer((socket) => this.handleConnection(socket));
    server.on('error', (err) => log.error({ err }, 'server error'));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('error', onError);
        // Destroy any sockets that might have attached during the failed
        // bind so we don't leak handles into the next retry.
        try {
          server.close();
        } catch {
          /* */
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(PORT, HOST, () => {
        server.off('error', onError);
        log.info({ host: HOST, port: PORT }, 'smart socket listening');
        resolve();
      });
    });
    this.server = server;
  }

  /**
   * Forceful stop. Closes the listener AND every live socket (track
   * subscribers, bridge clients, bridge backends). Without the forced
   * destroy, Windows leaves the listen socket in a ghost LISTENING state
   * owned by the dead pid — the zombie that bites the next service start.
   */
  async stop(): Promise<void> {
    this.unsubscribePool?.();
    this.unsubscribePool = undefined;
    for (const s of this.liveSockets) {
      try {
        s.destroy();
      } catch {
        /* */
      }
    }
    this.liveSockets.clear();
    this.trackSockets.clear();
    if (this.server === undefined) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
    log.info('smart socket stopped');
  }

  /** Track a socket for forceful cleanup at stop(). */
  private trackLive(s: net.Socket): void {
    this.liveSockets.add(s);
    s.once('close', () => this.liveSockets.delete(s));
  }

  private async reclaimPortIfBusy(): Promise<void> {
    const tester = net.createConnection({ host: HOST, port: PORT });
    const busy = await new Promise<boolean>((resolve) => {
      tester.once('connect', () => {
        tester.destroy();
        resolve(true);
      });
      tester.once('error', () => resolve(false));
    });
    if (!busy) return;

    log.warn('port 5037 already bound; attempting `adb kill-server` to reclaim');
    const adb = process.env.ADBPD_ADB_PATH ?? 'adb';
    try {
      const child = Bun.spawn([adb, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
      // Hard timeout — if the listener is a zombie, `adb kill-server` will
      // connect (kernel accepts) but never get a response (no real adb is
      // attached to drain the bytes), so child.exited never resolves.
      // Kill the child after 3s and move on; the EADDRINUSE retry loop in
      // start() will keep trying until the zombie clears.
      const TIMEOUT_MS = 3_000;
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* */
        }
      }, TIMEOUT_MS);
      try {
        await child.exited;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      log.error({ err }, 'failed to spawn adb kill-server');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  private handleConnection(socket: net.Socket): void {
    this.trackLive(socket);
    let buffer = Buffer.alloc(0);
    let consumed = false; // protocol-mode reads from `data` events
    const connectedAt = Date.now();
    log.debug({ remote: socket.remoteAddress }, 'client connected');

    const consume = (): void => {
      while (buffer.length >= 4 && !consumed) {
        let parsed: { payload: string; consumed: number } | null;
        try {
          parsed = tryParseRequest(buffer);
        } catch (err) {
          log.warn({ err }, 'protocol parse error; closing socket');
          socket.destroy();
          return;
        }
        if (parsed === null) return;
        buffer = buffer.subarray(parsed.consumed);

        const cmd: HostCommand = parseHostCommand(parsed.payload);
        log.debug({ payload: parsed.payload, kind: cmd.kind }, 'host command');

        // Loud forensic log when a host:kill arrives. Includes everything
        // we can identify the client by from inside the socket without an
        // async OS lookup: remote IPv4 + ephemeral port + connection age +
        // any earlier requests this socket sent. Owner uses this to find
        // which tool is hitting kill-server (Studio quit, gradle daemon,
        // leftover script, etc.) so we can stop the trigger upstream.
        // The async PID-to-process resolution fires in the background.
        if (cmd.kind === 'kill') {
          const ctx = {
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            localPort: socket.localPort,
            connectionAgeMs: Date.now() - connectedAt,
            payload: parsed.payload,
            timestamp: new Date(Date.now()).toISOString(),
          };
          log.warn(ctx, 'HOST:KILL received — daemon shutdown imminent');
          // Best-effort client PID + process-name resolution. Fires async
          // so it does not delay the OKAY reply; logs separately when done.
          void resolveCallerProcess(socket).then((info) => {
            if (info !== undefined) {
              log.warn(
                { ...ctx, callerPid: info.pid, callerName: info.name, callerPath: info.path },
                'HOST:KILL caller identified',
              );
            } else {
              log.warn(ctx, 'HOST:KILL caller resolution: no match (caller may already have closed)');
            }
          });
        }

        const reply: RouterReply = handleHostCommand(cmd, this.deps);

        // For transport upgrades, we DO NOT write the router's OKAY ourselves.
        // The backend's OKAY (in response to our replayed host:transport)
        // will flow through the bridge to the client. Writing both produces
        // a double-OKAY protocol mismatch.
        if (!('upgradeTo' in reply)) {
          socket.write(reply.wire);
        }

        if (cmd.kind === 'track-devices') {
          consumed = true;
          this.trackSockets.add(socket);
          return;
        }
        if ('upgradeTo' in reply) {
          consumed = true;
          this.upgradeToTransport(socket, reply.serial, parsed.payload, buffer);
          return;
        }
        socket.end();
        return;
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (consumed) return;
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });

    socket.on('close', () => {
      this.trackSockets.delete(socket);
      log.debug('client disconnected');
    });
    socket.on('error', (err) => {
      log.debug({ err }, 'client socket error');
    });
  }

  /**
   * Switch the client socket into transport mode by opening a connection to
   * the device's private backend adb server, sending the original
   * host:transport:<serial> request to it, and then bidirectionally piping
   * bytes. The backend's OKAY flows through the bridge to the client, so the
   * client sees exactly one OKAY in response to its host:transport request.
   *
   * `originalPayload` is the literal payload the client sent (e.g.,
   * "host:transport:emulator-5554"); we replay it verbatim so the backend
   * agrees on the wire-level format. `pending` is any bytes the client sent
   * AFTER the host:transport request (e.g., shell:echo hello on the same
   * connection); they flow to the backend after the bridge is established.
   */
  private upgradeToTransport(
    client: net.Socket,
    serial: string,
    originalPayload: string,
    pending: Buffer,
  ): void {
    const transport: DeviceTransport | undefined = this.deps.pool.get(serial);
    if (transport === undefined || transport.state !== 'online') {
      log.warn({ serial }, 'upgrade target offline; ending client');
      client.end();
      return;
    }
    if (!(transport instanceof HybridBackendTransport)) {
      log.error({ serial, type: transport.type }, 'upgrade target type not supported');
      client.end();
      return;
    }

    void (async () => {
      let backend: net.Socket;
      try {
        backend = await transport.openBackend();
      } catch (err) {
        log.error({ serial, err }, 'failed to open backend; ending client');
        client.destroy();
        return;
      }
      this.trackLive(backend);

      // Replay the literal host:transport request to the backend so its OKAY
      // flows through the bridge to the client.
      const body = Buffer.from(originalPayload, 'utf8');
      const header = Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii');
      backend.write(Buffer.concat([header, body]));

      // Bridge in both directions starting now.
      backend.on('data', (b: Buffer) => {
        if (!client.writable) return;
        client.write(b);
      });
      client.on('data', (b: Buffer) => {
        if (!backend.writable) return;
        backend.write(b);
      });

      // Forward any client bytes that arrived before the bridge was set up.
      if (pending.length > 0) backend.write(pending);

      // Relay close propagation: when EITHER side closes for any reason
      // (clean end, error, or hard close), force-destroy the other. Without
      // this, a Maestro session dying mid-command leaves the paired backend
      // socket in CLOSE_WAIT forever — until ADBPD restarts. We listen on
      // 'close' (not just 'end') because half-closed sockets fire 'end'
      // without 'close', and destroying on 'end' alone leaves the other
      // side in FIN_WAIT-2.
      let bridgeClosed = false;
      const closeBoth = (origin: 'client' | 'backend', reason: string): void => {
        if (bridgeClosed) return;
        bridgeClosed = true;
        log.debug({ serial, origin, reason }, 'bridge closing — propagating');
        try {
          client.destroy();
        } catch {
          /* */
        }
        try {
          backend.destroy();
        } catch {
          /* */
        }
      };
      client.once('close', () => closeBoth('client', 'close'));
      client.once('error', (err) => closeBoth('client', `error: ${err.message}`));
      backend.once('close', () => closeBoth('backend', 'close'));
      backend.once('error', (err) => closeBoth('backend', `error: ${err.message}`));

      log.info({ serial }, 'transport bridge established');
    })();
  }

  private broadcastTrack(): void {
    if (this.trackSockets.size === 0) return;
    const wire = encodeOkayData(formatDeviceList(this.deps.pool, false));
    const update = wire.subarray(4);
    for (const s of this.trackSockets) {
      try {
        s.write(update);
      } catch (err) {
        log.debug({ err }, 'failed to write track update; dropping');
        this.trackSockets.delete(s);
        s.destroy();
      }
    }
  }
}

/**
 * Best-effort caller-process resolution for forensic logging on host:kill.
 *
 * Identifies the client process that opened the connection to 5037 by
 * looking up its local TCP endpoint (loopback address + ephemeral port)
 * via PowerShell `Get-NetTCPConnection`, then resolving the OwningProcess
 * via `Get-Process`. Returns undefined if anything fails — the caller is
 * expected to log accordingly and not retry.
 *
 * Used only on host:kill so the operational cost is one PowerShell spawn
 * per kill event, not per request. The caller may already have closed by
 * the time this runs (kill clients are usually `adb kill-server` which
 * disconnects immediately); that's expected and logged as a no-match.
 */
async function resolveCallerProcess(
  socket: net.Socket,
): Promise<{ pid: number; name: string; path: string | null } | undefined> {
  // From ADBPD's perspective: socket.remotePort is the CLIENT's ephemeral
  // port (the one that connects out to 5037). For Get-NetTCPConnection we
  // query that ephemeral port as LocalPort (it's local to the client's
  // process on the same machine) with RemotePort=5037.
  const clientEphemeralPort = socket.remotePort;
  if (clientEphemeralPort === undefined) return undefined;

  try {
    const proc = Bun.spawn(
      [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Get the OwningProcess of the connection FROM client TO ADBPD's 5037.
        `$conn = Get-NetTCPConnection -LocalPort ${clientEphemeralPort} -RemotePort 5037 -RemoteAddress 127.0.0.1 -ErrorAction SilentlyContinue | Select-Object -First 1;` +
          `if ($conn) { $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue;` +
          ` if ($p) { ConvertTo-Json -Compress -Depth 2 @{ pid = $p.Id; name = $p.ProcessName; path = $p.Path } } }`,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (out.length === 0) return undefined;
    const parsed = JSON.parse(out) as { pid: number; name: string; path: string | null };
    return { pid: parsed.pid, name: parsed.name, path: parsed.path };
  } catch {
    return undefined;
  }
}
