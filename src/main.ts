// ADBPD — main entry point.

import { getLogger } from './utils/logger.ts';
import { SmartSocketProxy } from './proxy/smart-socket.ts';
import { TransportPool } from './transport/pool.ts';
import { discoverEmulators } from './emulator/discover.ts';
import { EmulatorTransport } from './transport/emulator.ts';
import { UsbBridgeTransport } from './transport/usb-bridge.ts';
import { enumerateUsbDevices } from './usb/enumerator.ts';
import { findFreePort } from './utils/port-finder.ts';
import { openDb } from './db/schema.ts';
import { EventQueue } from './db/events.ts';
import { EmulatorManager } from './emulator/manager.ts';
import { Watchdog } from './watchdog/monitor.ts';
import { recoverTransport } from './watchdog/recovery.ts';
import { FmClient } from './fm/client.ts';
import { FmTelemetry } from './fm/telemetry.ts';
import type { HybridBackendTransport } from './transport/hybrid-backend.ts';
import { MaestroPortManager } from './maestro/port-manager.ts';
import { ControlApi } from './api/server.ts';
import { DeviceCleaner } from './lifecycle/cleanup.ts';

const log = getLogger('main');

const ADB_PATH = process.env.ADBPD_ADB_PATH ?? 'C:/Android/platform-tools/adb.exe';
const EMULATOR_BIN = process.env.ADBPD_EMULATOR_BIN ?? 'C:/Android/sdk/emulator/emulator.exe';
const DB_PATH = process.env.ADBPD_DB_PATH ?? 'M:/FutureApps/adb-proxy-daemon/adbpd.sqlite';
const BACKEND_PORT_BASE = Number.parseInt(process.env.ADBPD_BACKEND_PORT_BASE ?? '5040', 10);
const ENUM_PORT = Number.parseInt(process.env.ADBPD_ENUM_PORT ?? '5039', 10);
const API_HTTP_PORT = Number.parseInt(process.env.ADBPD_API_HTTP_PORT ?? '3002', 10);
const API_WS_PORT = Number.parseInt(process.env.ADBPD_API_WS_PORT ?? '3003', 10);
// `ADBPD_MANAGED_AVDS=Pixel_9_Pro@5554,Pixel_8@5556` — comma-separated AVDs
// that ADBPD will launch + manage. These get auto-relaunched on wedge.
const MANAGED_AVDS = process.env.ADBPD_MANAGED_AVDS ?? '';

interface ManagedAvd {
  avdName: string;
  emulatorBinary: string;
  consolePort: number;
}

function parseManagedAvds(raw: string): ManagedAvd[] {
  if (raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const at = entry.lastIndexOf('@');
      if (at < 0) throw new Error(`ADBPD_MANAGED_AVDS entry missing @port: ${entry}`);
      const avdName = entry.slice(0, at);
      const consolePort = Number.parseInt(entry.slice(at + 1), 10);
      if (Number.isNaN(consolePort)) throw new Error(`bad console port in ${entry}`);
      return { avdName, emulatorBinary: EMULATOR_BIN, consolePort };
    });
}

async function main(): Promise<void> {
  log.info({ pid: process.pid, version: '0.1.0' }, 'ADBPD starting');

  const db = openDb(DB_PATH);
  const events = new EventQueue(db);

  const pool = new TransportPool();
  let nextBackendPort = BACKEND_PORT_BASE;

  // managed[serial] holds the AVD config so the watchdog can relaunch it.
  const managed = new Map<string, ManagedAvd>();
  const managedAvds = parseManagedAvds(MANAGED_AVDS);
  const emulatorManager = managedAvds.length > 0 ? new EmulatorManager() : undefined;

  const fm = new FmClient({
    enabled: false,
    url: process.env.ADBPD_FM_URL ?? 'http://localhost:3001',
    installId: process.env.ADBPD_INSTALL_ID ?? 'adbpd-local',
    token: process.env.ADBPD_FM_TOKEN ?? 'unset',
  });
  const telemetry = new FmTelemetry({ events, client: fm });

  const maestroPorts = new MaestroPortManager({ db, pool });
  const cleaner = new DeviceCleaner({ db, pool });
  const STARTED_AT = Date.now();

  // Per-device cleanup sweep on transport state-change → offline/disconnected.
  // The TransportPool fires onChange when any transport's state changes; we
  // diff against the previous state snapshot to detect downward transitions.
  const lastState = new Map<string, string>();
  pool.onChange(() => {
    for (const t of pool.all()) {
      const prev = lastState.get(t.serial);
      lastState.set(t.serial, t.state);
      if (prev !== undefined && prev !== t.state) {
        if (t.state === 'offline' || t.state === 'disconnected') {
          log.info(
            { serial: t.serial, prev, next: t.state },
            'device disconnected — running cleanup sweep',
          );
          void cleaner.sweepDevice(t.serial).catch((err) => {
            log.error({ serial: t.serial, err }, 'cleanup sweep failed');
          });
        }
      }
    }
  });

  // These are constructed during boot; the shutdown handler may fire BEFORE
  // any of them exist (e.g. SIGTERM during early init), so each ref is
  // nullable and the handler guards on undefined. Without this, an early
  // signal triggers a TDZ ReferenceError that NSSM then crash-loops on.
  let proxy: SmartSocketProxy | undefined;
  let watchdog: Watchdog | undefined;
  let api: ControlApi | undefined;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown initiated');
    try {
      // (1) Stop new work coming in.
      watchdog?.stop();
      telemetry.stop();
      if (api !== undefined) await api.stop();

      // (2) Run a full cleanup sweep — kill outstanding Maestro PIDs, remove
      //     forwards, release ports, verify kernel state. This MUST happen
      //     before transport disconnect because removeForward needs the
      //     transport's backend to still be reachable.
      try {
        await cleaner.sweepAll();
      } catch (err) {
        log.warn({ err }, 'sweepAll error during shutdown');
      }

      // (3) Disconnect every transport (closes the per-device backends).
      for (const t of pool.all()) {
        try {
          await t.disconnect();
        } catch (err) {
          log.warn({ serial: t.serial, err }, 'transport disconnect error');
        }
      }

      // (4) Stop any AVDs we own.
      if (emulatorManager !== undefined) {
        for (const m of emulatorManager.list()) {
          try {
            await emulatorManager.stopAvd(m.avdName, ADB_PATH);
          } catch (err) {
            log.warn({ avdName: m.avdName, err }, 'stopAvd error');
          }
        }
      }

      // (5) Force-close the 5037 listener AND every live bridge socket.
      //     Without this, the listen socket lingers in the Windows kernel
      //     and the next service start can't bind.
      if (proxy !== undefined) await proxy.stop();

      db.close();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    log.info('ADBPD stopped');
    process.exit(0);
  };

  proxy = new SmartSocketProxy({
    pool,
    onKill: () => void shutdown('host:kill'),
  });

  // Process signal handlers. We register all three because:
  //   - SIGINT: ctrl-C in a foreground shell.
  //   - SIGTERM: NSSM, systemd-style supervisors, `taskkill /T /F`.
  //   - SIGBREAK: ctrl-break + how NSSM signals "stop with grace" on Win.
  // We do NOT rely on process.on('exit', ...) — Bun on Windows does not
  // reliably fire it while a net.Server is attached, so cleanup would be
  // skipped on supervisor-initiated stop.
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  try {
    // SIGBREAK is Windows-only; throws on POSIX. Wrap so the script still
    // runs on dev macOS/Linux without crashing here.
    process.on('SIGBREAK' as NodeJS.Signals, () => void shutdown('SIGBREAK'));
  } catch {
    /* not Windows — fine */
  }

  await proxy.start();

  // 1a. Launch + attach any MANAGED AVDs. These are owned by ADBPD and will be
  //     auto-relaunched by the watchdog if they wedge.
  if (emulatorManager !== undefined) {
    log.info({ topology: emulatorManager.getTopology() }, 'NUMA topology');
    for (const avd of managedAvds) {
      try {
        const state = await emulatorManager.startAvd({
          avdName: avd.avdName,
          emulatorBinary: avd.emulatorBinary,
          consolePort: avd.consolePort,
        });
        events.push('emulator.started', `emulator-${avd.consolePort}`, {
          avdName: avd.avdName,
          pid: state.pid,
          numaNode: state.numaNode,
          affinityMask: `0x${state.affinityMask.toString(16)}`,
        });
        const backendPort = await findFreePort(nextBackendPort);
        nextBackendPort = backendPort + 1;
        const t = new EmulatorTransport({
          serial: `emulator-${avd.consolePort}`,
          consolePort: avd.consolePort,
          adbPort: avd.consolePort + 1,
          adbBinaryPath: ADB_PATH,
          backendPort,
          // Cold-boot a fresh AVD from a Windows service can take 60-90s.
          // The default 20s was tuned for warm/USB and times out before
          // `device` shows up, leaving managed.set() unreached — meaning
          // the watchdog can't auto-relaunch on wedge.
          readyTimeoutMs: 120_000,
        });
        await t.connect();
        pool.add(t);
        managed.set(t.serial, avd);
        events.push('device.online', t.serial, { via: 'managed-launch' });
      } catch (err) {
        log.error({ avd, err }, 'failed to launch managed AVD');
      }
    }
  }

  // 1b. Discover + attach any externally-running emulators (not managed by us).
  const emulators = await discoverEmulators();
  for (const em of emulators) {
    if (pool.get(em.serial) !== undefined) continue; // already managed above
    const backendPort = await findFreePort(nextBackendPort);
    nextBackendPort = backendPort + 1;
    const t = new EmulatorTransport({
      serial: em.serial,
      consolePort: em.consolePort,
      adbPort: em.adbPort,
      adbBinaryPath: ADB_PATH,
      backendPort,
    });
    try {
      await t.connect();
      pool.add(t);
      // If this discovered emulator corresponds to a configured managed AVD
      // (a managed-launch above timed out + the AVD finished booting), claim
      // it for the managed registry so the watchdog can auto-relaunch on wedge.
      const claim = managedAvds.find((a) => `emulator-${a.consolePort}` === em.serial);
      if (claim !== undefined && !managed.has(em.serial)) {
        managed.set(em.serial, claim);
        events.push('device.online', t.serial, { via: 'managed-claim-via-discovery' });
      } else {
        events.push('device.online', t.serial, { via: 'discovery' });
      }
    } catch (err) {
      log.error({ serial: em.serial, err }, 'failed to attach emulator');
    }
  }

  // 2. Discover + attach any physical USB devices via a transient enumeration
  //    server. Each USB device gets its own private backend with --one-device.
  try {
    const usbDevices = await enumerateUsbDevices({
      adbBinaryPath: ADB_PATH,
      enumPort: ENUM_PORT,
    });
    log.info({ count: usbDevices.length }, 'USB enumeration complete');
    for (const dev of usbDevices) {
      const backendPort = await findFreePort(nextBackendPort);
      nextBackendPort = backendPort + 1;
      const t = new UsbBridgeTransport({
        serial: dev.serial,
        adbBinaryPath: ADB_PATH,
        backendPort,
        model: dev.model,
        product: dev.product,
      });
      try {
        await t.connect();
        pool.add(t);
        events.push('device.online', t.serial, { via: 'usb-enumeration' });
      } catch (err) {
        log.error({ serial: dev.serial, err }, 'failed to attach USB device');
      }
    }
  } catch (err) {
    log.error({ err }, 'USB enumeration failed');
  }

  // 3. Watchdog: pings every device every 5s; opens incident on 3 consecutive
  //    failures; recovery cascade fires; for managed AVDs, relaunches if
  //    transport-level reconnect can't restore.
  watchdog = new Watchdog({
    pool,
    events,
    pingIntervalMs: 5_000,
    pingTimeoutMs: 3_000,
    failThreshold: 3,
    onWedge: async (t, incidentId) => {
      const m = managed.get(t.serial);

      // Fast-path: if this is a managed AVD and the VM process is dead,
      // skip the transport-reconnect cascade entirely — only an AVD
      // relaunch can fix a dead-VM wedge. Cuts ~80s of wasted reconnect.
      // Per blueprint §7.1: "If PID dead: emulator crashed → restart with same config."
      if (m !== undefined && emulatorManager !== undefined && !emulatorManager.isVmAlive(m.avdName)) {
        log.warn(
          { serial: t.serial, avdName: m.avdName },
          'fast-path: VM PID dead, skipping reconnect cascade — direct relaunch',
        );
        await relaunchManagedAvd(t, m, incidentId);
        return;
      }

      // Slow-path (transient backend hiccup, USB ownership lost, etc.):
      // try transport-level reconnect first.
      const r1 = await recoverTransport(t, { backoffsMs: [0, 5_000, 15_000] });
      if (r1.success) {
        log.info({ serial: t.serial, attempts: r1.attempts }, 'recovered via transport reconnect');
        return;
      }
      if (m === undefined || emulatorManager === undefined) {
        log.error(
          { serial: t.serial, incidentId },
          'transport reconnect exhausted; not a managed AVD — leaving offline',
        );
        return;
      }
      log.warn(
        { serial: t.serial, avdName: m.avdName },
        'transport reconnect exhausted; relaunching managed AVD',
      );
      await relaunchManagedAvd(t, m, incidentId);
    },
  });
  async function relaunchManagedAvd(
    t: import('./transport/base.ts').DeviceTransport,
    m: ManagedAvd,
    incidentId: number,
  ): Promise<void> {
    if (emulatorManager === undefined) return;
    try {
      await emulatorManager.stopAvd(m.avdName, ADB_PATH);
    } catch {
      /* already dead */
    }
    try {
      const state = await emulatorManager.startAvd(m);
      events.push('emulator.started', t.serial, {
        avdName: m.avdName,
        pid: state.pid,
        via: 'wedge-recovery',
      });
      const r = await recoverTransport(t, { backoffsMs: [0, 5_000, 10_000, 10_000] });
      if (r.success) {
        log.info({ serial: t.serial, attempts: r.attempts }, 'recovered via AVD relaunch');
      } else {
        log.error({ serial: t.serial, incidentId }, 'AVD relaunch did not restore transport');
      }
    } catch (err) {
      log.error({ serial: t.serial, err }, 'AVD relaunch threw');
    }
  }

  watchdog.start();
  telemetry.start();

  // 4. Control API — HTTP 3002 + WebSocket 3003.
  api = new ControlApi({
    pool,
    events,
    proxy,
    fm,
    emulatorManager,
    maestroPorts,
    managedRegistry: managed,
    configView: () => ({
      fmEnabled: fm.enabled,
      fmUrl: fm.url,
      installId: fm.installId,
      pingIntervalMs: 5000,
      pingTimeoutMs: 3000,
      failThreshold: 3,
    }),
    setFmEnabled: (en) => {
      fm.setEnabled(en);
      if (en) telemetry.start();
      else telemetry.stop();
    },
    restartProxy: async () => {
      await proxy.stop();
      await proxy.start();
    },
    startedAt: STARTED_AT,
  });
  await api.start(API_HTTP_PORT, API_WS_PORT);

  log.info(
    {
      devices: pool.all().length,
      managed: managed.size,
      fmEnabled: fm.enabled,
      apiHttp: API_HTTP_PORT,
      apiWs: API_WS_PORT,
    },
    'ADBPD ready',
  );
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
