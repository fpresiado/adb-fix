// ADBPD — host: command router.
//
// Receives parsed HostCommand structs and produces the wire response.
// For P1 this implements every protocol command that does NOT require routing
// to a live device: version, devices, devices-l, features, host-features,
// list-forward, kill, track-devices. Transport-bound commands (shell:, sync:,
// forward:) are added in P2/P3 alongside the transport implementations.

import { getLogger } from '../utils/logger.ts';
import type { TransportPool } from '../transport/pool.ts';
import { encodeFail, encodeOkay, encodeOkayData } from './protocol.ts';
import type { HostCommand, TransportSelector } from './protocol.ts';
import { encodeVersionResponse } from './version.ts';

const log = getLogger('proxy-router');

/** Host-features set we advertise. Mirror the modern adb baseline. */
const HOST_FEATURES = [
  'shell_v2',
  'cmd',
  'stat_v2',
  'ls_v2',
  'fixed_push_mkdir',
  'apex',
  'abb',
  'fixed_push_symlink_timestamp',
  'abb_exec',
  'remount_shell',
  'track_app',
  'sendrecv_v2',
  'sendrecv_v2_brotli',
  'sendrecv_v2_lz4',
  'sendrecv_v2_zstd',
  'sendrecv_v2_dry_run_send',
];

export interface RouterDeps {
  pool: TransportPool;
  /** Triggered on host:kill — daemon shutdown. */
  onKill(): void;
}

/**
 * Handle a fully-parsed host command. The return value is either:
 *   - { wire: Buffer; transportTo?: string } — write to client and continue
 *   - { wire: Buffer; closeAfter: true } — write, then close socket
 *   - { upgradeTo: 'transport'; serial } — switch socket to device transport
 *
 * For P1, no commands require an upgrade; transport-* responses are stubbed
 * with FAIL because no transports exist yet. Tests cover the protocol shape.
 */
export type RouterReply =
  | { wire: Buffer; closeAfter?: boolean }
  | { upgradeTo: 'transport'; serial: string; wire: Buffer };

export function handleHostCommand(
  cmd: HostCommand,
  deps: RouterDeps,
): RouterReply {
  switch (cmd.kind) {
    case 'version':
      return { wire: encodeVersionResponse() };

    case 'kill':
      log.info('host:kill received');
      deps.onKill();
      return { wire: encodeOkay(), closeAfter: true };

    case 'devices':
      return { wire: encodeOkayData(formatDeviceList(deps.pool, cmd.long)) };

    case 'track-devices':
      // First snapshot; the smart-socket layer keeps the socket open and pushes
      // updates as the pool emits changes (wired in smart-socket.ts).
      // Modern Studio sends track-devices-l (long-format) — cmd.long flag.
      return { wire: encodeOkayData(formatDeviceList(deps.pool, cmd.long)) };

    case 'features':
    case 'host-features':
      return { wire: encodeOkayData(HOST_FEATURES.join(',')) };

    case 'list-forward':
      return { wire: encodeOkayData('') };

    case 'killforward':
    case 'killforward-all':
      return { wire: encodeOkay() };

    case 'forward':
      // No transport in P1 → fail gracefully.
      return { wire: encodeFail('no devices/emulators found') };

    case 'transport':
      return handleTransport(cmd.selector, deps);

    case 'emulator-probe':
      // adb is asking us to register an emulator at the given console port.
      // We ignore politely (ADBPD does its own discovery) and reply OKAY so
      // adb stops retrying.
      return { wire: encodeOkay() };

    case 'unknown':
      log.warn({ raw: cmd.raw }, 'unknown host command');
      return { wire: encodeFail(`unknown command: ${cmd.raw}`) };
  }
}

function handleTransport(selector: TransportSelector, deps: RouterDeps): RouterReply {
  if (selector.mode === 'serial') {
    const t = deps.pool.get(selector.serial);
    if (t === undefined || t.state !== 'online') {
      return { wire: encodeFail(`device '${selector.serial}' not found`) };
    }
    return { wire: encodeOkay(), upgradeTo: 'transport', serial: selector.serial };
  }
  const picked = deps.pool.pick(selector.mode);
  if (picked === undefined) {
    return { wire: encodeFail(`no ${selector.mode === 'any' ? 'devices' : selector.mode + ' devices'} found`) };
  }
  return { wire: encodeOkay(), upgradeTo: 'transport', serial: picked.serial };
}

/**
 * Translate ADBPD's internal TransportState into the ADB wire-protocol
 * state word. Stock adb writes "device" for a ready/online device on the
 * wire — NOT "online". dadb (used by Maestro 2.5+, scrcpy, others) parses
 * strictly: only "device" means usable. Before this translation Maestro
 * could not see any of ADBPD's devices because every entry was reported
 * as "online" which dadb treats as unknown.
 *
 * Reference: AOSP system/core/adb/transport.cpp ConnectionStateName().
 */
function wireState(state: string): string {
  switch (state) {
    case 'online':
      return 'device';
    case 'recovery':
      return 'recovery';
    case 'unauthorized':
      return 'unauthorized';
    case 'offline':
    case 'disconnected':
    default:
      return 'offline';
  }
}

export function formatDeviceList(pool: TransportPool, long: boolean): string {
  const lines: string[] = [];
  for (const entry of pool.list()) {
    const ws = wireState(entry.state);
    if (long) {
      // Long format with transport_id (required by modern dadb-based clients
      // including Maestro 2.5+). Note the SPACES (not tabs) between fields
      // after the state column — stock adb uses spaces here.
      lines.push(
        `${entry.serial}\t${ws} product:${entry.product ?? 'unknown'} model:${entry.model ?? 'unknown'} device:${entry.serial} transport_id:${entry.transportId}`,
      );
    } else {
      lines.push(`${entry.serial}\t${ws}`);
    }
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}
