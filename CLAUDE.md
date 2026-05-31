# ADBPD — ADB Proxy Daemon
# Claude Code Agent Instructions
# Owner: Francisco Ricardo Preciado Jr | Entity: Future @I LLC

## Identity
You are building the Sovereign ADB Proxy Daemon for Future ATI LLC.
Stack: Bun + TypeScript (strict). No CommonJS. No `any`. No `console.log` (use the
pino logger via `utils/logger.ts`).

## Non-Negotiables
1. NEVER write to C: drive. All files go to `M:\FutureApps\adb-proxy-daemon\`.
2. NEVER use third-party cloud services. This is sovereign infrastructure.
3. NEVER bypass HMAC signing for FM.exe or Control API requests.
4. ALWAYS pin `@yume-chan/adb` to v2.6.0 — do not upgrade without instruction.
5. ALWAYS pin `@yume-chan/adb-server-node-tcp` to v2.5.2 (latest available).
6. ALWAYS set TypeScript `strict: true` — no implicit any, no non-null assertion abuse.

## Locked Decisions (from build-time spike, 2026-05-30)
- Host: AMD Ryzen Threadripper 2970WX, 4 NUMA dies confirmed via perf counters.
- ADB version on host: 1.0.41 (`C:\Android\platform-tools\adb.exe`).
- Bun version on host: 1.3.9.
- `--one-device` is a SERVER-START flag, not per-command. Hybrid USB starts one
  `adb start-server` per device with a distinct `ANDROID_ADB_SERVER_PORT`.
- Maestro does NOT read `MAESTRO_MASTER_PORT` env. The wrapper only allocates a
  host port, runs `adb forward`, and passes `--device <serial>`. No env-inject.
- NUMA pinner: 2-tier detection — Windows `GetLogicalProcessorInformationEx` via
  FFI → perf-counter fallback → hardcoded blueprint mask. Threadripper 2970WX
  masks (`0x3F`, `0xFC0`) are the last-resort default and match this host.
- FM.exe bridge: built, ships with `fm.enabled: false`. Events queue to SQLite
  (`fm_synced=0`) until enabled; bridge replays on flip.
- HMAC secrets: auto-generated on first run, written to `.env` (gitignored),
  printed to console ONCE.

## Build Order
Follow phases P1 → P9 in order. Do not skip ahead.
After each phase: run `bun test`, fix all failures before proceeding.

P1: Smart Socket Proxy (5037), protocol parser, version negotiation
P2: Emulator direct transport, connection pool, keepalive
P3: USB hybrid transport, per-device adb servers, USB watcher
P4: Maestro port manager, process wrapper, forward injection
P5: NUMA pinner, emulator lifecycle manager, resource limits
P6: Watchdog, auto-recovery, incident logging, FM.exe bridge
P7: Control API (HTTP + WS), SQLite persistence
P8: Windows service installer, startup/shutdown hardening
P9: Full integration + soak test, bug fixes

## File Locations
Source:  `src/`
Config:  `config/config.json` (never commit secrets — use env vars)
Data:    `data/adbpd.db`
Logs:    `logs/`
Scripts: `scripts/`

## FM.exe Integration
Base URL: `http://192.168.1.190:3001`
Auth: HMAC-SHA256, key from env `FM_HMAC_SECRET`
Pattern: see `src/fm/client.ts`. Failures are non-fatal — queue to DB and retry.

## Port Assignments
5037 → Smart Socket Proxy (ADB compatible)
3002 → Control API (HTTP)
3003 → Control API (WebSocket)
5038+ → Per-device USB adb servers (hybrid mode)
7100-7200 → Maestro port remapping range

## Error Handling
All async functions must have try/catch.
All errors must be logged via pino with full context.
All FM.exe push failures must be queued for retry — never drop events.

## Testing
Every new module needs a corresponding test in `tests/unit/` or `tests/integration/`.
Target: >90% coverage on `transport/`, `proxy/`, `maestro/` modules.
Run `bun test` before marking any phase complete.
