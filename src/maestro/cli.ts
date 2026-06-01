// ADBPD — `adbpd maestro run` CLI entry point.
//
// Invoked by users as:
//   bun run src/maestro/cli.ts run --device emulator-5554 path/to/flow.yaml
//
// Or via a top-level dispatcher (planned: src/cli.ts). For P4 this script
// is self-contained and connects to a running ADBPD's SQLite to allocate
// the port. If ADBPD is not running, the script fails fast with a clear
// message.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db/schema.ts';
import { TransportPool } from '../transport/pool.ts';
import { MaestroPortManager } from './port-manager.ts';
import { runMaestro } from './process-wrapper.ts';
import { getLogger } from '../utils/logger.ts';

const log = getLogger('maestro-cli');

interface Args {
  command: string;
  device?: string;
  flowFile?: string;
  extra: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { command: argv[0] ?? 'help', extra: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--device' || a === '-s') {
      out.device = argv[++i];
    } else if (a.startsWith('--device=')) {
      out.device = a.slice('--device='.length);
    } else if (out.flowFile === undefined && !a.startsWith('-')) {
      out.flowFile = a;
    } else {
      out.extra.push(a);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'run') {
    console.log('Usage: adbpd-maestro run --device <serial> <flow.yaml>');
    process.exit(args.command === 'help' ? 0 : 2);
  }
  if (args.device === undefined || args.flowFile === undefined) {
    console.log('Usage: adbpd-maestro run --device <serial> <flow.yaml>');
    process.exit(2);
  }
  if (!existsSync(args.flowFile)) {
    console.error(`flow file not found: ${args.flowFile}`);
    process.exit(2);
  }

  // We connect to the same SQLite the running daemon uses. The pool here is
  // a thin proxy — for P4 we only need the device's transport to be in the
  // running daemon's pool. The CLI itself does not maintain transports.
  //
  // Pragmatic: P4 ships with a "shared DB only" model. The CLI assumes
  // ADBPD is running, opens the DB to allocate a port, runs the forward
  // via the stock adb on 5037 (which is ADBPD), and spawns Maestro.

  const dbPath = process.env.ADBPD_DB_PATH ?? join(process.cwd(), 'data', 'adbpd.db');
  const db = openDb(dbPath);

  // The CLI cannot reach back into the daemon's in-memory TransportPool, so
  // it constructs a thin fake pool with just enough to make `forward` work.
  // The pool only needs `.get(serial)` returning something whose
  // `state === 'online'` and `instanceof HybridBackendTransport`. P4-tight
  // bound: we shell out to `adb -P 5037 -s <serial> forward` instead.
  //
  // We simulate that by using a tiny shim transport.
  const port = await allocatePortAndForward(db, args.device, args.flowFile);

  log.info({ device: args.device, hostPort: port.hostPort }, 'forward established, running maestro');
  const maestroPath = process.env.ADBPD_MAESTRO_PATH ?? 'C:/Users/plusu/.maestro/bin/maestro.bat';
  let exitCode = 1;
  try {
    const proc = Bun.spawn([maestroPath, '--device', args.device, 'test', args.flowFile, ...args.extra], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    });
    exitCode = await proc.exited;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'maestro spawn failed');
    exitCode = 127;
  } finally {
    // Always release the port allocation, regardless of how maestro exited.
    try {
      await removeForward(args.device, port.hostPort);
    } catch {
      /* best effort */
    }
    db.query('UPDATE maestro_ports SET released_at = ? WHERE id = ?').run(Date.now(), port.id);
  }

  db.close();
  process.exit(exitCode);
}

interface AllocatedPort {
  id: number;
  hostPort: number;
}

async function allocatePortAndForward(
  db: import('bun:sqlite').Database,
  serial: string,
  flowFile: string,
): Promise<AllocatedPort> {
  const RANGE_START = 7100;
  const RANGE_END = 7200;
  const used = new Set(
    db
      .query<{ host_port: number }, []>(
        'SELECT host_port FROM maestro_ports WHERE released_at IS NULL',
      )
      .all()
      .map((r) => r.host_port),
  );
  let hostPort = -1;
  for (let p = RANGE_START; p <= RANGE_END; p++) {
    if (!used.has(p)) {
      hostPort = p;
      break;
    }
  }
  if (hostPort === -1) {
    throw new Error(`no free maestro host port in [${RANGE_START}, ${RANGE_END}]`);
  }

  // Use the running ADBPD on 5037 to create the device-side forward.
  const adb = process.env.ADBPD_ADB_PATH ?? 'C:/Android/platform-tools/adb.exe';
  const fwdProc = Bun.spawn([adb, '-P', '5037', '-s', serial, 'forward', `tcp:${hostPort}`, 'tcp:7001'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = await new Response(fwdProc.stderr).text();
  const code = await fwdProc.exited;
  if (code !== 0) {
    throw new Error(`adb forward failed (exit ${code}): ${stderr.trim()}`);
  }

  const stmt = db.query<{ id: number }, [string, number, number, string, number]>(
    `INSERT INTO maestro_ports (serial, host_port, device_port, flow_file, allocated_at)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const row = stmt.get(serial, hostPort, 7001, flowFile, Date.now());
  if (row === null) throw new Error('failed to insert maestro_ports row');
  return { id: row.id, hostPort };
}

async function removeForward(serial: string, hostPort: number): Promise<void> {
  const adb = process.env.ADBPD_ADB_PATH ?? 'C:/Android/platform-tools/adb.exe';
  const proc = Bun.spawn([adb, '-P', '5037', '-s', serial, 'forward', '--remove', `tcp:${hostPort}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await proc.exited;
}

main().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
