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
import { EmulatorTransport } from '../transport/emulator.ts';
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
  private unsubscribePool: (() => void) | undefined;

  constructor(deps: SmartSocketDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return;
    await this.reclaimPortIfBusy();

    const server = net.createServer((socket) => this.handleConnection(socket));
    server.on('error', (err) => log.error({ err }, 'server error'));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(PORT, HOST, () => {
        server.off('error', onError);
        log.info({ host: HOST, port: PORT }, 'smart socket listening');
        resolve();
      });
    });

    this.unsubscribePool = this.deps.pool.onChange(() => this.broadcastTrack());
    this.server = server;
  }

  async stop(): Promise<void> {
    this.unsubscribePool?.();
    this.unsubscribePool = undefined;
    for (const s of this.trackSockets) s.destroy();
    this.trackSockets.clear();
    if (this.server === undefined) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
    log.info('smart socket stopped');
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
      await child.exited;
    } catch (err) {
      log.error({ err }, 'failed to spawn adb kill-server');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    let consumed = false; // protocol-mode reads from `data` events
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
    if (!(transport instanceof EmulatorTransport)) {
      log.error({ serial, type: transport.type }, 'upgrade target type not supported in P2');
      client.end();
      return;
    }

    void (async () => {
      let backend: net.Socket;
      try {
        backend = await transport.openBackend();
      } catch (err) {
        log.error({ serial, err }, 'failed to open backend; ending client');
        client.end();
        return;
      }

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

      const closeBoth = (): void => {
        try {
          client.end();
        } catch {
          /* */
        }
        try {
          backend.end();
        } catch {
          /* */
        }
      };
      client.once('end', closeBoth);
      client.once('error', closeBoth);
      backend.once('end', closeBoth);
      backend.once('error', closeBoth);

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

