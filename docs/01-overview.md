# ADBPD — Overview

**A sovereign replacement for the Google ADB host daemon (adb-server).**

Google's `adb` ships with a single host process that owns TCP `127.0.0.1:5037`. When multiple tools (Android Studio, Maestro, Gradle, CI agents) hit that one socket against multiple devices, contention produces wedges that look like UNAVAILABLE errors, frozen emulators, and devices stuck in `offline` state until you `adb kill-server` and restart everything.

ADBPD is a Bun + TypeScript daemon that takes ownership of port 5037 and proxies it to a **pool of per-device backends**, each running its own stock `adb-server` bound with `--one-device <serial>`. The clients (Studio, Maestro, gradle) see a normal ADB host on 5037; the daemon transparently routes per-serial traffic to the matching backend.

On top of that base, the daemon adds:

- **NUMA-aware emulator pinning.** On multi-die hosts (Threadripper, EPYC), AVDs are pinned to a single NUMA node so vCPU threads share L3 + memory controller. The pin targets the QEMU child process, not just the `emulator.exe` launcher (P5-N1 — see [build history](03-build-history.md)).
- **Watchdog + auto-recovery.** Every transport is pinged on a 5-second interval. Three consecutive failures opens an incident; a recovery cascade tries transport-level reconnect first, falls back to relaunching a managed AVD if the VM PID is dead.
- **Maestro port manager.** Allocates a unique host port per Maestro session and creates the `adb forward → tcp:7001` mapping, eliminating the UNAVAILABLE errors that two parallel Maestro runs produce against vanilla adb.
- **Hybrid USB transport.** A transient enumeration adb-server discovers USB devices at boot, then per-device backends start with `--one-device <serial>`. This works around the Windows USB ownership constraint where only one `adb-server` can claim a device at a time.
- **Control API.** HTTP on 3002 (16 endpoints), WebSocket on 3003 (real-time event stream). Lets you list devices, force reconnect, launch/stop AVDs, allocate Maestro ports, manage forwards, query incidents, and live-stream every device-state event.
- **Telemetry queue.** Every event lands in SQLite with `fm_synced=0`. Optional bridge to a remote telemetry endpoint (HMAC-signed); ships disabled by default.
- **Windows service.** Installs as an NSSM-supervised service that auto-starts before user login, so ADBPD owns 5037 before Android Studio can.

## What this fixes

- Two parallel Maestro runs on different devices → both finish, zero UNAVAILABLE
- Emulator crashes mid-test → ADBPD detects within 15s, relaunches the AVD with same config, recovers within 30s
- USB device gets unplugged and replugged → per-device backend reconnects without touching the proxy's 5037
- Android Studio + Gradle + CI scripts all running simultaneously → no wedges, no `kill-server` required
- Multi-emulator workloads on Threadripper-class hosts → each AVD pinned to its own die

## What this is *not*

- Not a replacement for `adb` the client. Use stock `adb -P 5037 <cmd>` — ADBPD speaks the host wire protocol.
- Not cross-platform yet. The NUMA pinner uses `kernel32.dll` FFI (Windows-only). Linux + macOS could be added but aren't built.
- Not a CI runner. It's the bedrock under your existing test runners.

## Status

Phases P1 through P8 are GREEN as of 2026-06-01 (see [build history](03-build-history.md) for milestones). P9 (4-hour soak + integration baseline) is the remaining work to tag v1.0.0.

## Stack

- **Runtime:** Bun 1.3+ (TypeScript strict mode, ESM only)
- **HTTP:** Hono
- **DB:** bun:sqlite (built-in)
- **FFI:** `bun:ffi` against Windows `kernel32.dll` for NUMA discovery + affinity pinning
- **Service supervisor:** NSSM 2.24
- **ADB tooling:** Android platform-tools 36.0.0 (`adb` 1.0.41), `emulator` from Android SDK
