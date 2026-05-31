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

const log = getLogger('main');

const ADB_PATH = process.env.ADBPD_ADB_PATH ?? 'C:/Android/platform-tools/adb.exe';
const EMULATOR_BIN = process.env.ADBPD_EMULATOR_BIN ?? 'C:/Android/sdk/emulator/emulator.exe';
const DB_PATH = process.env.ADBPD_DB_PATH ?? 'M:/FutureApps/adb-proxy-daemon/adbpd.sqlite';
const BACKEND_PORT_BASE = Number.parseInt(process.env.ADBPD_BACKEND_PORT_BASE ?? '5040', 10);
const ENUM_PORT = Number.parseInt(process.env.ADBPD_ENUM_PORT ?? '5039', 10);
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

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown initiated');
    try {
      watchdog.stop();
      telemetry.stop();
      for (const t of pool.all()) {
        try {
          await t.disconnect();
        } catch (err) {
          log.warn({ serial: t.serial, err }, 'transport disconnect error');
        }
      }
      if (emulatorManager !== undefined) {
        for (const m of emulatorManager.list()) {
          try {
            await emulatorManager.stopAvd(m.avdName, ADB_PATH);
          } catch (err) {
            log.warn({ avdName: m.avdName, err }, 'stopAvd error');
          }
        }
      }
      await proxy.stop();
      db.close();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    log.info('ADBPD stopped');
    process.exit(0);
  };

  const proxy = new SmartSocketProxy({
    pool,
    onKill: () => void shutdown('host:kill'),
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

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
      events.push('device.online', t.serial, { via: 'discovery' });
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
  const watchdog = new Watchdog({
    pool,
    events,
    pingIntervalMs: 5_000,
    pingTimeoutMs: 3_000,
    failThreshold: 3,
    onWedge: async (t, incidentId) => {
      const r1 = await recoverTransport(t, { backoffsMs: [0, 5_000, 15_000] });
      if (r1.success) {
        log.info({ serial: t.serial, attempts: r1.attempts }, 'recovered via transport reconnect');
        return;
      }
      const m = managed.get(t.serial);
      if (m === undefined || emulatorManager === undefined) {
        log.error({ serial: t.serial, incidentId }, 'transport reconnect exhausted; not a managed AVD — leaving offline');
        return;
      }
      log.warn({ serial: t.serial, avdName: m.avdName }, 'transport reconnect exhausted; relaunching managed AVD');
      try {
        await emulatorManager.stopAvd(m.avdName, ADB_PATH);
      } catch {
        /* may already be dead */
      }
      try {
        const state = await emulatorManager.startAvd(m);
        events.push('emulator.started', t.serial, {
          avdName: m.avdName,
          pid: state.pid,
          via: 'wedge-recovery',
        });
        const r2 = await recoverTransport(t, { backoffsMs: [0, 5_000, 10_000, 10_000] });
        if (r2.success) {
          log.info({ serial: t.serial, attempts: r2.attempts }, 'recovered via AVD relaunch');
        } else {
          log.error({ serial: t.serial, incidentId }, 'AVD relaunch did not restore transport');
        }
      } catch (err) {
        log.error({ serial: t.serial, err }, 'AVD relaunch threw');
      }
    },
  });
  watchdog.start();
  telemetry.start();

  log.info(
    { devices: pool.all().length, managed: managed.size, fmEnabled: fm.enabled },
    'ADBPD ready',
  );
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
