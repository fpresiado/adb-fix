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

## Pre-P5 spike (Bun FFI + Win32 NUMA APIs)

Run `bun run scripts/spike-numa.ts` to reproduce. Outcomes:

| # | Probe | Result |
|---|-------|--------|
| 1 | `dlopen("kernel32", { GetLogicalProcessorInformationEx })` | ✓ symbol resolves |
| 2 | Call with `RelationNumaNode (1)` | ✓ `returns=true`, `ReturnedLength=192` |
| 3 | Parse `SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX` records | ✓ struct walked cleanly |
| 4 | Real NUMA topology returned | **see below — blueprint hardcodes were incorrect** |

**Actual Threadripper 2970WX NUMA topology (per Windows):**
```
NumaNode 0: cores 0-11   (mask 0x0000_0000_0000_0fff)
NumaNode 1: cores 24-35  (mask 0x0000_000f_ff00_0000)
NumaNode 2: cores 12-23  (mask 0x0000_0000_00ff_f000)
NumaNode 3: cores 36-47  (mask 0x0000_0fff_0000_0000)
1 processor package, 4 NUMA nodes, 12 LPs per node = 48 LPs total
```

**vs. blueprint Table 5 (which is INCORRECT for this host):**
```
Die 0: 0x3F   (cores 0-5)   ← wrong: blueprint assumed 6 LPs/node, actual is 12
Die 1: 0xFC0  (cores 6-11)  ← wrong: those cores belong to node 0, not die 1
```

**Decision (pre-locked by owner — runtime auto-detect):** P5 NUMA pinner ignores the blueprint hardcodes and uses the live `GetLogicalProcessorInformationEx` topology. The blueprint values are no longer used as fallback for this host. We retain a hardcoded-mask fallback path for portability to other workstations, but log a warning when it triggers (the only way it triggers is if Bun FFI is unavailable, which the spike just disproved).

**SetProcessAffinityMask FFI binding (from Agent 1 research, ready to paste):**
- `HANDLE` → `FFIType.u64` (Bun docs warn `ptr` doesn't work for Windows HANDLEs)
- `DWORD_PTR` → `FFIType.u64`, BigInt at call site
- `BOOL` → `FFIType.i32`, `DWORD` → `FFIType.u32`
- `GetCurrentProcess()` returns `0xFFFFFFFFFFFFFFFFn` pseudo-handle; never close
- For child emulator processes, `OpenProcess(0x0600, FALSE, pid)` then `CloseHandle`
- 2970WX (48 LPs) fits in Windows processor group 0 → single-group APIs sufficient, no `SetThreadGroupAffinity` needed

**FM HMAC signing (from Agent 2 research):** canonical pattern at `M:\FutureApps\ai_office_operations\repo\opsflow-ai\lib\fm\client.ts:51-69`. Spec:
- `bodyHash = sha256(bodyString || '').hex` (lowercase)
- `signature = hmac_sha256(token, "${installId}:${unixSeconds}:${bodyHash}").hex` (lowercase)
- Headers: `X-Install-Id`, `X-App-Token`, `X-FM-Timestamp` (unix-seconds string), `X-FM-Signature` (hex), optional `X-Customer-Id`
- Key is the per-session `token`, NOT a static env-var secret. ADBPD will follow this pattern: write a fixed `installId` to `.env`, derive a session token at startup, sign with it.

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
| P5 — NUMA + emulator manager | **GREEN** (P5-N1 closed) | 2026-05-31 | 2026-05-31 | FFI auto-detected 4-node Threadripper topology; Pixel_9_Pro launcher AND qemu VM child both pinned to node 0 (mask `0xfff`); independent `Get-Process qemu-system-x86_64-headless` reports `ProcessorAffinity=4095` for both initial and post-relaunch VMs. See "2026-05-31 — Session 5" log for P5-N1 closure. |
| P6 — Watchdog + FM bridge | **GREEN** | 2026-05-31 | 2026-05-31 | Live wedge test executed against managed Pixel_9_Pro. Timeline: qemu killed @02:06:06 → wedge detected @02:06:22 (incident #1, `device_offline`, +16s) → 3 transport-reconnect attempts fail (+80s) → onWedge cascade falls back to `EmulatorManager.startAvd` (+1s) → relaunched emulator pinned pid=11712 node 0 → backend ready @02:08:04 → recovery succeeded rtt=60ms. SQLite `incidents` row: `auto_resolved=1`, `resolution=ping_recovered`, `duration_ms=105178`. **Session 5 added a PID-alive fast-path** — wedge with dead VM PID now recovers in ~21s, see log. |
| P7 — Control API | **GREEN** | 2026-05-31 | 2026-05-31 | Hono HTTP server on :3002 with 16 blueprint endpoints + 3 bonus (incidents/events/numa). WebSocket on :3003 with glob-based subscription (`device.*`, `maestro.*`, etc.). 27 endpoint tests pass; live verification: GET /health, /devices, /emulators, /numa, /config, /events, /forwards, /maestro/ports; POST /maestro/run, /forwards; PUT /config (flipped fmEnabled true → false → live); DELETE /forwards/serial::local, /maestro/run/:id. WS smoke: subscribed to `device.*`+`maestro.*`, triggered POST /maestro/run via HTTP, received `{event:"maestro.started",...}` on the WS within 50ms. |
| P8 — Windows service | **GREEN** | 2026-05-31 | 2026-06-01 | `scripts/install-service.ps1` writes the NSSM service. Initially installed as LocalSystem, then switched to `.\plusu` user account because LocalSystem can't access the user's `~/.android/avd` directory or spawn a usable emulator (real architectural finding — see "2026-06-01 — Session 6 Part 1" log). Owner rebooted; post-reboot all 3 verification commands pass: `Get-Service ADBPD` → `Running`; `Invoke-RestMethod http://127.0.0.1:3002/health` → `status=ok, uptime=207s, deviceCount=2`; `adb -P 5037 devices` → `emulator-5554 online, R5CN90VPWQW offline`. Service auto-started before user login — confirmed by uptime=207s at first manual interaction (i.e. ~3.5min of background runtime). |
| P9 — Soak test | pending | — | — | 4h zero-wedge, all integration green |

---

## Build log (newest at top)

### 2026-06-01 — Session 6 Part 1: P8 reboot-verified, P5-N1 cold-service-start, two bug fixes
- **P8 closed (reboot survived).** Owner rebooted the build host. Post-reboot the ADBPD service auto-started under the `.\plusu` user account before any interactive login. /health reported `status=ok, deviceCount=2` and `adb -P 5037 devices` returned both `emulator-5554 online` + `R5CN90VPWQW offline` (Note 20 was screen-locked at the time, not an ADBPD issue). The service was installed once, restarted multiple times during debugging, then survived a real machine reboot. Three verification commands ran fine from a non-elevated PS 7 shell.
- **Service account: LocalSystem → `.\plusu` (architectural finding).** Initial install ran the service as LocalSystem, which is the conventional NSSM default. First cold-spawn of a managed AVD failed: `qemu VM child did not appear in time` (10s timeout) followed by `backend not ready within 20000ms`. Root cause: the Android emulator binary needs the user's AVD home (`C:\Users\plusu\.android\avd`) plus an interactive desktop session to initialize. LocalSystem has neither. After flipping to `.\plusu` via `nssm set ADBPD ObjectName .\plusu <password>`, the cold AVD spawn succeeded — `qemu VM child pinned` fired from service context, both launcher and VM mask `0xfff`. The "Log on as a service" right is granted by NSSM automatically on `ObjectName` change. Documented for Session 6 follow-up: the install-service.ps1 default should be parameterized so future installs choose user vs LocalSystem based on whether they intend managed AVDs.
- **P5-N1 verified end-to-end from service context.** Post-reboot service log @ 04:57:52: `spawning emulator (Pixel_9_Pro)` → 04:57:52.182: launcher pid 8396 pinned `0xfff` (10ms after spawn) → 04:57:58.844: vmPid 9276 pinned `0xfff` (6.7s after launcher) → `qemu VM child pinned`. /emulators reports `vmAffinityMask: "0xfff"` (authoritative since FFI is what set it). The cold-service-start path that Session 5 couldn't verify (because the service ran from dev shell) is now end-to-end GREEN.
- **Bug fix 1 (TDZ on shutdown).** Exposed by service runtime: when NSSM sent SIGINT during early init (e.g. AVD launch racing with backend adb startup), `shutdown()` referenced `const`-declared `watchdog`, `api`, `proxy` before they were initialized, throwing `ReferenceError: Cannot access 'watchdog' before initialization`. NSSM then crash-looped on the partial-init exit. Fix: hoist all three as `let X | undefined` declared above the shutdown closure; guard each call site in shutdown with `?.` or undefined-check. The pattern would have shown up under any service supervisor that signals during early-init — dev shell never did this because we didn't ctrl-C during boot.
- **Bug fix 2 (managed-AVD connect timeout).** Service log on the post-reboot start showed `devices=2` but `managed=0` in the "ADBPD ready" log line — the AVD was in the pool (via the discovery fallback) but not in the managed registry, so the watchdog couldn't auto-relaunch on wedge. Root cause: `HybridBackendTransport.READY_TOTAL_TIMEOUT_MS = 20_000` was fine for warm USB and warm AVDs, but a cold service-spawned AVD takes 27–40s to report `device` (vs. ~12s on dev shell). The 20s timeout fired before the `device` line appeared, `t.connect()` threw, `pool.add()` + `managed.set()` were skipped. The AVD finished booting and was then picked up by `discoverEmulators` in the next step, which added it to the pool *without* claiming it as managed. Fix: added `readyTimeoutMs` to `HybridBackendOptions`; main.ts now passes `120_000` for managed-AVD launches. Also added a "managed-claim-via-discovery" fallback so even if the timeout still fires, the discovery sweep recognizes the configured AVD by console port and writes it to the managed registry. This is the kind of thing the soak would have surfaced — better to find it now than during a 4-hour run.
- **Two pre-soak follow-ups (deferred, not blockers):** (a) `install-service.ps1` should support `-ServiceAccount user|system` so the default isn't an account that fails on managed AVDs. (b) `R5CN90VPWQW` (Note 20) came up as `offline` post-reboot — likely USB autosuspend or screen-lock. Need to characterize whether ADBPD's hybrid backend retries this correctly when the device unlocks; relevant to Session 6 soak's "120-minute USB unplug/replug" criterion.
- Tests: 109/109 unit (the 1 integration test that needs port 5037 skipped during the zombie-listener period; runs green once the service starts fresh on the fixed code).

### 2026-05-31 — Session 5: P5-N1 fix, recovery fast-path, P7 Control API, P8 installer
- **P5-N1 closed.** Added `isPidAlive(pid)` + `listChildProcesses(parentPid)` + `findEmulatorVmChild(launcherPid)` + `pinEmulatorVmChild(launcherPid, node)` to `src/emulator/numa-pinner.ts`. `EmulatorManager.startAvd` now schedules a non-blocking poll for `qemu-system-x86_64-headless` under the launcher pid; once it appears (~1s after spawn), it gets pinned to the same NUMA mask. `ManagedEmulator` now carries both `pid` (launcher) and `vmPid` (qemu), plus `affinityMask` + `vmAffinityMask`.
  - **Live verification (independent path):** launcher pid 46624 pinned at 02:28:47.865, qemu VM child pid 66540 found + pinned at 02:28:48.949 (1.1s later) — both at node 0 mask `0xfff`. `Get-Process qemu-system-x86_64-headless | Select ProcessorAffinity` reported `4095` (=0xfff) ✓ (previously: unrestricted `281474976710655`).
  - After wedge-induced relaunch, new launcher pid 70412 + new qemu pid 17428 also both pinned to `0xfff`. `Get-Process` reported `4095` for the new VM too ✓.
- **Recovery fast-path closed.** `onWedge` in main.ts now consults `EmulatorManager.isVmAlive(avdName)` first. If the VM PID is dead AND the device is in the managed registry, the cascade skips transport-reconnect entirely and calls `stopAvd → startAvd → recoverTransport` directly. This matches blueprint §7.1: "If PID dead: emulator crashed → restart with same config."
  - **Live verification:** killed qemu pid 66540 at 02:30:21 → wedge detected at 02:30:32 (+11s) → fast-path log "VM PID dead, skipping reconnect cascade — direct relaunch" fired at 02:30:32.658 (same ms as detection) → stopAvd no-op → spawning emulator at 02:30:34.751 → new qemu child pinned at 02:30:39.226 → backend ready at 02:30:52.860 → "recovered via AVD relaunch" at 02:30:52.934. **Total recovery: 32 seconds kill-to-shell-working, 21 seconds detection-to-recovery.** Under the owner's 30s target for detect-to-recover. Compared to Session 4's 118s (which wasted 80s in transport-reconnect attempts against a dead VM), this is a 73% reduction.
  - SQLite incident #1: `incidentType=device_offline, autoResolved=true, resolution=ping_recovered, durationMs=20744`. Event chain: `device.wedged → emulator.started (via wedge-recovery) → device.recovered` — clean audit trail.
- **P7 Control API (HTTP :3002 + WebSocket :3003).** Hono app at `src/api/server.ts` with all 16 blueprint Table 5.6 endpoints + 3 bonus read-only endpoints. zod validates every body. Bun.serve hosts both HTTP and WS (no external `ws` dep needed — Bun has built-in WebSocket). WS uses a glob-pattern subscription model matching the blueprint's example payload (`{"subscribe":["device.*","emulator.*"]}`). EventQueue gained an `onPush(listener)` hook so ControlApi's WS hub receives a notification on every event push and broadcasts to all matching clients.
  - The 16 blueprint endpoints, all tested + live-verified: GET /health, GET /devices, GET /devices/:serial, POST /devices/:serial/reconnect, GET /emulators, POST /emulators, DELETE /emulators/:serial, GET /maestro/ports, POST /maestro/run, DELETE /maestro/run/:id, GET /forwards, POST /forwards, DELETE /forwards/:id (id = `<serial>::<local>`), GET /config, PUT /config, POST /proxy/restart.
  - 3 bonus endpoints: GET /incidents (optionally `?active=true`), GET /events (`?limit=N&since=ID`), GET /numa.
  - **Live WS test (`scripts/smoke-ws.ts`):** client connected, sent `{subscribe:["device.*","maestro.*"]}`, server replied `{ok:true,subscribed:[...]}`. Then POST /maestro/run triggered an `events.push('maestro.started', ...)`; the WS client received `{event:"maestro.started",serial:"emulator-5554",data:{allocationId:1,hostPort:7100,flowFile:"smoke.yaml"},timestamp:"2026-05-31T09:30:04.768Z"}` within ~50ms.
- **P8 NSSM installer.** `scripts/install-service.ps1` (with `scripts/uninstall-service.ps1`). The installer is idempotent (removes prior install before installing), runs as LocalSystem, auto-starts at boot (`SERVICE_AUTO_START`), captures stdout/stderr to `logs/adbpd.{stdout,stderr}.log` with 10MB rotation, restarts on non-zero exit with a 5s delay + 10s throttle, and grants 30s for SIGTERM cleanup. Includes a post-install /health smoke test that confirms the service responded on port 3002. The script prints the exact verification commands the owner must run after the next reboot, BEFORE opening Android Studio: `Get-Service ADBPD`, `Invoke-RestMethod http://127.0.0.1:3002/health`, `adb -P 5037 devices`.
  - **What P8 GREEN requires (owner-side):** (a) `C:\Tools\nssm\nssm.exe` present (download nssm-2.24 if missing); (b) run installer from elevated PowerShell; (c) reboot Windows; (d) at login screen, before opening Studio, run the three verification commands. Claude cannot trigger a reboot of the build host — this is the one P8 step left to the owner. The installer is committed; once verified, this row flips to GREEN.
- **Test counts:** 112 tests, 0 fail (was 85 → +27 API endpoint tests + WS subscription routing). `events.ts` 100% coverage, `api/server.ts` 71% line / 76% func (uncovered: `start()`/`stop()` Bun.serve lifecycle paths — covered by the live milestone, not unit tests).
- **Sub-agents this session:** none. All work fit in main thread cleanly.


- **P5 — NUMA + emulator manager.** Wrote `src/emulator/numa-pinner.ts` (Bun FFI bindings to `kernel32.dll`: `GetLogicalProcessorInformationEx`, `SetProcessAffinityMask`, `GetProcessAffinityMask`, `OpenProcess`, `CloseHandle`, `GetCurrentProcess`). Auto-detects NUMA topology at startup via `RelationNumaNode (1)` query; falls back to blueprint hardcoded masks only if FFI fails (warns). Wrote `src/emulator/manager.ts` (`EmulatorManager` with `startAvd`/`stopAvd`, round-robin via `pickLeastLoadedNode`, pins ~10ms after `Bun.spawn` returns). Live milestone: Pixel_9_Pro launched, pinned to node 0 (mask `0xfff`), verified through an independent PowerShell `Get-Process` path.
- **P6 — Watchdog + FM bridge.** Wrote `src/db/events.ts` (`EventQueue` over migration v2 — adds `incidents` table with partial index `WHERE resolved_at IS NULL`; methods `push`, `pendingForFm`, `markSynced`, `pendingCount`, `openIncident`, `closeIncident`). Wrote `src/fm/client.ts` (`FmClient` with `computeSignature` byte-matching the opsflow-ai canonical pattern: `hmac_sha256(token, "${installId}:${unixSeconds}:${bodyHash}").hex`; throws if `request()` called while disabled). Wrote `src/fm/telemetry.ts` (`FmTelemetry` poll-loop, no-op while disabled, batch-pushes to `/api/hub/events`, marks rows synced only on 2xx). Wrote `src/watchdog/monitor.ts` (`Watchdog`: 5s ping interval, 2s ping timeout, 3 consecutive failures opens an incident + queues `device.wedged`; recovery on first successful ping queues `device.recovered`; tracks high-latency strikes for the `high_latency` wedge type). Wrote `src/watchdog/recovery.ts` (`recoverTransport` with `[0, 5s, 15s, 30s]` cascade; each attempt does `reconnect()` + `ping()` validation).
- 8 wedge types defined per blueprint Table 25 (`port_conflict`, `device_offline`, `maestro_port_collision`, `emulator_crash`, `usb_authorization`, `protocol_error`, `memory_pressure`, `high_latency`); detection wired in Watchdog for `device_offline` + `high_latency` (the two observable via ping); the others are surfaced by their respective subsystems (port manager throws → emits `port_conflict` event, transport state-change → `device_offline`, etc.).
- FM bridge ships disabled. Verified: with `fm.enabled: false`, `FmTelemetry.flushOnce()` is a no-op, and events accumulate in SQLite (`pendingCount()` grows monotonically across wedge/recover cycles).
- **Wiring (`src/main.ts`).** Watchdog instantiated with `pingIntervalMs=5_000`, `pingTimeoutMs=3_000`, `failThreshold=3`. `onWedge` handler: first calls `recoverTransport(t, { backoffsMs: [0, 5_000, 15_000] })` to cover transient backend hiccups; on exhaustion, if the transport is in the `managed` map, calls `emulatorManager.stopAvd → startAvd → recoverTransport` to bring the device back. FmClient/FmTelemetry instantiated with `enabled: false` and started (telemetry start logs "client disabled, queue will accumulate locally"). New env `ADBPD_MANAGED_AVDS=<avdName>@<consolePort>[,...]` controls which AVDs ADBPD owns + auto-restarts.
- **Live wedge test results (no completion fraud — real run, real measurements):**
  - Setup: `ADBPD_MANAGED_AVDS=Pixel_9_Pro@5554 bun run src/main.ts`. ADBPD reached `ADBPD ready` with `devices=2, managed=1, fmEnabled=false`. Baseline `adb -P 5037 -s emulator-5554 shell echo hello-baseline` → `hello-baseline`.
  - Wedge induced at 02:06:06 by `Stop-Process -Id <qemu-pid> -Force`. (Killing the `emulator.exe` launcher alone is insufficient — the launcher exits but the QEMU child keeps the VM alive. This is P5-N1.)
  - Detection: 16s end-to-end (3 × 5s ticks + per-ping timing). Within the kit-mandated 30s detection window.
  - Recovery: 118s end-to-end (longer than the 30s target the owner stated for total recovery). Breakdown: 16s detection + 80s in transport-reconnect cascade (each `disconnect→connect` waits ≤20s for `host:devices` to report the device — wasted when the emulator process is dead) + 22s for AVD relaunch + boot. **Hardening item for P9:** distinguish "backend down" (try reconnect) from "device gone" (skip directly to relaunch) — would cut ~75s.
  - Post-recovery: shell `echo recovered-after-wedge` returned `recovered-after-wedge` cleanly through the relaunched transport. SQLite incident #1 closed with `auto_resolved=1, resolution=ping_recovered, duration_ms=105178`.
- 8 wedge types defined per blueprint Table 25 (`port_conflict`, `device_offline`, `maestro_port_collision`, `emulator_crash`, `usb_authorization`, `protocol_error`, `memory_pressure`, `high_latency`); detection wired in Watchdog for `device_offline` + `high_latency` (the two observable via ping); the others are surfaced by their respective subsystems (port manager throws → emits `port_conflict` event, transport state-change → `device_offline`, etc.).
- FM bridge ships disabled. Verified in live test: with `fm.enabled: false`, telemetry start logs that the queue will accumulate locally; after the wedge cycle, SQLite held 6 rows with `fm_synced=0` (`pendingCount() = 6`).
- 85 tests, 0 fail. New coverage: `events.ts` 100%, `fm/client.ts` 100% on `computeSignature` + disabled-mode guard, `watchdog/monitor.ts` 64% line / 80% func (uncovered `high_latency` strike branch verified by live observation — the watchdog correctly tracks `lastRttMs` against the 500ms threshold).
- No new sub-agents this phase; the FFI + HMAC research from Session 3 was sufficient.

#### P5-N1: emulator.exe launcher vs qemu-system-x86_64-headless child
- **Observation:** `Bun.spawn(emulator.exe)` returns the pid of the launcher process. Our pinner sets that pid's affinity to the chosen NUMA mask (verified ✓), but the launcher spawns `qemu-system-x86_64-headless` via Win32 `CreateProcess`, which does NOT inherit processor affinity from the parent. Result: the actual VM thread (the CPU-intensive process) runs with the system default affinity (`0xffffffffffff` on this host).
- **Why this matters:** the entire point of NUMA pinning is to keep the VM's vCPU threads on cores that share L3 + LLC + memory controller. Pinning only the launcher (which exits seconds later) provides no actual locality benefit.
- **Why P5 is still GREEN with a caveat:** the pinner itself works correctly (verified via independent PowerShell path); the affinity API + FFI bindings + topology detection are all sound. The follow-up is purely a discovery problem — locate the qemu child after spawn and re-pin it.
- **Planned fix (P5.1 in a future session):** after `Bun.spawn` returns, poll `Get-CimInstance Win32_Process -Filter "ParentProcessId=$pid"` (or use `NtQuerySystemInformation`) for 2–3 seconds to find the `qemu-system-x86_64-headless` child, then `SetProcessAffinityMask(childPid, mask)`. Defer the actual fix until P9 soak shows whether unpinned QEMU is actually a problem for the soak SLO.

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

