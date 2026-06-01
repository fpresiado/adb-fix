# ADBPD — Architecture

## Layer map

| # | Component | Port / Interface | Responsibility |
|---|---|---|---|
| L1 | Smart Socket Proxy | TCP `127.0.0.1:5037` | ADB host wire protocol — what `adb`, Studio, Maestro talk to |
| L2 | Transport Pool | in-memory map | Source of truth for device state. One `DeviceTransport` per serial. |
| L3 | Maestro Port Manager | dynamic `7100–7200` | Per-session `adb forward tcp:N → tcp:7001` |
| L4 | Emulator Manager | Win32 process APIs | NUMA pin, lifecycle (start/stop AVD), VM child discovery |
| L5 | Telemetry Bridge | HTTP/HMAC (optional) | Push queued events to a remote endpoint |
| L6 | Control API | HTTP `:3002` + WS `:3003` | Sovereign management surface for ADBPD itself |

## Key files

```
src/
├── main.ts                       # entry — wires everything together
├── proxy/
│   ├── smart-socket.ts           # L1 — 5037 listener, transport bridging
│   ├── protocol.ts               # ADB host wire codec (encode/decode)
│   ├── router.ts                 # host:version / host:devices / host:transport:* etc.
│   └── version.ts
├── transport/
│   ├── base.ts                   # DeviceTransport interface
│   ├── pool.ts                   # L2 — TransportPool
│   ├── hybrid-backend.ts         # Shared HybridBackendTransport (per-device adb-server)
│   ├── emulator.ts               # EmulatorTransport (thin wrapper)
│   └── usb-bridge.ts             # UsbBridgeTransport (thin wrapper)
├── emulator/
│   ├── discover.ts               # Find running AVDs on console ports 5554..5680
│   ├── manager.ts                # L4 — EmulatorManager (startAvd, stopAvd, isVmAlive)
│   └── numa-pinner.ts            # FFI to kernel32 — topology + affinity + child discovery
├── usb/
│   └── enumerator.ts             # Transient enum-server → list USB devices → die
├── maestro/
│   ├── port-manager.ts           # L3 — allocate / release host ports
│   ├── process-wrapper.ts        # Programmatic Maestro launch
│   └── cli.ts                    # adbpd-maestro run --device <serial> <flow>
├── watchdog/
│   ├── monitor.ts                # 5s ping loop, incident tracking, wedge detection
│   └── recovery.ts               # [0, 5s, 15s, 30s] reconnect cascade
├── fm/
│   ├── client.ts                 # L5 — HMAC-signed HTTP client (disabled by default)
│   └── telemetry.ts              # Poll EventQueue, batch-push, mark synced
├── db/
│   ├── schema.ts                 # bun:sqlite migrations
│   └── events.ts                 # EventQueue + incidents tracking
├── api/
│   └── server.ts                 # L6 — Hono + Bun.serve WebSocket
└── utils/
    ├── logger.ts                 # pino structured JSON
    └── port-finder.ts            # Find free TCP port
```

## ADB host protocol — what we re-implement

Stock `adb` clients send length-prefixed ASCII commands. The first 4 bytes are the hex length of the command string; then the command body. The server replies with `OKAY` (4 bytes) followed by an optional length-prefixed payload, or `FAIL` with an error message. Most commands are one-shot — the server closes the connection after the reply. Exceptions: `host:track-devices` (long-lived stream) and `host:transport:<serial>` (upgrades the socket to a per-device transport that then carries `shell:`, `sync:`, `jdwp:`, etc.).

ADBPD's `proxy/protocol.ts` is a small codec for this. `proxy/router.ts` dispatches host commands; `proxy/smart-socket.ts` handles transport upgrades by opening a TCP connection to the matching per-device backend and bidirectionally piping bytes.

**One-shot vs streaming pitfall.** During P1 development, `adb -P 5037 devices` hung after printing the device list. Root cause: forgot to `socket.end()` after one-shot host commands. The ADB client uses EOF as the response delimiter. Fix: in `smart-socket.handleConnection`, after writing the reply, if `cmd.kind !== 'track-devices'` and no transport upgrade, call `socket.end()` immediately. (See [build history § P1-F1](03-build-history.md).)

**Double-OKAY on transport upgrade.** During P2, `adb -P 5037 -s emulator-5554 shell echo hello` printed nothing. Router replied OKAY for `host:transport:...`, then the backend's OKAY rode through the bridge — client saw two OKAYs, lost protocol sync. Fix: on a `transport`-kind reply, the router does NOT write its OKAY; the bridge replays the original `host:transport:<serial>` to the backend and the backend's OKAY flows through. (See [build history § P2-F3](03-build-history.md).)

## Why hybrid backend (deviation D4 from the original spec)

The original spec called for ADBPD to speak the ADB **daemon** protocol directly (the lower-level protocol between server and device), implementing AUTH handshake, packet codec, RSA credential store, and a Node-TCP ↔ WHATWG-stream adapter for `@yume-chan/adb`. Estimated ~500 lines of stream-plumbing for the first milestone.

Instead, each transport runs a **stock adb-server** as a child process bound with `--one-device <serial>` and a unique `ANDROID_ADB_SERVER_PORT`. ADBPD routes `host:transport:<serial>` to the matching backend's port via raw TCP. This is the same hybrid pattern the spec uses for USB; we apply it uniformly. Per-device isolation is preserved (no shared 5037 between backends), and we avoid the risky stream-plumbing for milestone 1.

The direct-daemon impl can be a future enhancement once the rest of the stack is stable.

## NUMA pinning — what it does

Multi-die AMD CPUs (Threadripper 2970WX, 3990X, etc.) have multiple NUMA nodes where each die has its own memory controller and L3. Threads on die 0 talking to memory mapped on die 2 pay a ~30ns cross-die hop. For VM workloads (Android emulators), that hop dominates the latency budget — keep the emulator's vCPU threads on one die and you can see 2–3× perf improvements.

`emulator/numa-pinner.ts` does this via Bun FFI to `kernel32.dll`:

1. `GetLogicalProcessorInformationEx(RelationNumaNode)` → list of nodes with their core masks
2. For each AVD launched: `OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_INFORMATION, FALSE, pid)` → handle
3. `SetProcessAffinityMask(handle, mask)` → pin
4. `GetProcessAffinityMask(handle)` → verify the pin took effect

**The qemu child pitfall (P5-N1).** Bun.spawn returns the pid of `emulator.exe`, which is a launcher. The actual VM runs as `qemu-system-x86_64-headless`, spawned by the launcher via Win32 `CreateProcess`. CreateProcess does NOT inherit processor affinity on Windows. So pinning the launcher (which exits seconds later) provides zero locality benefit.

Fix: after `Bun.spawn`, poll `Get-CimInstance Win32_Process -Filter "ParentProcessId=X"` until the qemu child appears (~1s), then `SetProcessAffinityMask` on the child's pid. The launcher pin stays as a cheap belt-and-suspenders.

Verified independently: `Get-Process qemu-system-x86_64-headless | Select ProcessorAffinity` reports `4095` (=0xfff, node 0). (See [build history § P5-N1](03-build-history.md).)

## Watchdog cascade

Every 5 seconds, the watchdog pings every transport via `shell:echo .` with a 3s timeout. State machine per device:

```
   ping ok           ping fail
       ↓                 ↓
  failures=0       failures += 1
       ↓                 ↓
  (incident closed   failures >= 3 ?
   on transition           ↓ yes
   from wedged)      open incident → onWedge callback
```

The `onWedge` handler in main.ts does a smart split based on whether the VM PID is alive:

```
onWedge(transport, incidentId):
    m = managed.get(transport.serial)

    # Fast-path: dead VM means transport reconnect is futile.
    if m and emulatorManager.isVmAlive(m.avdName) == false:
        stopAvd(m.avdName)         # may no-op if already dead
        startAvd(m)                # relaunches with same config
        recoverTransport(transport)
        return

    # Slow-path: transient backend hiccup — try reconnect cascade first.
    result = recoverTransport(transport, backoffs=[0s, 5s, 15s])
    if result.success: return
    if m: relaunchManagedAvd(transport, m, incidentId)
```

The fast-path matters because the original cascade (Session 4) burned 80s on transport reconnects against a dead VM before falling back to AVD relaunch — total recovery 118s. The fast-path cuts that to 21s detection-to-recovered, 32s kill-to-shell-working.

## Database schema (bun:sqlite)

Three primary tables, two for telemetry, one for Maestro state:

```sql
-- Maestro session port allocations. Partial unique index allows port reuse
-- after release. (P4 — see build history § P4-F1.)
CREATE TABLE maestro_ports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    serial       TEXT NOT NULL,
    host_port    INTEGER NOT NULL,
    device_port  INTEGER NOT NULL DEFAULT 7001,
    flow_file    TEXT,
    pid          INTEGER,
    allocated_at INTEGER NOT NULL,
    released_at  INTEGER
);
CREATE UNIQUE INDEX idx_maestro_ports_active_unique
    ON maestro_ports (host_port) WHERE released_at IS NULL;

-- Telemetry event queue. fm_synced=0 entries are pending; on bridge enable,
-- they replay in chronological order.
CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    serial     TEXT,
    payload    TEXT NOT NULL,  -- JSON
    fm_synced  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Wedge incidents tracked by the watchdog.
CREATE TABLE incidents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    serial        TEXT NOT NULL,
    incident_type TEXT NOT NULL,
    detail        TEXT,
    auto_resolved INTEGER NOT NULL DEFAULT 0,
    resolution    TEXT,
    duration_ms   INTEGER,
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER
);
```

## Control API — endpoint table

Hono on port 3002. zod validates every request body.

| Method | Endpoint | Response |
|---|---|---|
| GET | `/health` | `{ status, uptime, deviceCount, fmEnabled, version }` |
| GET | `/devices` | `DeviceInfo[]` |
| GET | `/devices/:serial` | `DeviceInfo` or 404 |
| POST | `/devices/:serial/reconnect` | `{ success: bool }` |
| GET | `/emulators` | `EmulatorInfo[]` (includes `vmPid`, `vmAffinityMask`) |
| POST | `/emulators` | `EmulatorInfo` — body: `{avdName, emulatorBinary?, consolePort, memoryMb?}` |
| DELETE | `/emulators/:serial` | `{ success }` |
| GET | `/maestro/ports` | `PortAllocation[]` |
| POST | `/maestro/run` | `PortAllocation` — body: `{serial, flowFile?}` |
| DELETE | `/maestro/run/:id` | `{ success }` |
| GET | `/forwards` | `Forward[]` aggregated from all transports |
| POST | `/forwards` | `Forward` — body: `{serial, local, remote}` |
| DELETE | `/forwards/:id` | `{ success }` — id is `<serial>::<local>` |
| GET | `/config` | `Config` |
| PUT | `/config` | `Config` — patch (e.g. `{fmEnabled: true}`) |
| POST | `/proxy/restart` | `{ success }` |

Bonus read-only:
- `GET /incidents?active=true` → list incidents
- `GET /events?limit=100&since=ID` → recent events
- `GET /numa` → topology

## WebSocket (port 3003)

Client subscribes:
```json
{ "subscribe": ["device.*", "emulator.*", "maestro.*"] }
```

Server pushes every queued event matching the subscription:
```json
{
  "event": "maestro.started",
  "serial": "emulator-5554",
  "data": { "allocationId": 1, "hostPort": 7100, "flowFile": "smoke.yaml" },
  "timestamp": "2026-05-31T09:30:04.768Z"
}
```

Subscription patterns use a simple glob (`*` matches any characters). The EventQueue's `onPush(listener)` hook fires the broadcast for every newly-inserted event.

## Telemetry bridge (FM, disabled by default)

Optional HMAC-signed HTTP push to a remote endpoint. Pattern:

```
bodyHash  = sha256(JSON.stringify(body) || "").hex   # lowercase
message   = `${installId}:${unixSeconds}:${bodyHash}`
signature = hmac_sha256(token, message).hex          # lowercase
```

Headers on every request:
```
X-Install-Id:    <installId>
X-App-Token:     <token>
X-FM-Timestamp:  <unix-seconds>
X-FM-Signature:  <lowercase hex>
Content-Type:    application/json
```

Ships with `fm.enabled: false`. While disabled, the telemetry loop is a no-op and events accumulate in SQLite (`fm_synced=0`). On flip-to-true (via `PUT /config`), the bridge polls the queue every 30s, batches up to 50 events, posts to `/api/hub/events`, marks synced rows. Failed pushes stop the batch but don't drop rows — they replay on the next tick.

## Port assignments

| Port | Purpose |
|---|---|
| 5037 | Smart Socket Proxy (ADB-compatible host) |
| 5039 | Transient USB enumeration adb-server |
| 5040+ | Per-device backend adb-servers |
| 3002 | Control API (HTTP) |
| 3003 | Control API (WebSocket) |
| 7100–7200 | Maestro port remapping range |
