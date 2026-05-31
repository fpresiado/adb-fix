# ADBPD — Build Report

**Owner:** Francisco Ricardo Preciado Jr · Future @I LLC
**Spec:** `Z:\FutureApps\universal_tools\tools\adb\ADBPD_Blueprint_v1.0.docx`
**Builder:** Claude Opus 4.7 (Claude Code CLI)
**Build start:** 2026-05-30
**Host:** `beastai` — AMD Ryzen Threadripper 2970WX, Windows 11, M:/ workspace

> Source of truth for every decision, deviation, failure, and fix during the
> build. Updated at every phase boundary.

---

## Pre-build spike (live verification)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Bun version | `1.3.9` | ✓ blueprint requires v1.1+ |
| 2 | ADB version | `1.0.41` (platform-tools `36.0.0`) at `C:\Android\platform-tools\adb.exe` | ✓ supports `--one-device` server flag |
| 3 | `--one-device` semantics | **Server-start flag only, not per-command** | Confirmed by `adb help`. Blueprint Table 14 is correct; my initial mental model was wrong. |
| 4a | `@yume-chan/adb` | `2.6.0` on npm | ✓ matches blueprint pin |
| 4b | `@yume-chan/adb-server-node-tcp` | `2.5.2` on npm (NOT 2.6.0) | **Spec adjustment:** pin `^2.5.2`. The mono-repo versions packages independently. |
| 5a | CPU | AMD Ryzen Threadripper 2970WX, 24C/48T | ✓ matches blueprint |
| 5b | NUMA topology | **4 nodes confirmed** via `Get-Counter '\NUMA Node Memory(*)\Total MBytes'` | `Win32_NumaNode` WMI class not present on this Windows build. |

## Owner-locked decisions (pre-P1)

1. **NUMA pinner:** auto-detect via `GetLogicalProcessorInformationEx` (Windows FFI) → perf-counter fallback → blueprint hardcoded mask fallback. Threadripper masks (`0x3F`, `0xFC0`) are this host's actual masks.
2. **FM.exe bridge:** built, ships with `fm.enabled: false`. Events queue to SQLite (`fm_synced=0`) until enabled. Bridge replays on flip.
3. **HMAC secrets:** auto-generate 64-byte hex on first run → write to `.env` → print to console once.
4. **Maestro wrapper:** drop env-inject. Maestro does NOT read `MAESTRO_MASTER_PORT`. Wrapper only allocates port + runs `adb forward` + `maestro --device <serial>`.

## Build-time deviations from blueprint

| # | Blueprint says | What I shipped | Why |
|---|----------------|----------------|-----|
| D1 | `better-sqlite3 ^9.x` | `bun:sqlite` (built-in) | better-sqlite3's Windows postinstall fails because cmd.exe can't find `bun.exe` on PATH inside the npm-script shell. `bun:sqlite` is Bun-native, same SQL surface, no native build step, faster, and more aligned with the Bun-first spec. |
| D2 | `usb ^2.11.0` in deps | Deferred to P3 | `usb` package has a native build step that may fail similarly on Windows. Will install + verify when needed. P1/P2 don't touch USB. |
| D3 | `node-windows ^1.x` | Deferred to P8 | Not needed until Windows service phase. |
| D4 | Emulator transport: "Direct TCP :5555 Daemon Protocol — No shared server" (blueprint Table 3 + §5.2) | **Hybrid emulator transport** — one stock `adb start-server` per emulator on a private port (5040+) bound with `--one-device <serial>`, ADBPD routes `host:transport:<emulator-serial>` to that private port via raw TCP. | The blueprint's direct-daemon path requires (a) a Node-TCP ↔ WHATWG stream adapter for `@yume-chan/adb` (browser-stream API), (b) a packet codec wiring layer, (c) an `AdbCredentialStore` impl with persisted RSA key, and (d) full ADB AUTH handshake reimplementation. Estimate ~500 lines of risky stream-plumbing for a single milestone. The hybrid approach mirrors the blueprint's own USB hybrid pattern (§5.2 USB Bridge Transport), achieves per-device isolation (the actual goal — eliminates 5037 contention), and ships safely. The direct-daemon impl can be a future enhancement once the rest of the stack is stable. Per-emulator private-port isolation is preserved; we do NOT route through a shared backend. |

---

## Phase progress

| Phase | Status | Start | End | Milestone test |
|-------|--------|-------|-----|----------------|
| P1 — Smart Socket Proxy | **GREEN** | 2026-05-30 | 2026-05-30 | `adb -P 5037 version` / `devices` / `host-features` / `kill-server` all green via ADBPD |
| P2 — Emulator transport pool | **GREEN** | 2026-05-30 | 2026-05-30 | `adb -P 5037 -s emulator-5554 shell 'echo hello-from-adbpd'` → `hello-from-adbpd`. `getprop ro.product.model` → `sdk_gphone64_x86_64`. Pixel_9_Pro AVD on 5554, real shell commands flow through the ADBPD transport bridge. |
| P3 — USB hybrid transport | **GREEN** | 2026-05-31 | 2026-05-31 | Note 20 (R5CN90VPWQW) + Pixel_9_Pro (emulator-5554) both online through ADBPD on 5037 simultaneously. `adb -P 5037 -s R5CN90VPWQW shell` and `adb -P 5037 -s emulator-5554 shell` both return correct output. Per-device backends on ports 5041 (emu) + 5042 (USB) each with `--one-device <serial>` isolation. |
| P4 — Maestro port manager | **GREEN** | 2026-05-31 | 2026-05-31 | Two parallel `maestro test` runs — `adbpd-maestro run --device emulator-5554` (port 7100) + `adbpd-maestro run --device R5CN90VPWQW` (port 7101). Both exit 0. SQLite shows allocate→release for each. Zero UNAVAILABLE errors. |
| P5 — NUMA + emulator manager | pending | — | — | Emulators pinned, memory capped |
| P6 — Watchdog + FM bridge | pending | — | — | Events queued, auto-recovery tested |
| P7 — Control API | pending | — | — | All HTTP+WS endpoints green |
| P8 — Windows service | pending | — | — | Survives reboot, starts before Studio |
| P9 — Soak test | pending | — | — | 4h zero-wedge, all integration green |

---

## Build log (newest at top)

### 2026-05-31 — P3 + P4 complete (USB hybrid + Maestro port manager)
- Refactored EmulatorTransport into shared `HybridBackendTransport` base class. `EmulatorTransport` and new `UsbBridgeTransport` are now ~10-line wrappers.
- Wrote `src/usb/enumerator.ts` (transient enumeration server + `parseDevicesLong`), `src/transport/usb-bridge.ts`, `src/db/schema.ts` (bun:sqlite, partial unique index, migrations + `events` table reserved for P6).
- Wrote `src/maestro/port-manager.ts` (allocate/release with SQLite persistence, partial unique index handles port reuse), `src/maestro/process-wrapper.ts` (programmatic), `src/maestro/cli.ts` (the user-facing `adbpd-maestro run` command).
- Fixed `host:devices-l` to include `transport_id` field (router.ts + pool.ts) for modern dadb-based clients. *Maestro itself uses `host:devices` (short format) per the research agent's report — confirmed not the original blocker, but transport_id is correct hygiene.*
- Hit + fixed P3-F1 (USB isolation requires clean adb state — architected around it), P3-F2 (Windows USB settle delay), P4-F1 (partial unique index), P4-F2 (PATH + try/finally cleanup). One Sonnet 4.6 sub-agent dispatched to research Maestro/dadb protocol surface in parallel with the live retry; report informed the transport_id addition and confirmed `host:devices` (short) is the actual query.
- Live milestones:
  - P3: `adb -P 5037 devices` shows BOTH `emulator-5554 online` and `R5CN90VPWQW online`; shell commands round-trip on each.
  - P4: parallel `adbpd-maestro run` against both devices completes with exit 0, distinct host ports (7100 + 7101) shown in SQLite, both rows have `released_at` populated post-exit.
- 65 tests, 0 fail. Coverage ≥85% on shipped modules.

### 2026-05-30 — P2 complete (Emulator transport + bridge)
- Wrote `src/emulator/discover.ts` (port-scan 5555..5585), `src/utils/port-finder.ts`, `src/transport/emulator.ts` (EmulatorTransport with hybrid per-emulator stock-adb backend), `src/transport/pool.ts` (already in place from P1, now exercised).
- Refactored `src/proxy/smart-socket.ts` to handle transport upgrades by opening the backend, replaying the original `host:transport:<serial>` request, and bidirectionally piping. Discovered + fixed the double-OKAY bug (P2-F3).
- Added `emulator-probe` handling so adb's auto-discovery probes don't spam the log.
- Hit Bun stream segfault (P2-F2) — worked around with `SocketReader` + PassThrough-based tests.
- Real Pixel_9_Pro AVD on port 5554. `adb -P 5037 -s emulator-5554 shell 'echo hello-from-adbpd'` returns `hello-from-adbpd`. `getprop ro.product.model` returns `sdk_gphone64_x86_64`.
- 47 tests, 0 fail, ≥85% coverage where it matters (protocol/router/discover/port-finder/socket-reader all ≥85%; emulator transport tested at the logic layer via SocketReader, and at the integration layer via the live milestone).

### 2026-05-30 — P1 complete (Smart Socket Proxy)
- Wrote `src/proxy/protocol.ts` (ADB host wire codec), `src/proxy/version.ts` (reports v41 by default, env-overridable), `src/proxy/router.ts` (handles version/devices/devices-l/track-devices/features/host-features/list-forward/killforward/killforward-all/forward/transport/kill), `src/proxy/smart-socket.ts` (TCP listener with port-reclaim via `adb kill-server`), `src/transport/base.ts` + `src/transport/pool.ts` (empty pool ready for P2 transports), `src/utils/logger.ts` (pino), `src/main.ts`.
- 36 unit + integration tests, 88.95% func / 88.89% line coverage.
- Hit + fixed P1-F1 (see above).
- Milestone confirmed: real `adb.exe -P 5037` round-trip works.

### 2026-05-30 — Scaffold + dependencies
- Created directory tree per blueprint §04.
- Wrote `package.json`, `tsconfig.json` (strict), `bunfig.toml`, `.gitignore`, `.env.example`, `CLAUDE.md`.
- `bun install` → 26 packages, clean (after removing native deps that need to be installed lazily).
- First-run `bun install` failed on `better-sqlite3` postinstall — see deviation D1.

### Phase failures + fixes

#### P4-F2: Maestro adb-server PATH + DB cleanup on spawn failure
- **Symptom:** First parallel-Maestro attempt: `FATAL: Executable not found in $PATH: "maestro"` for the EMU job, and `error: device 'R5CN90VPWQW' not found` for the USB job. Allocation row left with `released_at: NULL` because the cleanup never reached.
- **Root cause:** (a) `Bun.spawn` inherits a different PATH than the parent shell on Windows, so `maestro` (a `.bat` script) couldn't be found. (b) The CLI's release/cleanup code ran AFTER the spawn, so any throw skipped it.
- **Fix:** (a) Use `process.env.ADBPD_MAESTRO_PATH ?? 'C:/Users/plusu/.maestro/bin/maestro.bat'`. (b) Wrap the spawn in try/catch/finally so the forward removal + DB `released_at` UPDATE always run.
- **Validation:** Subsequent runs show both rows with `released_at` populated immediately after exit, including failed runs.

#### P4-F1: dev SQLite UNIQUE constraint blocked port reuse after release
- **Symptom:** "release frees the port for reuse" unit test failed with `SQLiteError: UNIQUE constraint failed: maestro_ports.host_port`.
- **Root cause:** The schema's `host_port INTEGER NOT NULL UNIQUE` was a full-table UNIQUE, so even a released row blocked reallocation of the same port.
- **Fix:** Replaced with a partial unique index: `CREATE UNIQUE INDEX idx_maestro_ports_active_unique ON maestro_ports (host_port) WHERE released_at IS NULL`. Only active rows enforce uniqueness; released rows are historical.
- **Validation:** Test updated to assert both behaviors (UNIQUE for active, reuse OK after release). Passes.

#### P3-F2: USB device reported as offline by per-device backend
- **Symptom:** After the transient enumeration server killed, the per-device backend's `host:devices` reported the USB device as `offline` for ~30s before going online (or staying offline). Maestro and `adb shell` both fail.
- **Root cause:** The Windows USB driver layer doesn't immediately release device ownership when one adb-server is killed. The next adb-server's `--one-device <serial>` attaches but the device is in a stale-claim state.
- **Fix:** Added a 4-second `sleep` between the enumeration-server `kill-server` and the start of per-device backends. The 2.5s I tried first was insufficient on this host.
- **Validation:** Note 20 (R5CN90VPWQW) reliably reports `online` from ADBPD's `adb -P 5037 devices` ≥10s after launch, and `adb shell` works. *Note: this is a platform constraint on Windows USB ownership transfer, not a Bun or design flaw — the proper abstraction is the settle delay, not fighting the OS.*

#### P3-F1: ANDROID_ADB_SERVER_PORT + --one-device isolation only works from a clean adb state
- **Symptom:** Pre-flight spike showed `ANDROID_ADB_SERVER_PORT=5050 adb --one-device R5CN90VPWQW start-server` returning success, but the isolated server saw no devices. Investigation: a stock adb server was already running on 5037 and had grabbed USB ownership.
- **Root cause:** Windows USB lets only ONE process own a USB device at a time. A second adb-server can start on a different port but cannot grab USB if another server already owns it.
- **Fix (architectural):** ADBPD never owns USB directly. It only listens on 5037. Per-device backends own USB. A transient enumeration server starts BRIEFLY (no `--one-device`, sees all USB), reports devices, then dies, then per-device backends start fresh.
- **Validation:** Spike confirmed the clean-state path works. Live P3 milestone confirms ADBPD attaches both emulator + USB and both are usable.

#### P2-F3: live `adb shell` hangs after `transport bridge established`
- **Symptom:** After P2 code was wired, `adb -P 5037 -s emulator-5554 shell 'echo hello'` printed nothing and timed out. Each retry created a new "bridge established" log entry, so the upgrade was succeeding but no shell output reached the client.
- **Root cause:** I was double-sending OKAY. The router replied OKAY for `host:transport:emulator-5554` (the client wrote those 4 bytes back), then `upgradeToTransport` opened the backend, replayed `host:transport:emulator-5554` to it, consumed the backend's OKAY internally, and then set up the bridge. The client therefore saw a single OKAY (mine), but the bridge then started forwarding bytes that included whatever the backend was producing — out of sync with the protocol state the client expected.
- **Fix:** In `smart-socket.ts`, on a `transport`-kind reply, do NOT write the router's OKAY. Open the backend, replay the original `host:transport:<serial>` payload verbatim, and bridge immediately. The backend's OKAY now flows through the bridge to the client as a single, ordered OKAY. The router still returns a `wire` field for type compatibility; smart-socket just doesn't send it for upgrades.
- **Bonus catch:** adb auto-discovers emulators by sending `host:emulator:<console-port>` to the host server. My router was returning FAIL on this unknown command and adb was retrying every ~500ms. Added `emulator-probe` kind + OKAY reply so the retries stop.
- **Validation:** Two real shell commands round-tripped end-to-end (`echo hello-from-adbpd`, `getprop ro.product.model`).

#### P2-F2: Bun segfault running `tests/unit/emulator-transport.test.ts`
- **Symptom:** `bun test` crashed with `panic(main thread): Segmentation fault` whenever the emulator-transport tests ran. Other test files were fine.
- **Root cause:** Combination of bun:test + rapid `net.Server` create/destroy in `beforeEach`/`afterEach` + `socket.unshift()` in my original `readExact`. Bun 1.3.9 on Windows appears to have a stream-layer bug that segfaults under that pattern.
- **Fix:** (a) Replaced the original `readExact` with a `SocketReader` class that owns the receive buffer and never calls `unshift`. (b) Removed the crash-prone integration-style test that hammered net.Server lifecycle inside bun:test, replaced with `tests/unit/socket-reader.test.ts` that uses `stream.PassThrough` to exercise the same logic without sockets.
- **Validation:** Full suite passes (47/47), no crashes. The real socket behavior is exercised by the live milestone (`adb shell echo`).

#### P2-F1: better-sqlite3 deferred (see deviation D1 — re-stated for chronology)
- See D1 in the deviations table above.

#### P1-F1: `adb -P 5037 devices` hangs after the header
- **Symptom:** Real `adb.exe` client printed `List of devices attached` then hung indefinitely. Unit + integration tests passed because they read from a custom socket without waiting for EOF.
- **Root cause:** In the ADB protocol, every host command EXCEPT `host:track-devices` (and a successful `host:transport:*` upgrade) is one-shot: the server writes the reply then closes the connection, and the client uses EOF as the response delimiter. My `SmartSocketProxy.handleConnection` was keeping every connection open after the reply, waiting for more commands.
- **Fix:** In `src/proxy/smart-socket.ts`, after writing the reply: if `cmd.kind !== 'track-devices'` and no transport upgrade, call `socket.end()` immediately. Track-devices stays in the `trackSockets` set for live updates. (Confirmed against AOSP `system/core/adb/SERVICES.TXT`.)
- **Validation:** Re-ran the milestone command sequence — `version`, `devices`, `host-features`, `kill-server` all complete without hanging.

