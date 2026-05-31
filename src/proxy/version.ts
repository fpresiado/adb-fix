// ADBPD — reported ADB host server version.
//
// Critical: Android Studio and modern adb clients will issue
//   "adb server version (X) doesn't match this client (Y); killing..."
// if we report a version older than the client. We report the configured
// version (default 41 / 0x29) so all current clients accept us.

import { encodeOkayData } from './protocol.ts';

const DEFAULT_VERSION = 41;

export function getReportedVersion(): number {
  const env = process.env.ADBPD_REPORT_VERSION;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_VERSION;
}

/** Build the wire response for "host:version". */
export function encodeVersionResponse(): Buffer {
  const version = getReportedVersion();
  return encodeOkayData(version.toString(16).padStart(4, '0'));
}
