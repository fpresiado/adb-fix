// ADBPD — soak harness (P9 Part 2).
//
// Runs a randomized workload against an ADBPD-managed device set for a
// configurable duration. Injects faults at scheduled marks and measures
// recovery time. Samples memory + incident state every 5 min.
//
// Usage:
//   bun run scripts/soak.ts                              # 4-hour production soak
//   bun run scripts/soak.ts --mode validation            # 30-min compressed
//   bun run scripts/soak.ts --mode custom --duration-min 120 --faults 30,60,90
//
// Outputs:
//   logs/soak-<startISO>.csv          — every operation
//   logs/soak-<startISO>-summary.md   — end-of-soak summary
//   logs/soak-<startISO>-memory.csv   — memory + incidents over time

import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';

// ─── Config ──────────────────────────────────────────────────────────

interface SoakConfig {
  mode: 'production' | 'validation' | 'custom';
  durationMs: number;
  faultMs: number[];           // injection marks (absolute ms from start)
  intervalMs: number;          // workload tick
  memSampleMs: number;         // memory sample interval
  emulatorSerial: string;      // target for fault injection
  usbSerial: string | undefined;
  adbPath: string;
  apiBase: string;
  maestroPath: string | undefined;   // skip maestro if undefined
  recoveryDeadlineMs: number;  // fault-recovery SLO (30s per spec)
}

function parseArgs(): SoakConfig {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = process.argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        args.set(key, val);
        i++;
      } else {
        args.set(key, 'true');
      }
    }
  }

  const mode = (args.get('mode') ?? 'production') as 'production' | 'validation' | 'custom';
  let durationMs: number;
  let faultMs: number[];
  if (mode === 'production') {
    durationMs = 4 * 60 * 60_000;
    faultMs = [60, 120, 180].map((m) => m * 60_000);
  } else if (mode === 'validation') {
    durationMs = 30 * 60_000;
    faultMs = [10, 20, 25].map((m) => m * 60_000);
  } else {
    durationMs = Number.parseInt(args.get('duration-min') ?? '60', 10) * 60_000;
    faultMs = (args.get('faults') ?? '15,30,45')
      .split(',')
      .map((s) => Number.parseInt(s, 10) * 60_000);
  }

  const cfg: SoakConfig = {
    mode,
    durationMs,
    faultMs,
    intervalMs: Number.parseInt(args.get('interval-sec') ?? '10', 10) * 1000,
    memSampleMs: Number.parseInt(args.get('mem-sample-min') ?? '5', 10) * 60_000,
    emulatorSerial: args.get('emulator-serial') ?? 'emulator-5554',
    usbSerial: args.get('usb-serial'),
    adbPath: args.get('adb-path') ?? process.env.ADBPD_ADB_PATH ?? 'C:/Android/platform-tools/adb.exe',
    apiBase: args.get('api') ?? 'http://127.0.0.1:3002',
    maestroPath: args.get('maestro') ?? process.env.ADBPD_MAESTRO_PATH,
    recoveryDeadlineMs: Number.parseInt(args.get('recovery-sec') ?? '30', 10) * 1000,
  };
  return cfg;
}

// ─── Operations ──────────────────────────────────────────────────────

const SHELL_COMMANDS = [
  'echo soak-tick',
  'getprop ro.product.model',
  'dumpsys battery | head -3',
  'ls /sdcard | head -5',
  'date',
  'id',
  'pm list packages | head -5',
  'getprop ro.build.version.sdk',
];

type OpType = 'shell' | 'pull' | 'maestro' | 'health';
type OpResult = 'pass' | 'fail' | 'skipped';

interface OpRecord {
  tickAt: number;
  opType: OpType;
  serial: string;
  detail: string;
  latencyMs: number;
  result: OpResult;
  error: string;
}

function pickWorkload(cfg: SoakConfig, serials: string[]): { opType: OpType; serial: string; detail: string } {
  const serial = serials[Math.floor(Math.random() * serials.length)] ?? cfg.emulatorSerial;
  const roll = Math.random();
  if (roll < 0.6) {
    const cmd = SHELL_COMMANDS[Math.floor(Math.random() * SHELL_COMMANDS.length)]!;
    return { opType: 'shell', serial, detail: cmd };
  }
  if (roll < 0.9) {
    // /system/etc/hosts is world-readable on every Android version we
    // target; /system/build.prop requires root on API 30+.
    return { opType: 'pull', serial, detail: '/system/etc/hosts' };
  }
  if (cfg.maestroPath !== undefined) {
    return { opType: 'maestro', serial, detail: 'noop' };
  }
  return { opType: 'shell', serial, detail: 'echo maestro-fallback' };
}

async function runShell(cfg: SoakConfig, serial: string, command: string): Promise<{ ok: boolean; err: string }> {
  try {
    const proc = Bun.spawn([cfg.adbPath, '-P', '5037', '-s', serial, 'shell', command], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      return { ok: false, err: (stderr || stdout).trim().slice(0, 200) };
    }
    if (stderr.includes('error:')) {
      return { ok: false, err: stderr.trim().slice(0, 200) };
    }
    return { ok: true, err: '' };
  } catch (err) {
    return { ok: false, err: errMsg(err).slice(0, 200) };
  }
}

async function runPull(cfg: SoakConfig, serial: string, remotePath: string): Promise<{ ok: boolean; err: string }> {
  const dest = `${process.env.TEMP ?? '/tmp'}/soak-pull-${Date.now()}.tmp`;
  try {
    const proc = Bun.spawn([cfg.adbPath, '-P', '5037', '-s', serial, 'pull', remotePath, dest], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    try { Bun.spawn(['cmd', '/c', `del "${dest}"`], { stdout: 'ignore', stderr: 'ignore' }); } catch { /* */ }
    if (code !== 0) {
      return { ok: false, err: stderr.trim().slice(0, 200) };
    }
    return { ok: true, err: '' };
  } catch (err) {
    return { ok: false, err: errMsg(err).slice(0, 200) };
  }
}

async function runMaestroNoop(cfg: SoakConfig, serial: string): Promise<{ ok: boolean; err: string }> {
  if (cfg.maestroPath === undefined) return { ok: false, err: 'maestro not configured' };
  // We can't run a real Maestro flow without a flow file. Approximation:
  // allocate + release a port via the API and verify the forward path,
  // which is the part of the Maestro lifecycle that breaks under contention.
  try {
    const alloc = await fetch(`${cfg.apiBase}/maestro/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serial, flowFile: 'soak.yaml' }),
    });
    if (!alloc.ok) {
      const t = await alloc.text();
      return { ok: false, err: `alloc ${alloc.status}: ${t.slice(0, 120)}` };
    }
    const body = (await alloc.json()) as { id: number };
    const rel = await fetch(`${cfg.apiBase}/maestro/run/${body.id}`, { method: 'DELETE' });
    if (!rel.ok) {
      return { ok: false, err: `release ${rel.status}` };
    }
    return { ok: true, err: '' };
  } catch (err) {
    return { ok: false, err: errMsg(err).slice(0, 200) };
  }
}

// ─── Health + memory sampling ────────────────────────────────────────

interface HealthSample {
  takenAt: number;
  uptime: number;
  deviceCount: number;
  memMb: number | null;
  openIncidents: number;
  totalIncidents: number;
  recoveredIncidents: number;
}

async function sampleHealth(cfg: SoakConfig, db: Database | undefined): Promise<HealthSample> {
  const takenAt = Date.now();
  let uptime = -1;
  let deviceCount = -1;
  try {
    const r = await fetch(`${cfg.apiBase}/health`);
    if (r.ok) {
      const j = (await r.json()) as { uptime: number; deviceCount: number };
      uptime = j.uptime;
      deviceCount = j.deviceCount;
    }
  } catch {
    /* leave -1 */
  }

  // Sample the daemon's memory specifically — NOT just the largest bun.
  // Pre-v1.0.1 this picked `Get-Process bun | Sort -Desc WorkingSet64 | First 1`,
  // which during a soak picked the harness (300+ MB) instead of the daemon.
  // Now: look up ADBPD service's actual PID via Win32_Service and sample that.
  // Fall back to the old behavior if the service can't be queried (e.g. when
  // running soak in dev shell against a non-service daemon).
  let memMb: number | null = null;
  try {
    const proc = Bun.spawn(
      [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Win32_Service.ProcessId is the NSSM supervisor; its only bun child
        // is the daemon. Walk the parent->child tree to find the daemon bun.
        "$svc = (Get-CimInstance Win32_Service -Filter \"Name='ADBPD'\").ProcessId; " +
          "if ($svc -and $svc -gt 0) { " +
          "  $child = (Get-CimInstance Win32_Process -Filter \"ParentProcessId=$svc AND Name='bun.exe'\" | Select-Object -First 1).ProcessId; " +
          "  if ($child) { (Get-Process -Id $child -ErrorAction SilentlyContinue).WorkingSet64 } " +
          "  else { (Get-Process -Id $svc -ErrorAction SilentlyContinue).WorkingSet64 } " +
          "} else { " +
          "  (Get-Process bun -ErrorAction SilentlyContinue | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 1).WorkingSet64 " +
          "}",
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const bytes = Number.parseInt(out, 10);
    if (!Number.isNaN(bytes)) memMb = Math.round(bytes / 1024 / 1024);
  } catch {
    /* */
  }

  let openIncidents = 0;
  let totalIncidents = 0;
  let recoveredIncidents = 0;
  if (db !== undefined) {
    try {
      const open = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL').get();
      const total = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM incidents').get();
      const recov = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM incidents WHERE auto_resolved = 1').get();
      openIncidents = open?.n ?? 0;
      totalIncidents = total?.n ?? 0;
      recoveredIncidents = recov?.n ?? 0;
    } catch {
      /* */
    }
  }

  return { takenAt, uptime, deviceCount, memMb, openIncidents, totalIncidents, recoveredIncidents };
}

// ─── Fault injection ─────────────────────────────────────────────────

interface FaultRecord {
  faultIdx: number;
  faultType: 'kill-qemu' | 'usb-check' | 'service-kill';
  injectedAt: number;
  recoveredAt: number | null;
  recoveryMs: number | null;
  withinSlo: boolean;
  detail: string;
}

async function injectKillQemu(cfg: SoakConfig): Promise<FaultRecord> {
  const start = Date.now();
  const rec: FaultRecord = {
    faultIdx: -1,
    faultType: 'kill-qemu',
    injectedAt: start,
    recoveredAt: null,
    recoveryMs: null,
    withinSlo: false,
    detail: '',
  };
  // 1. Look up qemu pid from /emulators.
  let vmPid: number | undefined;
  try {
    const r = await fetch(`${cfg.apiBase}/emulators`);
    const arr = (await r.json()) as Array<{ serial: string; vmPid: number | null }>;
    const match = arr.find((e) => e.serial === cfg.emulatorSerial);
    if (match?.vmPid !== null && match?.vmPid !== undefined) vmPid = match.vmPid;
  } catch (err) {
    rec.detail = `lookup failed: ${errMsg(err)}`;
    return rec;
  }
  if (vmPid === undefined) {
    rec.detail = `no vmPid for ${cfg.emulatorSerial}`;
    return rec;
  }

  // 2. Kill the qemu child directly (the launcher exits but VM stays — see
  //    P5-N1 in docs/03-build-history.md).
  console.log(`[fault] killing qemu pid=${vmPid} at ${new Date(start).toISOString()}`);
  try {
    const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', `Stop-Process -Id ${vmPid} -Force`], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await proc.exited;
  } catch (err) {
    rec.detail = `kill failed: ${errMsg(err)}`;
    return rec;
  }

  // 3. Poll for recovery: shell echo on the serial should succeed.
  const deadline = start + cfg.recoveryDeadlineMs * 4; // 2x SLO budget so we can log late recovery
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await runShell(cfg, cfg.emulatorSerial, 'echo recovered');
    if (r.ok) {
      rec.recoveredAt = Date.now();
      rec.recoveryMs = rec.recoveredAt - start;
      rec.withinSlo = rec.recoveryMs <= cfg.recoveryDeadlineMs;
      rec.detail = `recovered via shell at ${new Date(rec.recoveredAt).toISOString()}`;
      return rec;
    }
  }
  rec.detail = `no recovery within ${(deadline - start) / 1000}s`;
  return rec;
}

async function injectUsbCheck(cfg: SoakConfig): Promise<FaultRecord> {
  const start = Date.now();
  const rec: FaultRecord = {
    faultIdx: -1,
    faultType: 'usb-check',
    injectedAt: start,
    recoveredAt: null,
    recoveryMs: null,
    withinSlo: true,
    detail: '',
  };
  if (cfg.usbSerial === undefined) {
    rec.detail = 'no usb-serial configured; skipped';
    return rec;
  }
  try {
    const r = await fetch(`${cfg.apiBase}/devices/${cfg.usbSerial}`);
    if (r.ok) {
      const j = (await r.json()) as { state: string };
      rec.detail = `usb device state=${j.state}; manual unplug/replug NOT performed by harness — owner-side test`;
    } else {
      rec.detail = `usb device not in pool (${r.status})`;
    }
  } catch (err) {
    rec.detail = `lookup failed: ${errMsg(err)}`;
  }
  return rec;
}

async function injectServiceKill(cfg: SoakConfig): Promise<FaultRecord> {
  const start = Date.now();
  const rec: FaultRecord = {
    faultIdx: -1,
    faultType: 'service-kill',
    injectedAt: start,
    recoveredAt: null,
    recoveryMs: null,
    withinSlo: false,
    detail: '',
  };
  console.log(`[fault] sending host:kill at ${new Date(start).toISOString()}`);
  try {
    // host:kill via a raw socket to 5037 — clean cooperative shutdown,
    // NSSM should restart in ~5s + AppThrottle.
    const proc = Bun.spawn([cfg.adbPath, '-P', '5037', 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 5000,
    });
    await proc.exited;
  } catch (err) {
    rec.detail = `kill-server spawn: ${errMsg(err)}`;
    return rec;
  }

  // Wait for service to come back and AVD to attach (cold restart includes
  // emulator re-discovery — give it a longer budget than kill-qemu).
  const deadline = start + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const h = await fetch(`${cfg.apiBase}/health`);
      if (h.ok) {
        const j = (await h.json()) as { deviceCount: number };
        if (j.deviceCount >= 1) {
          const shell = await runShell(cfg, cfg.emulatorSerial, 'echo recovered');
          if (shell.ok) {
            rec.recoveredAt = Date.now();
            rec.recoveryMs = rec.recoveredAt - start;
            rec.withinSlo = rec.recoveryMs <= 90_000; // 90s budget for service-restart recovery
            rec.detail = `service back, shell ok at ${new Date(rec.recoveredAt).toISOString()}`;
            return rec;
          }
        }
      }
    } catch {
      /* keep polling */
    }
  }
  rec.detail = `no recovery within ${(deadline - start) / 1000}s`;
  return rec;
}

// ─── Main loop ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = parseArgs();
  const start = Date.now();
  const startIso = new Date(start).toISOString().replace(/[:.]/g, '-');
  await mkdir('M:/FutureApps/adb-proxy-daemon/logs', { recursive: true });
  const opLog = Bun.file(`M:/FutureApps/adb-proxy-daemon/logs/soak-${startIso}.csv`).writer();
  const memLog = Bun.file(`M:/FutureApps/adb-proxy-daemon/logs/soak-${startIso}-memory.csv`).writer();
  const summaryPath = `M:/FutureApps/adb-proxy-daemon/logs/soak-${startIso}-summary.md`;

  opLog.write('tick_at,op_type,serial,detail,latency_ms,result,error\n');
  memLog.write('taken_at,uptime_s,device_count,mem_mb,open_incidents,total_incidents,recovered_incidents\n');

  console.log(`[soak] mode=${cfg.mode} duration=${cfg.durationMs / 60_000}min faults=${cfg.faultMs.map((m) => m / 60_000).join(',')}min`);
  console.log(`[soak] logs: soak-${startIso}.csv + -memory.csv + -summary.md`);

  // Open DB read-only for incident reads.
  let db: Database | undefined;
  try {
    db = new Database('M:/FutureApps/adb-proxy-daemon/adbpd.sqlite', { readonly: true });
  } catch (err) {
    console.warn(`[soak] could not open adbpd.sqlite (incidents tracking disabled): ${errMsg(err)}`);
  }

  // Discover available serials once at start.
  let serials: string[] = [cfg.emulatorSerial];
  try {
    const r = await fetch(`${cfg.apiBase}/devices`);
    if (r.ok) {
      const arr = (await r.json()) as Array<{ serial: string; state: string }>;
      serials = arr.filter((d) => d.state === 'online').map((d) => d.serial);
    }
  } catch {
    /* fall back to single */
  }
  console.log(`[soak] targeting online devices: ${serials.join(', ')}`);

  const ops: OpRecord[] = [];
  const samples: HealthSample[] = [];
  const faults: FaultRecord[] = [];
  let nextFaultIdx = 0;
  let lastMemSample = start;

  const end = start + cfg.durationMs;
  let ticks = 0;
  while (Date.now() < end) {
    const tickStart = Date.now();
    ticks++;

    // Fault injection on schedule.
    while (nextFaultIdx < cfg.faultMs.length && Date.now() - start >= cfg.faultMs[nextFaultIdx]!) {
      const idx = nextFaultIdx++;
      const handler =
        idx === 0 ? injectKillQemu : idx === 1 ? injectUsbCheck : injectServiceKill;
      console.log(`[fault ${idx}] firing at +${(Date.now() - start) / 60_000}min`);
      const rec = await handler(cfg);
      rec.faultIdx = idx;
      faults.push(rec);
      console.log(`[fault ${idx}] ${rec.faultType}: ${rec.recoveryMs ?? 'timeout'}ms — ${rec.detail}`);
      // Re-discover serials after a fault — emulator-5554 may have re-attached.
      try {
        const r = await fetch(`${cfg.apiBase}/devices`);
        if (r.ok) {
          const arr = (await r.json()) as Array<{ serial: string; state: string }>;
          serials = arr.filter((d) => d.state === 'online').map((d) => d.serial);
          if (serials.length === 0) serials = [cfg.emulatorSerial];
        }
      } catch {
        /* */
      }
    }

    // Memory sampling.
    if (tickStart - lastMemSample >= cfg.memSampleMs) {
      lastMemSample = tickStart;
      const s = await sampleHealth(cfg, db);
      samples.push(s);
      memLog.write(
        `${new Date(s.takenAt).toISOString()},${s.uptime},${s.deviceCount},${s.memMb ?? ''},${s.openIncidents},${s.totalIncidents},${s.recoveredIncidents}\n`,
      );
      void memLog.flush();
    }

    // Workload.
    const pick = pickWorkload(cfg, serials);
    const opStart = Date.now();
    let result: { ok: boolean; err: string } = { ok: false, err: 'unhandled' };
    try {
      if (pick.opType === 'shell') result = await runShell(cfg, pick.serial, pick.detail);
      else if (pick.opType === 'pull') result = await runPull(cfg, pick.serial, pick.detail);
      else if (pick.opType === 'maestro') result = await runMaestroNoop(cfg, pick.serial);
    } catch (err) {
      result = { ok: false, err: errMsg(err) };
    }
    const rec: OpRecord = {
      tickAt: opStart,
      opType: pick.opType,
      serial: pick.serial,
      detail: pick.detail,
      latencyMs: Date.now() - opStart,
      result: result.ok ? 'pass' : 'fail',
      error: result.err,
    };
    ops.push(rec);
    opLog.write(
      `${new Date(rec.tickAt).toISOString()},${rec.opType},${rec.serial},"${escapeCsv(rec.detail)}",${rec.latencyMs},${rec.result},"${escapeCsv(rec.error)}"\n`,
    );
    if (ticks % 6 === 0) void opLog.flush();

    // Sleep until next tick.
    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, cfg.intervalMs - elapsed);
    if (wait > 0) await sleep(wait);
  }

  // Final sample.
  const final = await sampleHealth(cfg, db);
  samples.push(final);
  memLog.write(
    `${new Date(final.takenAt).toISOString()},${final.uptime},${final.deviceCount},${final.memMb ?? ''},${final.openIncidents},${final.totalIncidents},${final.recoveredIncidents}\n`,
  );
  void opLog.flush();
  void memLog.flush();
  opLog.end();
  memLog.end();

  // Summary.
  const totalOps = ops.length;
  const passed = ops.filter((o) => o.result === 'pass').length;
  const failed = ops.filter((o) => o.result === 'fail').length;
  const peakMem = samples.reduce((m, s) => Math.max(m, s.memMb ?? 0), 0);
  const finalIncidents = samples[samples.length - 1];
  const summary = [
    '# ADBPD Soak Summary',
    '',
    `**Mode:** ${cfg.mode}  `,
    `**Started:** ${new Date(start).toISOString()}  `,
    `**Ended:** ${new Date().toISOString()}  `,
    `**Duration:** ${((Date.now() - start) / 60_000).toFixed(1)} min  `,
    '',
    '## Workload',
    `- Total operations: ${totalOps}`,
    `- Passed: ${passed} (${((passed / totalOps) * 100).toFixed(1)}%)`,
    `- Failed: ${failed} (${((failed / totalOps) * 100).toFixed(1)}%)`,
    `- Operations per minute: ${(totalOps / (cfg.durationMs / 60_000)).toFixed(1)}`,
    '',
    '## Memory',
    `- Peak: ${peakMem} MB`,
    `- Samples: ${samples.length}`,
    `- Memory ceiling SLO (100 MB): ${peakMem <= 100 ? '✓ PASS' : `✗ FAIL (${peakMem} MB > 100)`}`,
    '',
    '## Incidents',
    `- Open at end: ${finalIncidents?.openIncidents ?? '?'}`,
    `- Total: ${finalIncidents?.totalIncidents ?? '?'}`,
    `- Auto-resolved: ${finalIncidents?.recoveredIncidents ?? '?'}`,
    `- Unrecovered-wedge SLO (0): ${(finalIncidents?.openIncidents ?? 0) === 0 ? '✓ PASS' : `✗ FAIL`}`,
    '',
    '## Fault injections',
    ...faults.map(
      (f) =>
        `- **#${f.faultIdx} ${f.faultType}** @ ${new Date(f.injectedAt).toISOString()} → ` +
        `${f.recoveryMs !== null ? `${f.recoveryMs}ms` : 'TIMEOUT'} ` +
        `(${f.withinSlo ? '✓ within SLO' : '✗ SLO miss'}) — ${f.detail}`,
    ),
    '',
    '## Failures (first 20)',
    ...ops.filter((o) => o.result === 'fail').slice(0, 20).map(
      (o) => `- ${new Date(o.tickAt).toISOString()} ${o.opType} ${o.serial}: ${o.error}`,
    ),
  ].join('\n');
  await Bun.write(summaryPath, summary);
  db?.close();

  console.log('');
  console.log(summary);
  console.log('');
  console.log(`[soak] summary written to ${summaryPath}`);
}

function escapeCsv(s: string): string {
  return s.replace(/"/g, '""').replace(/\r?\n/g, ' ');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

await main();
