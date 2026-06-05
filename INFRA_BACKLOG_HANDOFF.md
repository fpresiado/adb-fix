# Infrastructure backlog — coder handoff (Bridge v0.2 + ADBPD v1.1/v1.2)

**Owner:** Francisco Ricardo Preciado Jr (Future @I LLC, "Isko")
**Date opened:** 2026-06-04
**Scope:** the next round of sovereign-infra work after Bridge v1.0.0 and ADBPD v1.0.1 shipped. Both products are live and stable; this is the polish-and-harden round.

If you are reading this as a **fresh coder with no prior context**, read every section before touching code. The "Resume-from-scratch" section at the end has the cold-start verification checklist.

---

## Resource budget

You have **5 Sonnet 4.6 agents + 1 Opus 4.6 agent**. Reserve Opus for the items marked OPUS below — they touch concurrency / signing / Rust / Windows handle semantics. Everything else is mechanical Sonnet work.

---

## Where things live

### Bridge (sovereign multi-agent broker — DONE, v1.0.0 shipped)

- **Code:** `Z:\FutureApps\universal_tools\tools\Bridge\` (own .git, no remote of its own)
- **Mirrored to:** `https://github.com/fpresiado/adb-fix` branch `bridge-source` (current HEAD `9015219`)
- **Handoff materials:** `https://github.com/fpresiado/adb-fix` branch `bridge` (`bridge/HANDOFF.md` + `bridge/BLUEPRINTS/`)
- **Ship tag:** `bridge-v1.0.0` on `fpresiado/adb-fix`
- **Known issues:** `Z:\FutureApps\universal_tools\tools\Bridge\KNOWN_ISSUES.md` — the v0.2 backlog (3 items, scoped below)
- **Service:** NSSM service named `Bridge`, Running, Automatic start. Listens on 127.0.0.1:4700 (WS) + 127.0.0.1:4701 (HTTP).
- **Health check:** `Invoke-RestMethod http://127.0.0.1:4701/health`
- **Isko token:** `Z:\FutureApps\universal_tools\tools\Bridge\data\isko.token` (Bearer for `/api/inject` and `/api/floor`)

### ADBPD (sovereign adb host daemon — DONE, v1.0.1 shipped)

- **Code:** `M:\FutureApps\adb-proxy-daemon\` (own .git)
- **Remote:** `https://github.com/fpresiado/adb-fix` branch `master` (public)
- **Ship tags:** `v1.0.0` (commit `8ba9c26`), `v1.0.1` (commit `924e87e`)
- **Backlog tracked in:** auto-memory `adbpd_v1_release` (project memory entry). 2 v1.x items + 3 newly-discovered protocol gaps, scoped below.
- **Service:** NSSM service named `ADBPD`, Running. Listens on 127.0.0.1:5037 (ADB wire) + 127.0.0.1:3002 (Control API HTTP).
- **Health check:** `Invoke-RestMethod http://127.0.0.1:3002/health`
- **Disaster recovery script:** `M:\FutureApps\adb-proxy-daemon\scripts\reset-adbpd.ps1` (elevated PS).

### Branches you'll work on

- Bridge v0.2 items → commit to local `Z:\...\Bridge\` git, then push to `adbpd-fix` remote `bridge-source` branch (remote name in that repo: `adbpd`, configured as `https://github.com/fpresiado/adb-fix.git`).
- ADBPD v1.1/v1.2 items → branch off `master` (remote name `public`, configured as `https://github.com/fpresiado/adb-fix.git`). Use feature branches like `v1.1/fast-path-verify` or `v1.2/rust-wrapper`.

---

## Bridge v0.2 — 3 items

Read `Z:\FutureApps\universal_tools\tools\Bridge\KNOWN_ISSUES.md` for the long-form. Summary + fix plan here.

### B1 — MCP `bridge_send` silently drops `type: "chat"` (OPUS)

**Severity:** Real bug. Blocks cross-Claude-Code chat via the natural tool. Workaround in use: agents send `type: "status"` instead.

**Root cause (verified on 2026-06-04 during live aegis_agent ↔ isko proof):**
1. `src/mcp/bridge-mcp.ts` builds a chat envelope, writes it to WS, and returns `{ id, ts }` to the tool caller **without** awaiting any broker acknowledgement. The id is MCP-generated, not broker-assigned.
2. `src/server/broker.ts:415-421` correctly enforces blueprint §3.3: "chat from non-holder → error frame, do not forward, do not persist." It sends a `chat_without_floor` error frame back over WS.
3. The MCP server doesn't listen for that error frame and never propagates it. The agent thinks success; the message is gone.

**Fix plan:**
- (a) In `src/mcp/bridge-mcp.ts`, when `bridge_send` is called with `type: "chat"`, **first** send a `floor_request` for the current agent id. Wait for either `floor_grant` (timeout 5s) or `floor_deny`. On grant, send the chat. On deny, return an error to the tool caller indicating the floor holder.
- (b) Independently, after sending ANY message, await a correlation frame from the broker (ack-style or error-style) for up to 2s. Use the broker-generated id from the response, not the MCP-generated id. If no response, return an error.
- (c) Add a test in `tests/mcp.test.ts`: spin up the broker, register two agents, have agent A hold the floor, have agent B call `bridge_send(type: "chat")` — must return an error result, NOT a fake success.
- (d) Update `src/server/broker.ts` if needed to send ack frames for non-chat success cases (currently it doesn't — see if it's already implicit or needs explicit work).

**Exit gate:** new MCP test passes; live re-run of the 2026-06-04 proof scenario shows aegis_agent's chat reply landing in SQLite (re-issue `bridge_send` from aegis_agent's MCP, then verify with `SELECT * FROM messages WHERE id = ?` against `Z:\...\Bridge\data\bridge.db`).

**Hard rules:**
- Do NOT relax the floor invariant. The floor exists per blueprint §3.3 and the soak / smoke tests rely on it. Acquire the floor; don't bypass it.
- Do NOT remove the workaround path: `type: "status"`, `type: "question"`, etc. must continue to bypass floor.
- Do NOT change the wire protocol or message envelope schema. v0.2 is a pure MCP-layer fix.

### B2 — `install-service.ps1` can't tighten ACL on `data/isko.token`

**Severity:** Security gap, not blocker. Single-user workstation today; would be a real issue on multi-user.

**Root cause:** install-service.ps1 calls `Get-Acl`/`Set-Acl` but `Microsoft.PowerShell.Security` module fails to autoload in some elevated PS hosts. Token file is created but inherits default dir ACLs.

**Fix plan:** replace the `Get-Acl`/`Set-Acl` block with `icacls` (Win32 binary, no module dependency):
```powershell
icacls $tokenPath /inheritance:r
icacls $tokenPath /grant:r "$env:USERNAME:(F)"
```
Same locked-down outcome, works in any PS host.

**Exit gate:** uninstall the existing service, re-run install-service.ps1, verify with `icacls Z:\...\Bridge\data\isko.token` that only the current user has access.

**Hard rules:**
- Do NOT delete the existing token during the test — the dashboard's stored token in sessionStorage matches it. If you must rotate, document the new-token-into-dashboard step.
- Do NOT run uninstall while Bridge is actively brokering — owner may have live Claude Code sessions connected. Coordinate via the dashboard inject before stopping.

### B3 — `/api/messages?limit=` capped at 1000

**Severity:** Minor. Affects soak harness validation only; real SQLite count is correct.

**Fix plan:**
- Raise the hard cap in `src/server/broker.ts` to 10000.
- Add `GET /api/messages/count?since=<ts>` returning `{ count: N }` — for cheap polling without large payloads.
- Update `scripts/soak.ts` to use the new count endpoint for its periodic validation.

**Exit gate:** soak harness reports actual count (not 1000 plateau). Add a quick test in `tests/broker.test.ts` for the new `/count` endpoint.

---

## ADBPD v1.1/v1.2 — 5 items

From auto-memory entry `adbpd-v1-release` plus 3 protocol gaps surfaced during the 2026-06-03 DT-3 testing.

### A1 — Fault #0 recovery fast-path verification (v1.1, OPUS)

**Context:** The v1.0.0 4h soak measured wedge recovery at 41.6s, over the 30s SLO. Owner-scoped fix: `main.ts`'s `onWedge` handler should check `EmulatorManager.isVmAlive(avdName)` FIRST. If the qemu child PID is confirmed dead (via FFI `GetExitCodeProcess`), skip the ping/reconnect cascade entirely and go straight to `stopAvd → startAvd → reconnect`.

**The memory says:** "main.ts already has a fast-path in `onWedge` that does exactly this — needs verification that it fires reliably and isn't being bypassed."

**Fix plan:**
1. Read `M:\FutureApps\adb-proxy-daemon\src\main.ts` `onWedge` handler. Confirm the fast-path block exists.
2. Read `EmulatorManager.isVmAlive` to verify it correctly uses `GetExitCodeProcess` FFI and not a softer heuristic.
3. Write a chaos test in `tests/chaos.test.ts` that:
   - Starts ADBPD against a mock emulator pool.
   - Kills the qemu child PID directly (simulating Fault #0).
   - Verifies that within 30 seconds, `EmulatorManager` re-launches the AVD and the new transport is online.
4. If fast-path doesn't fire as expected, find why (probably the ping cascade still runs first because order-of-checks is wrong).
5. Run a real 1-hour mini-soak with manual `taskkill /f /im qemu-system-x86_64-headless.exe` and measure recovery time. Target: < 30s p99.

**Exit gate:** chaos test passes; mini-soak shows < 30s recovery; finding written under `M:\FutureApps\adb-proxy-daemon\docs\03-build-history.md` as Session 9.

**Hard rules:**
- Do NOT run this while owner is actively using ADBPD-backed Maestro tests (AegisRx DT-3). Coordinate.
- Do NOT skip step 3 (real chaos test) — the v1.0 soak passed Fault #0 but at 41.6s; we need a faster repro before claiming v1.1.
- Do NOT relax the existing ping cascade for non-dead-VM wedges — it's the right answer for transient transport hiccups.

### A2 — Rust service wrapper replacing NSSM (v1.2, OPUS)

**Context:** The 5037 zombie pattern is an architectural NSSM gap. NSSM inherits handles into bun, and even with explicit attempts to disable inheritance (`AppNoConsole=1`, removing stdio redirects), the kernel handle leak persists. The fix is a small Rust binary that implements `SERVICE_WIN32_OWN_PROCESS` directly and spawns bun via `CreateProcess` with `bInheritHandles = FALSE`.

**Fix plan:**
1. New crate at `M:\FutureApps\adb-proxy-daemon\service-wrapper\` (Cargo workspace member if there's a workspace; otherwise standalone).
2. Use the `windows-service` and `winapi` crates (or `windows` crate from microsoft/windows-rs — owner prefers official).
3. Service entry implements:
   - `SERVICE_WIN32_OWN_PROCESS` registration.
   - `CreateProcessW` for bun with `bInheritHandles = FALSE`, stdout/stderr captured via pipes the wrapper owns.
   - SCM control handler for stop/restart/pause.
   - Restart-on-exit semantics matching NSSM's `AppExit Default Restart`.
4. New install script `scripts/install-service.rs-wrapper.ps1` that replaces the NSSM install:
   - Builds the Rust binary (or downloads from a release asset).
   - Registers via `sc.exe create` pointing at the wrapper binary.
   - Sets the same env vars NSSM sets today (BRIDGE_ISKO_TOKEN equivalent: any ADBPD secrets).
5. Keep `scripts/install-service.ps1` (NSSM) alive as a fallback until the wrapper has soaked. Provide a migration script `scripts/migrate-to-rust-wrapper.ps1`.
6. 4-hour soak with the new wrapper. Pass criterion: no 5037 zombie, no handle leaks per `handle.exe` snapshots.

**Exit gate:** Rust wrapper installed, ADBPD running under it for ≥ 4h with zero zombies. Document under `M:\FutureApps\adb-proxy-daemon\docs\03-build-history.md` Session 10.

**Hard rules:**
- Do NOT delete the NSSM install path until the Rust wrapper has 1 week of soak. Roll back is critical.
- Do NOT use any Rust crate with `< 1.0` version unless it's a Microsoft official (`windows`, `windows-sys`). Law 11 — stable only.
- Do NOT change the ADBPD source code as part of this. Wrapper is service-management only.
- Do NOT bundle a Rust toolchain installer — assume the dev has `rustup` already. Document this in the install script.

### A3, A4, A5 — Protocol gaps surfaced during DT-3 testing

These three commands are part of the standard adb client surface but ADBPD doesn't implement them. They surfaced during the 2026-06-03 Maestro work.

| Cmd | Use case | Wire format | File to touch |
|---|---|---|---|
| A3: `host:get-state` | `adb -s <serial> get-state` returns `device`/`offline`/`recovery` | OKAY + ASCII length + state word | `src/proxy/router.ts` |
| A4: `host:reconnect` | `adb -s <serial> reconnect` kicks the transport to renegotiate | OKAY + ASCII length + status | `src/proxy/router.ts` |
| A5: `host:reconnect-offline` | `adb reconnect offline` reconnects all `offline` devices | OKAY + ASCII length + summary | `src/proxy/router.ts` |

**Fix plan per gap:**
1. Add the command to the `HostCommand` union in `src/proxy/protocol.ts`.
2. Add a router case in `src/proxy/router.ts`.
3. For `get-state`: read the device state from the transport pool, return the wire-state word via the existing `wireState()` helper (online → device, etc.).
4. For `reconnect` / `reconnect-offline`: invoke the existing reconnect path that the wedge handler uses, return a status string (e.g. `"reconnecting <serial>"` or `"reconnected 2 offline devices"`).
5. Tests in `tests/router.test.ts` for each command (round-trip + error cases).

**Exit gate:** stock `adb -P 5037 -s emulator-5554 get-state` returns `device`. `adb reconnect offline` doesn't error.

**Hard rules:**
- Do NOT invent new wire states; use only `device`, `offline`, `unauthorized`, `recovery` per AOSP `system/core/adb/transport.cpp ConnectionStateName()` (already aliased in `wireState()`).
- Do NOT change `track-devices` or `host:devices` behavior — those are already correct per the wire-state fix at commit `9ba28fd`.

---

## Phase ordering (recommended)

Sonnet items can run in parallel. Opus items need care.

| Wave | Tasks | Agents | Notes |
|---|---|---|---|
| 1 | Bridge B2, B3 + ADBPD A3, A4, A5 | 5 Sonnet parallel | All mechanical fixes, independent files |
| 2 | Bridge B1 | 1 Opus | Touches MCP concurrency + protocol round-trip semantics |
| 3 | ADBPD A1 | 1 Opus | Read-and-verify mostly; chaos test is the real deliverable |
| 4 | ADBPD A2 | 1 Opus + 1 Sonnet support | The big one — Rust service wrapper. Do this last. |

Total: 6 Sonnet calls (5 parallel + 1 support) + 3 Opus calls.

---

## Pre-flight (do this BEFORE touching anything)

```powershell
# 1. Confirm both products are running and healthy
Get-Service Bridge, ADBPD | Format-Table
Invoke-RestMethod http://127.0.0.1:4701/health     # Bridge
Invoke-RestMethod http://127.0.0.1:3002/health     # ADBPD

# 2. Run the existing test suites — must be green before you start
cd Z:\FutureApps\universal_tools\tools\Bridge
bun test                                           # expect: 112 pass / 0 fail

cd M:\FutureApps\adb-proxy-daemon
bun test                                           # expect: 119 pass / 0 fail

# 3. Confirm working trees clean (no half-finished work)
cd Z:\FutureApps\universal_tools\tools\Bridge ; git status
cd M:\FutureApps\adb-proxy-daemon ; git status

# 4. Pull the latest from both remotes
cd Z:\FutureApps\universal_tools\tools\Bridge ; git pull adbpd main
cd M:\FutureApps\adb-proxy-daemon ; git pull public master
```

If ANY of those fail, stop and surface to owner. Do not start work on a broken base.

---

## Hard rules across all items

- **NEVER** break the existing ship gate. ADBPD v1.0.1 and Bridge v1.0.0 are in active use — owner runs AegisRx Maestro suites through both daily.
- **NEVER** restart either service while owner has live sessions. Coordinate via dashboard inject (Bridge) or surface to owner first (ADBPD).
- **NEVER** delete `data/isko.token` or any persistent state without an explicit backup → restore plan.
- **NEVER** publish changes to `master` / `bridge-source` without a soak window matching the scope: B2/B3/A3-5 = unit tests + smoke; B1 = unit tests + live MCP proof; A1 = chaos test + 1h soak; A2 = full 4h soak.
- **NEVER** mix Bridge and ADBPD changes in one commit — they're separate products with separate ship cycles.
- **NEVER** add cloud or external-network dependencies. Both products are sovereign by design.
- **NEVER** claim done without DONE PROOF (per AegisRx CLAUDE.md Completion Fraud Prevention — same standard applies here).
- **ALWAYS** rebase if the upstream branch advanced while you were working. Owner sometimes pushes from another session.

---

## Definition of done

For the round:
1. All 5 ADBPD protocol gaps closed (`host:get-state`, `host:reconnect`, `host:reconnect-offline`, fast-path verified, Rust wrapper soaked).
2. All 3 Bridge v0.2 items shipped.
3. Tags pushed: `bridge-v0.2.0` on `bridge-source`, `v1.1.0` and `v1.2.0` on `master`.
4. Build history files updated (`docs/03-build-history.md` for ADBPD, `Z:\...\Bridge\docs\` for Bridge).
5. Auto-memory updated: `adbpd_v1_release` reflects v1.2 shipped, `bridge_v1_checkpoint` reflects v0.2 closed.

---

## Resume-from-scratch (if a fresh Claude is taking this over)

If you have NO prior context, do this in order:

1. **Read this file front to back.** Don't skip sections.
2. **Read** `Z:\...\Bridge\BLUEPRINTS\Bridge_Blueprint_1_Server_Core.md` and `Bridge_Blueprint_2_Integration_Layer.md` — the Bridge contract.
3. **Read** `Z:\...\Bridge\KNOWN_ISSUES.md` — the v0.2 long-form.
4. **Read** `M:\FutureApps\adb-proxy-daemon\docs\01-overview.md` through `docs\05-operations.md` — the ADBPD docs.
5. **Read** owner's auto-memory:
   - `C:\Users\plusu\.claude\projects\P--futureapps-AegisRx\memory\bridge_v1_checkpoint.md`
   - `C:\Users\plusu\.claude\projects\P--futureapps-AegisRx\memory\adbpd_v1_release.md`
   - `C:\Users\plusu\.claude\projects\P--futureapps-AegisRx\memory\studio_5037_capture.md`
6. **Run the pre-flight checklist** above. Confirm both services are healthy and all tests are green.
7. **Now you can start.** Begin with Wave 1 mechanical fixes. Do NOT skip ahead to A2 (Rust wrapper) — it's last for a reason.

---

## Useful commands

```powershell
# Env for Maestro/adb work (needed if you touch ADBPD)
$env:ANDROID_HOME = 'C:\Android'
$env:PATH = 'C:\Android\platform-tools;Z:\FutureApps\universal_tools\tools\maestro\v2.4.0\maestro\bin;' + $env:PATH

# Bridge
cd Z:\FutureApps\universal_tools\tools\Bridge
bun test
bun run src/server/broker.ts                       # dev broker; don't run if NSSM service is alive
Invoke-RestMethod http://127.0.0.1:4701/health

# ADBPD
cd M:\FutureApps\adb-proxy-daemon
bun test
adb devices -l                                     # routed through ADBPD on 5037
Invoke-RestMethod http://127.0.0.1:3002/health

# Disaster recovery
powershell -ExecutionPolicy Bypass -File Z:\FutureApps\universal_tools\tools\Bridge\scripts\reset-bridge.ps1
powershell -ExecutionPolicy Bypass -File M:\FutureApps\adb-proxy-daemon\scripts\reset-adbpd.ps1
```

---

Ship clean. Owner is counting on this being rock-solid because every other project relies on both services being up.
