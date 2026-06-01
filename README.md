# adb-fix

**Sovereign replacement for Google's ADB host daemon.**

Google's `adb-server` owns `127.0.0.1:5037` as a single shared process. When Android Studio, Maestro, Gradle, and a CI runner all hit that port against multiple devices, contention produces wedges — UNAVAILABLE errors, frozen emulators, USB devices stuck in `offline`. The traditional fix is `adb kill-server` and restart everything.

`adb-fix` is a Bun + TypeScript daemon that owns 5037 first and proxies it to a **pool of isolated per-device backends** — one stock `adb-server` per serial, each bound with `--one-device <serial>` on its own private port. From the outside it looks like a normal ADB host; on the inside, contention is gone.

Built for Windows + NUMA-aware multi-emulator workloads. Verified on a Threadripper 2970WX hosting Pixel_9_Pro + a USB Note 20.

## Headline features

- **Smart Socket Proxy** on 5037 with the full ADB host wire protocol (`host:version`, `host:devices`, `host:transport:*`, `host:track-devices`, `host:forward`, etc.)
- **Per-device backend isolation** via stock adb-server with `--one-device <serial>` — no shared 5037 between transports
- **NUMA-aware emulator pinning** via Bun FFI to `kernel32.dll`. Both the `emulator.exe` launcher AND the actual `qemu-system-x86_64-headless` VM child get pinned (Win32 `CreateProcess` doesn't inherit affinity — see P5-N1 finding)
- **Watchdog + auto-recovery** with PID-alive fast-path. Dead-VM wedges recover in ~21s (detection) / ~32s (kill→shell-working). The slow-path reconnect cascade only fires for transient backend hiccups.
- **Maestro port allocator** — unique host port per session in 7100–7200, dynamic `adb forward → tcp:7001`. Two parallel Maestro runs, zero UNAVAILABLE.
- **Hybrid USB transport** that survives the Windows USB-ownership constraint via transient enumeration → per-device backends with `--one-device <serial>`
- **Control API** — Hono on `:3002` (16 endpoints, zod-validated) + WebSocket on `:3003` (glob-pattern subscriptions, real-time event stream)
- **Telemetry queue** in SQLite with HMAC-signed bridge for remote shipping (off by default)
- **Windows service installer** (NSSM) that auto-starts before user login

## Quick start

Prerequisites:
- Windows 10/11
- Bun 1.3+ (`irm bun.sh/install.ps1 | iex`)
- Android platform-tools (`adb` 1.0.41+) at `C:\Android\platform-tools\adb.exe`
- Android SDK emulator + at least one AVD if you want managed AVDs
- NSSM 2.24 at `C:\Tools\nssm\nssm.exe` (only needed for service install)

```powershell
git clone https://github.com/<your-user>/adb-fix.git
cd adb-fix
bun install
bun test

# Dev shell run:
$env:ADBPD_MANAGED_AVDS = "Pixel_9_Pro@5554"   # optional
bun run src/main.ts

# In another shell:
adb -P 5037 devices
Invoke-RestMethod http://127.0.0.1:3002/health
```

For service install + reboot-survival verification, see [`docs/05-operations.md`](docs/05-operations.md).

## Docs

- [`docs/01-overview.md`](docs/01-overview.md) — what it is and why
- [`docs/02-architecture.md`](docs/02-architecture.md) — layer map, protocol, schema, endpoints
- [`docs/03-build-history.md`](docs/03-build-history.md) — phase-by-phase log: every decision, every deviation, every bug, every fix
- [`docs/04-disaster-recovery.md`](docs/04-disaster-recovery.md) — rebuild-from-scratch checklist + a prompt to resume work with a fresh AI assistant
- [`docs/05-operations.md`](docs/05-operations.md) — install, debug, common queries, NSSM reference

## Status

Phases P1–P8 are GREEN. P9 (4-hour soak + integration baseline) pending. See [`docs/03-build-history.md`](docs/03-build-history.md) for the live status table.

## License

MIT — see [LICENSE](LICENSE).

## Author

Built by [Francisco Ricardo Preciado Jr](https://github.com/fpresiado) with [Claude Code](https://claude.com/claude-code). Background and motivation: I run multi-emulator Android workloads on a Threadripper for [AegisRx](https://github.com/fpresiado/AegisRx) and other apps, and the constant `adb kill-server` dance was unsustainable. This is the daemon I wish had existed.
