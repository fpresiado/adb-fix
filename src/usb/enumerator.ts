// ADBPD — USB device enumerator.
//
// USB enumeration is chicken-and-egg: only an adb server can speak the
// Windows USB driver to list connected phones, but the per-device backends
// we want to run with `--one-device <serial>` can't list devices themselves.
//
// Solution (per P3 spike on 2026-05-31): spin up a TRANSIENT enumeration
// adb-server on a private port, ask it for the device list, then kill it.
// This releases USB ownership cleanly before per-device backends start.
//
// The enumeration server runs WITHOUT `--one-device`, so it sees all
// physical USB devices. We filter out emulators (which discoverEmulators
// already handles) by checking the serial format: emulator serials look
// like "emulator-5554"; physical devices have a manufacturer serial number.

import { getLogger } from '../utils/logger.ts';

const log = getLogger('usb-enumerator');

const ENUM_READY_TIMEOUT_MS = 8_000;
const ENUM_READY_POLL_MS = 200;

export interface UsbDevice {
  serial: string;
  model: string | undefined;
  product: string | undefined;
  transportId: string | undefined;
}

export interface UsbEnumeratorOptions {
  /** Stock adb binary, e.g., C:/Android/platform-tools/adb.exe */
  adbBinaryPath: string;
  /** Private TCP port for the enumeration server. */
  enumPort: number;
}

/**
 * Spin up a transient enumeration adb-server, list devices, kill it.
 * Returns ONLY physical USB devices (filters out emulator-* serials).
 */
export async function enumerateUsbDevices(
  opts: UsbEnumeratorOptions,
): Promise<UsbDevice[]> {
  log.debug({ enumPort: opts.enumPort }, 'starting enumeration server');

  const env = { ANDROID_ADB_SERVER_PORT: String(opts.enumPort) };

  // 1. Start the enumeration server (no --one-device → sees all USB).
  const startProc = Bun.spawn([opts.adbBinaryPath, 'start-server'], {
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await startProc.exited;

  try {
    // 2. Wait for it to be ready and list devices.
    const deadline = Date.now() + ENUM_READY_TIMEOUT_MS;
    let raw = '';
    while (Date.now() < deadline) {
      try {
        raw = await runAdbCommand(opts.adbBinaryPath, env, ['devices', '-l']);
        if (raw.includes('List of devices attached')) break;
      } catch (err) {
        log.debug({ err: asError(err).message }, 'enum server not ready');
      }
      await sleep(ENUM_READY_POLL_MS);
    }
    if (!raw.includes('List of devices attached')) {
      log.warn('enumeration server did not become ready in time');
      return [];
    }

    return parseDevicesLong(raw);
  } finally {
    // 3. Kill the enumeration server so per-device backends can claim USB.
    try {
      const killProc = Bun.spawn([opts.adbBinaryPath, 'kill-server'], {
        env: { ...process.env, ...env },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await killProc.exited;
      // Give Windows USB stack time to release the device before per-device
      // backends try to claim it. Without this, the next adb server that
      // tries `--one-device <serial>` reports the device as "offline".
      await sleep(4000);
    } catch (err) {
      log.warn({ err }, 'failed to kill enumeration server');
    }
  }
}

/** Parse `adb devices -l` output into UsbDevice records. */
export function parseDevicesLong(raw: string): UsbDevice[] {
  const out: UsbDevice[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('List of devices')) continue;
    // Format: <serial>\t<state>\tproduct:X model:Y device:Z transport_id:N
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0]!;
    const state = parts[1]!;
    if (state !== 'device' && state !== 'authorized') continue;
    // Filter out emulators — discoverEmulators handles those separately.
    if (serial.startsWith('emulator-')) continue;

    const meta = parseKvParts(parts.slice(2));
    out.push({
      serial,
      model: meta['model'],
      product: meta['product'],
      transportId: meta['transport_id'],
    });
  }
  return out;
}

function parseKvParts(parts: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    const colon = p.indexOf(':');
    if (colon === -1) continue;
    out[p.slice(0, colon)] = p.slice(colon + 1);
  }
  return out;
}

async function runAdbCommand(
  bin: string,
  env: Record<string, string>,
  args: readonly string[],
): Promise<string> {
  const proc = Bun.spawn([bin, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutText = await new Response(proc.stdout).text();
  await proc.exited;
  return stdoutText;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
