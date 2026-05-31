// ADBPD — Maestro process wrapper.
//
// Spawns `maestro --device <serial> test <flow>` after allocating a unique
// host port and creating the per-device `adb forward tcp:<host> tcp:7001`.
// Cleans up the allocation when Maestro exits (success OR failure).
//
// Per session 3 spike: Maestro does NOT read MAESTRO_MASTER_PORT env. The
// host port + adb forward + --device flag are the only things that matter.

import { getLogger } from '../utils/logger.ts';
import type { MaestroPortManager } from './port-manager.ts';

const log = getLogger('maestro-wrapper');

export interface MaestroRunOptions {
  serial: string;
  flowFile: string;
  /** Path to the maestro binary; defaults to "maestro". */
  maestroBinary?: string;
  /** Extra args appended after `--device <serial> test <flow>`. */
  extraArgs?: readonly string[];
  /**
   * Optional spawner override (tests). Default `Bun.spawn` returning the
   * pid and an `exited` promise.
   */
  spawnMaestro?(args: readonly string[]): { pid: number; exited: Promise<number> };
}

export interface MaestroRunResult {
  exitCode: number;
  hostPort: number;
  allocationId: number;
  durationMs: number;
}

export async function runMaestro(
  ports: MaestroPortManager,
  opts: MaestroRunOptions,
): Promise<MaestroRunResult> {
  const start = Date.now();
  const allocation = await ports.allocate(opts.serial, opts.flowFile);
  log.info(
    { serial: opts.serial, hostPort: allocation.hostPort, flowFile: opts.flowFile },
    'starting maestro',
  );

  const binary = opts.maestroBinary ?? 'maestro';
  const args = [
    '--device',
    opts.serial,
    'test',
    opts.flowFile,
    ...(opts.extraArgs ?? []),
  ];

  let pid = 0;
  let exitCode = 1;
  try {
    const proc = (opts.spawnMaestro ?? defaultSpawn)([binary, ...args]);
    pid = proc.pid;
    exitCode = await proc.exited;
  } finally {
    await ports.release(allocation.id);
  }

  const durationMs = Date.now() - start;
  log.info(
    { serial: opts.serial, pid, exitCode, durationMs, hostPort: allocation.hostPort },
    'maestro finished',
  );
  return {
    exitCode,
    hostPort: allocation.hostPort,
    allocationId: allocation.id,
    durationMs,
  };
}

function defaultSpawn(argv: readonly string[]): { pid: number; exited: Promise<number> } {
  const proc = Bun.spawn(argv as string[], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  return { pid: proc.pid, exited: proc.exited };
}
