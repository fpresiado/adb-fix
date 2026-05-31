// ADBPD — main entry point.

import { getLogger } from './utils/logger.ts';
import { SmartSocketProxy } from './proxy/smart-socket.ts';
import { TransportPool } from './transport/pool.ts';
import { discoverEmulators } from './emulator/discover.ts';
import { EmulatorTransport } from './transport/emulator.ts';
import { UsbBridgeTransport } from './transport/usb-bridge.ts';
import { enumerateUsbDevices } from './usb/enumerator.ts';
import { findFreePort } from './utils/port-finder.ts';

const log = getLogger('main');

const ADB_PATH = process.env.ADBPD_ADB_PATH ?? 'C:/Android/platform-tools/adb.exe';
const BACKEND_PORT_BASE = Number.parseInt(process.env.ADBPD_BACKEND_PORT_BASE ?? '5040', 10);
const ENUM_PORT = Number.parseInt(process.env.ADBPD_ENUM_PORT ?? '5039', 10);

async function main(): Promise<void> {
  log.info({ pid: process.pid, version: '0.1.0' }, 'ADBPD starting');

  const pool = new TransportPool();
  let nextBackendPort = BACKEND_PORT_BASE;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown initiated');
    try {
      for (const t of pool.all()) {
        try {
          await t.disconnect();
        } catch (err) {
          log.warn({ serial: t.serial, err }, 'transport disconnect error');
        }
      }
      await proxy.stop();
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

  // 1. Discover + attach any running emulators.
  const emulators = await discoverEmulators();
  for (const em of emulators) {
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
      } catch (err) {
        log.error({ serial: dev.serial, err }, 'failed to attach USB device');
      }
    }
  } catch (err) {
    log.error({ err }, 'USB enumeration failed');
  }

  log.info({ devices: pool.all().length }, 'ADBPD ready');
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
