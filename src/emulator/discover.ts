// ADBPD — emulator port discovery.
//
// Android emulators expose adbd on consecutive TCP ports:
//   even = emulator console (5554, 5556, ...)
//   odd  = adb daemon       (5555, 5557, ...)
// The serial is `emulator-<console>` (e.g., emulator-5554 → adbd on 5555).
//
// Stock adb scans 5555..5585 step 2 looking for daemons. We do the same.

import * as net from 'node:net';
import { getLogger } from '../utils/logger.ts';

const log = getLogger('emulator-discover');

const FIRST_ADB_PORT = 5555;
const LAST_ADB_PORT = 5585;
const PROBE_TIMEOUT_MS = 250;

export interface DiscoveredEmulator {
  /** e.g., "emulator-5554". */
  serial: string;
  /** Console port (5554, 5556, ...) */
  consolePort: number;
  /** adbd port (5555, 5557, ...) */
  adbPort: number;
}

/** Probe a single TCP port: returns true if something is listening. */
async function probe(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Discover currently-running emulators by probing 5555..5585 step 2. */
export async function discoverEmulators(): Promise<DiscoveredEmulator[]> {
  const found: DiscoveredEmulator[] = [];
  for (let p = FIRST_ADB_PORT; p <= LAST_ADB_PORT; p += 2) {
    if (await probe(p)) {
      const consolePort = p - 1;
      found.push({
        serial: `emulator-${consolePort}`,
        consolePort,
        adbPort: p,
      });
      log.debug({ adbPort: p, consolePort }, 'emulator detected');
    }
  }
  log.info({ count: found.length }, 'emulator discovery complete');
  return found;
}
