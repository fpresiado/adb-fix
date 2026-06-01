// ADBPD — ADB host protocol codec
//
// The ADB host protocol used between clients (adb.exe, Android Studio,
// Maestro, gradlew, scrcpy) and the ADB host server on :5037 is a simple
// length-prefixed ASCII protocol:
//
//   request:  <4-byte-hex-length><ASCII-payload>
//   response: "OKAY" | "FAIL" + optional data with the same length prefix
//
// We need to speak this verbatim so existing clients connect without change.
//
// References: AOSP `system/core/adb/SERVICES.TXT`, `protocol.txt`.

export const OKAY = Buffer.from('OKAY', 'ascii');
export const FAIL = Buffer.from('FAIL', 'ascii');

/** Encode a length-prefixed ASCII payload (request OR data response). */
export function encodeMessage(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** Encode an OKAY response with no body. */
export function encodeOkay(): Buffer {
  return Buffer.from(OKAY);
}

/** Encode an OKAY response followed by a length-prefixed payload. */
export function encodeOkayData(payload: string): Buffer {
  return Buffer.concat([OKAY, encodeMessage(payload)]);
}

/** Encode a FAIL response with a length-prefixed error string. */
export function encodeFail(message: string): Buffer {
  return Buffer.concat([FAIL, encodeMessage(message)]);
}

/**
 * Try to parse a single request from `buf`. Returns the payload string and the
 * number of bytes consumed, or `null` if the buffer does not yet contain a
 * full request (caller should wait for more data).
 */
export function tryParseRequest(
  buf: Buffer,
): { payload: string; consumed: number } | null {
  if (buf.length < 4) return null;
  const lenHex = buf.subarray(0, 4).toString('ascii');
  const len = Number.parseInt(lenHex, 16);
  if (Number.isNaN(len)) {
    throw new Error(`ADB protocol: invalid length prefix "${lenHex}"`);
  }
  if (buf.length < 4 + len) return null;
  const payload = buf.subarray(4, 4 + len).toString('utf8');
  return { payload, consumed: 4 + len };
}

/** Classify a host:* command into a normalized verb. */
export type HostCommand =
  | { kind: 'version' }
  | { kind: 'kill' }
  | { kind: 'devices'; long: boolean }
  | { kind: 'track-devices'; long: boolean }
  | { kind: 'transport'; selector: TransportSelector }
  | { kind: 'forward'; spec: string; norebind: boolean }
  | { kind: 'killforward'; local: string }
  | { kind: 'killforward-all' }
  | { kind: 'list-forward' }
  | { kind: 'features' }
  | { kind: 'host-features' }
  | { kind: 'emulator-probe'; port: number }
  | { kind: 'unknown'; raw: string };

export type TransportSelector =
  | { mode: 'any' }
  | { mode: 'usb' }
  | { mode: 'local' }
  | { mode: 'serial'; serial: string };

export function parseHostCommand(payload: string): HostCommand {
  // All host commands start with "host:" or "host-serial:<serial>:" or
  // "host-usb:" / "host-local:". We focus on the most-common forms first.
  if (!payload.startsWith('host:') &&
      !payload.startsWith('host-serial:') &&
      !payload.startsWith('host-usb:') &&
      !payload.startsWith('host-local:')) {
    return { kind: 'unknown', raw: payload };
  }

  // host-serial:<serial>:<cmd> — selector embedded in the prefix
  if (payload.startsWith('host-serial:')) {
    const rest = payload.slice('host-serial:'.length);
    const colon = rest.indexOf(':');
    if (colon === -1) return { kind: 'unknown', raw: payload };
    const serial = rest.slice(0, colon);
    const sub = rest.slice(colon + 1);
    return mapSelectorScoped({ mode: 'serial', serial }, sub, payload);
  }
  if (payload.startsWith('host-usb:')) {
    return mapSelectorScoped({ mode: 'usb' }, payload.slice('host-usb:'.length), payload);
  }
  if (payload.startsWith('host-local:')) {
    return mapSelectorScoped({ mode: 'local' }, payload.slice('host-local:'.length), payload);
  }

  const cmd = payload.slice('host:'.length);

  if (cmd === 'version') return { kind: 'version' };
  if (cmd === 'kill') return { kind: 'kill' };
  if (cmd === 'devices') return { kind: 'devices', long: false };
  if (cmd === 'devices-l') return { kind: 'devices', long: true };
  if (cmd === 'track-devices') return { kind: 'track-devices', long: false };
  if (cmd === 'track-devices-l') return { kind: 'track-devices', long: true };
  // proto-binary track-devices format used by newer clients
  if (cmd === 'track-devices-proto-binary') return { kind: 'track-devices', long: true };
  if (cmd === 'track-devices-proto-text') return { kind: 'track-devices', long: true };
  if (cmd === 'features') return { kind: 'features' };
  if (cmd === 'host-features') return { kind: 'host-features' };
  if (cmd === 'list-forward') return { kind: 'list-forward' };
  if (cmd.startsWith('emulator:')) {
    // adb auto-discovery probe: host:emulator:<console-port>. We silently
    // accept these so adb stops retrying; ADBPD does its own discovery.
    const port = Number.parseInt(cmd.slice('emulator:'.length), 10);
    if (!Number.isNaN(port)) return { kind: 'emulator-probe', port };
  }
  if (cmd === 'killforward-all') return { kind: 'killforward-all' };

  if (cmd === 'transport-any') return { kind: 'transport', selector: { mode: 'any' } };
  if (cmd === 'transport-usb') return { kind: 'transport', selector: { mode: 'usb' } };
  if (cmd === 'transport-local') return { kind: 'transport', selector: { mode: 'local' } };
  if (cmd.startsWith('transport:')) {
    const serial = cmd.slice('transport:'.length);
    return { kind: 'transport', selector: { mode: 'serial', serial } };
  }
  if (cmd.startsWith('tport:')) {
    // "tport:" is an alternate form used by newer clients.
    const arg = cmd.slice('tport:'.length);
    if (arg === 'any') return { kind: 'transport', selector: { mode: 'any' } };
    if (arg === 'usb') return { kind: 'transport', selector: { mode: 'usb' } };
    if (arg === 'local') return { kind: 'transport', selector: { mode: 'local' } };
    if (arg.startsWith('serial:')) {
      return {
        kind: 'transport',
        selector: { mode: 'serial', serial: arg.slice('serial:'.length) },
      };
    }
  }

  if (cmd.startsWith('forward:')) {
    const rest = cmd.slice('forward:'.length);
    const norebind = rest.startsWith('norebind:');
    const spec = norebind ? rest.slice('norebind:'.length) : rest;
    return { kind: 'forward', spec, norebind };
  }
  if (cmd.startsWith('killforward:')) {
    return { kind: 'killforward', local: cmd.slice('killforward:'.length) };
  }

  return { kind: 'unknown', raw: payload };
}

/** For host-serial / host-usb / host-local: re-build the equivalent host: cmd. */
function mapSelectorScoped(
  _selector: TransportSelector,
  sub: string,
  raw: string,
): HostCommand {
  // We currently treat the scoped selector identically to its host: counterpart
  // for the routing layer's purposes — the router inspects raw payload anyway.
  // This keeps protocol coverage broad without exploding the dispatcher.
  return parseHostCommand(`host:${sub}`) ?? { kind: 'unknown', raw };
}
