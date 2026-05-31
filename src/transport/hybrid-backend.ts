// ADBPD — HybridBackendTransport.
//
// The shared base for any device that we expose to clients via a private
// stock-adb backend server bound with `--one-device <serial>` on its own
// ANDROID_ADB_SERVER_PORT. Both emulators (P2) and USB devices (P3) use this
// pattern. The transport bridge in smart-socket.ts opens raw TCP to the
// `backendPort` and replays the client's host:transport:<serial> request,
// then bidirectionally pipes.
//
// Why hybrid (vs blueprint's "direct daemon TCP"): see BUILD_REPORT D4.

import * as net from 'node:net';
import { getLogger } from '../utils/logger.ts';
import { encodeMessage } from '../proxy/protocol.ts';
import type {
  DeviceProperties,
  DeviceTransport,
  Forward,
  InstallOptions,
  ShellResult,
  TransportState,
  TransportType,
} from './base.ts';

const log = getLogger('hybrid-backend');

const HOST = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 3_000;
const READY_POLL_INTERVAL_MS = 250;
const READY_TOTAL_TIMEOUT_MS = 20_000;

export interface SpawnedProcess {
  readonly pid: number;
  exited: Promise<number>;
  kill(): void;
}

type StateChangeHandler = (state: TransportState) => void;
type ErrorHandler = (err: Error) => void;

export interface HybridBackendOptions {
  serial: string;
  type: TransportType;
  /** Stock adb binary, e.g., C:/Android/platform-tools/adb.exe */
  adbBinaryPath: string;
  /** Private port on which to run the dedicated backend adb server. */
  backendPort: number;
  /**
   * Optional process spawner override (tests inject a stub). Defaults to
   * `Bun.spawn` of the adb binary.
   */
  spawnAdbServer?(env: Record<string, string>, args: readonly string[]): SpawnedProcess;
}

export class HybridBackendTransport implements DeviceTransport {
  readonly serial: string;
  readonly type: TransportType;
  readonly port: number;

  private _state: TransportState = 'offline';
  private readonly stateHandlers = new Set<StateChangeHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private backend: SpawnedProcess | undefined;
  protected readonly opts: HybridBackendOptions;

  constructor(opts: HybridBackendOptions) {
    this.opts = opts;
    this.serial = opts.serial;
    this.type = opts.type;
    this.port = opts.backendPort;
  }

  get state(): TransportState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this._state === 'online') return;
    this.setState('recovery');
    log.info(
      { serial: this.serial, type: this.type, backendPort: this.port },
      'starting backend adb server',
    );

    const env = { ANDROID_ADB_SERVER_PORT: String(this.port) };
    const args = ['--one-device', this.serial, 'start-server'];
    this.backend = (this.opts.spawnAdbServer ?? defaultSpawn)(env, [
      this.opts.adbBinaryPath,
      ...args,
    ]);

    this.backend.exited
      .then((code) => {
        log.warn({ serial: this.serial, code }, 'backend adb exited');
        if (this._state !== 'disconnected') this.setState('offline');
      })
      .catch((err: unknown) => {
        log.error({ serial: this.serial, err }, 'backend adb spawn error');
        this.emitError(asError(err));
      });

    const deadline = Date.now() + READY_TOTAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await waitTcpReady(this.port, deadline);
        const list = await this.sendHostCommand('host:devices');
        if (list.split('\n').some((line) => line.startsWith(`${this.serial}\t`) && line.includes('device'))) {
          this.setState('online');
          log.info({ serial: this.serial, type: this.type }, 'backend ready, device online');
          return;
        }
      } catch (err) {
        log.debug({ err: asError(err).message }, 'waiting for backend');
      }
      await sleep(READY_POLL_INTERVAL_MS);
    }
    this.setState('offline');
    throw new Error(
      `HybridBackendTransport(${this.serial}): backend not ready within ${READY_TOTAL_TIMEOUT_MS}ms`,
    );
  }

  async disconnect(): Promise<void> {
    if (this.backend !== undefined) {
      log.info({ serial: this.serial, pid: this.backend.pid }, 'stopping backend adb');
      try {
        await this.sendHostCommand('host:kill');
      } catch {
        /* server may already be gone */
      }
      try {
        this.backend.kill();
      } catch {
        /* ignore */
      }
      this.backend = undefined;
    }
    this.setState('disconnected');
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async shell(command: string): Promise<ShellResult> {
    const sock = await this.openBackend();
    const reader = new SocketReader(sock);
    try {
      await writeAdbCommand(sock, `host:transport:${this.serial}`);
      await expectOkayReader(reader, 'host:transport');
      await writeAdbCommand(sock, `shell:${command}`);
      await expectOkayReader(reader, 'shell');
      const stdout = await reader.readAll();
      return { stdout, stderr: '', exitCode: 0 };
    } finally {
      sock.destroy();
    }
  }

  async push(_localPath: string, _remotePath: string): Promise<void> {
    throw new Error('push not implemented yet (deferred to later phase)');
  }
  async pull(_remotePath: string, _localPath: string): Promise<void> {
    throw new Error('pull not implemented yet (deferred to later phase)');
  }
  async install(_apkPath: string, _opts?: InstallOptions): Promise<void> {
    throw new Error('install not implemented yet (deferred to later phase)');
  }

  /**
   * Create a port forward on this device's backend, e.g.
   * forward('tcp:7101', 'tcp:7001'). Used by the Maestro port manager (P4).
   */
  async forward(local: string, remote: string): Promise<void> {
    const out = await this.sendHostCommand(
      `host-serial:${this.serial}:forward:${local};${remote}`,
    );
    log.debug({ serial: this.serial, local, remote, out }, 'forward created');
  }

  async listForwards(): Promise<Forward[]> {
    const text = await this.sendHostCommand('host:list-forward');
    const out: Forward[] = [];
    for (const line of text.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts[0] === this.serial) {
        out.push({ local: parts[1]!, remote: parts[2]!, source: 'adbpd' });
      }
    }
    return out;
  }

  async removeForward(local: string): Promise<void> {
    await this.sendHostCommand(`host-serial:${this.serial}:killforward:${local}`);
  }

  async ping(): Promise<number> {
    const start = Date.now();
    const result = await this.shell('echo .');
    if (result.stdout.trim() !== '.') {
      throw new Error(`ping mismatch: got "${result.stdout}"`);
    }
    return Date.now() - start;
  }

  async getProperties(): Promise<DeviceProperties> {
    const { stdout } = await this.shell('getprop');
    const out: DeviceProperties = {};
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\[([^\]]+)\]:\s*\[([^\]]*)\]/);
      if (m) {
        const key = m[1]!;
        const val = m[2]!;
        if (key === 'ro.product.model') out.model = val;
        else if (key === 'ro.product.manufacturer') out.manufacturer = val;
        else if (key === 'ro.build.version.sdk') out.sdkVersion = Number(val);
        else if (key === 'ro.product.cpu.abi') out.cpuAbi = val;
        else if (key === 'ro.product.name') out.product = val;
      }
    }
    return out;
  }

  on(event: 'state-change' | 'error', handler: (...args: never[]) => void): void {
    if (event === 'state-change') this.stateHandlers.add(handler as unknown as StateChangeHandler);
    else this.errorHandlers.add(handler as unknown as ErrorHandler);
  }
  off(event: 'state-change' | 'error', handler: (...args: never[]) => void): void {
    if (event === 'state-change')
      this.stateHandlers.delete(handler as unknown as StateChangeHandler);
    else this.errorHandlers.delete(handler as unknown as ErrorHandler);
  }

  /** Open a fresh TCP connection to the backend stock-adb server. */
  openBackend(): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection({ host: HOST, port: this.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`HybridBackend(${this.serial}): backend connect timeout`));
      }, CONNECT_TIMEOUT_MS);
      sock.once('connect', () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async sendHostCommand(cmd: string): Promise<string> {
    const sock = await this.openBackend();
    const reader = new SocketReader(sock);
    try {
      await writeAdbCommand(sock, cmd);
      const status = await reader.readExact(4, PING_TIMEOUT_MS);
      const statusStr = status.toString('ascii');
      if (statusStr === 'OKAY') {
        try {
          const lenBuf = await reader.readExact(4, PING_TIMEOUT_MS);
          const len = Number.parseInt(lenBuf.toString('ascii'), 16);
          if (Number.isNaN(len) || len === 0) return '';
          const data = await reader.readExact(len, PING_TIMEOUT_MS);
          return data.toString('utf8');
        } catch {
          return '';
        }
      }
      if (statusStr === 'FAIL') {
        const lenBuf = await reader.readExact(4, PING_TIMEOUT_MS);
        const len = Number.parseInt(lenBuf.toString('ascii'), 16);
        const data = await reader.readExact(len, PING_TIMEOUT_MS);
        throw new Error(`backend FAIL: ${data.toString('utf8')}`);
      }
      throw new Error(`backend bad status: ${statusStr}`);
    } finally {
      sock.destroy();
    }
  }

  private setState(next: TransportState): void {
    if (this._state === next) return;
    log.debug({ serial: this.serial, from: this._state, to: next }, 'state change');
    this._state = next;
    for (const h of this.stateHandlers) {
      try {
        h(next);
      } catch (err) {
        log.error({ err }, 'state handler threw');
      }
    }
  }

  private emitError(err: Error): void {
    for (const h of this.errorHandlers) {
      try {
        h(err);
      } catch (handlerErr) {
        log.error({ handlerErr }, 'error handler threw');
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultSpawn(env: Record<string, string>, argv: readonly string[]): SpawnedProcess {
  const proc = Bun.spawn(argv as string[], {
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill(): void {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

async function waitTcpReady(port: number, deadline: number): Promise<void> {
  for (;;) {
    if (Date.now() > deadline) throw new Error(`waitTcpReady(${port}) timeout`);
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createConnection({ host: HOST, port });
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(150);
  }
}

export class SocketReader {
  private buf = Buffer.alloc(0);
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private ended = false;
  private err: Error | undefined;

  constructor(private readonly sock: net.Socket) {
    sock.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.flush();
    });
    sock.once('end', () => {
      this.ended = true;
      this.flush();
    });
    sock.once('error', (e: Error) => {
      this.err = e;
      this.flush();
    });
  }

  readExact(n: number, timeoutMs: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new Error(`readExact: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = {
        n,
        resolve: (b: Buffer): void => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e: Error): void => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.waiters.push(waiter);
      this.flush();
    });
  }

  readAll(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.err) {
        reject(this.err);
        return;
      }
      if (this.ended) {
        resolve(this.buf.toString('utf8'));
        return;
      }
      this.sock.once('end', () => resolve(this.buf.toString('utf8')));
      this.sock.once('error', (e) => reject(e));
    });
  }

  private flush(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters[0]!;
      if (this.buf.length >= w.n) {
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        this.waiters.shift();
        w.resolve(Buffer.from(out));
        continue;
      }
      if (this.err) {
        this.waiters.shift();
        w.reject(this.err);
        continue;
      }
      if (this.ended) {
        this.waiters.shift();
        w.reject(new Error(`readExact: unexpected EOF (need ${w.n}, got ${this.buf.length})`));
        continue;
      }
      return;
    }
  }

  private removeWaiter(w: object): void {
    const idx = this.waiters.indexOf(w as never);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }
}

export async function writeAdbCommand(sock: net.Socket, cmd: string): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    sock.write(encodeMessage(cmd), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function expectOkayReader(reader: SocketReader, ctx: string): Promise<void> {
  const status = await reader.readExact(4, PING_TIMEOUT_MS);
  const s = status.toString('ascii');
  if (s === 'OKAY') return;
  if (s === 'FAIL') {
    const lenBuf = await reader.readExact(4, PING_TIMEOUT_MS);
    const len = Number.parseInt(lenBuf.toString('ascii'), 16);
    const data = await reader.readExact(len, PING_TIMEOUT_MS);
    throw new Error(`${ctx}: backend FAIL: ${data.toString('utf8')}`);
  }
  throw new Error(`${ctx}: backend bad status: ${s}`);
}
