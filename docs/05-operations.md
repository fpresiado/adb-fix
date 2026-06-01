# ADBPD — Operations

## Daily commands

```powershell
# Status
Get-Service ADBPD
Invoke-RestMethod http://127.0.0.1:3002/health
adb -P 5037 devices

# Stop / start (from elevated PowerShell)
C:\Tools\nssm\nssm.exe stop ADBPD
C:\Tools\nssm\nssm.exe start ADBPD
C:\Tools\nssm\nssm.exe restart ADBPD

# Read service env vars
C:\Tools\nssm\nssm.exe get ADBPD AppEnvironmentExtra

# Tail the logs
Get-Content M:\FutureApps\adb-proxy-daemon\logs\adbpd.stdout.log -Tail 30 -Wait
Get-Content M:\FutureApps\adb-proxy-daemon\logs\adbpd.stderr.log -Tail 30 -Wait
```

## Live API surface

```powershell
# What's connected
Invoke-RestMethod http://127.0.0.1:3002/devices

# What AVDs are managed
Invoke-RestMethod http://127.0.0.1:3002/emulators

# What incidents are open
Invoke-RestMethod 'http://127.0.0.1:3002/incidents?active=true'

# Recent events
Invoke-RestMethod 'http://127.0.0.1:3002/events?limit=20'

# Force-reconnect a device
Invoke-RestMethod -Method POST http://127.0.0.1:3002/devices/emulator-5554/reconnect

# Start an AVD via API (not just env-configured)
$body = @{ avdName='Pixel_9_Pro'; consolePort=5554 } | ConvertTo-Json
Invoke-RestMethod -Method POST http://127.0.0.1:3002/emulators -Body $body -ContentType 'application/json'

# Stop one
Invoke-RestMethod -Method DELETE http://127.0.0.1:3002/emulators/emulator-5554

# Toggle FM telemetry on/off
$body = @{ fmEnabled=$true } | ConvertTo-Json
Invoke-RestMethod -Method PUT http://127.0.0.1:3002/config -Body $body -ContentType 'application/json'
```

## WebSocket subscription (live events)

Any websocket client at `ws://127.0.0.1:3003`. Subscribe pattern:

```json
{ "subscribe": ["device.*", "emulator.*", "maestro.*", "health.*"] }
```

Server pushes `{event, serial, data, timestamp}` for every matching event. There's a Bun smoke script you can run to verify:

```powershell
cd M:\FutureApps\adb-proxy-daemon
bun run scripts/smoke-ws.ts
```

## Running tests

```powershell
cd M:\FutureApps\adb-proxy-daemon

# All
bun test

# Unit only (skips the integration test that needs port 5037)
bun test tests/unit/

# One file
bun test tests/unit/watchdog.test.ts
```

If `bun test` fails on the smart-socket integration test specifically, port 5037 is in use — either the service is running (expected — `nssm stop ADBPD` to free it) or a stock adb daemon is squatting (`adb kill-server`).

## If the service won't start

Symptoms: `Get-Service ADBPD` shows `Stopped` or stays in `StartPending` indefinitely.

1. **Look at the stderr log first:** `Get-Content logs\adbpd.stderr.log -Tail 50`. Crash stack traces land here.
2. **Look at the stdout log:** `Get-Content logs\adbpd.stdout.log -Tail 50`. Bun's pino output is here, including startup errors caught and logged.
3. **Common errors:**
   - `ENOENT: no such file or directory, uv_spawn 'C:\Android\platform-tools\adb.exe...'` — env var mangled. Use `scripts/set-service-env.ps1` (run elevated) to write the env block correctly. Bash CRLF escaping in elevated `Start-Process` calls can mangle the env block; the script avoids that.
   - `Cannot access 'watchdog' before initialization` — TDZ in old code. Update to commit `543b832` or later.
   - `port 5037 already bound` followed by silence — zombie kernel listener from a prior crash. Reboot is the cleanest reset.
   - `qemu VM child did not appear in time` — emulator binary couldn't launch the VM. Service is probably running as LocalSystem; switch to your user account via `nssm set ADBPD ObjectName .\<you> '<password>'`.

## If the service is running but devices don't show

1. `Invoke-RestMethod http://127.0.0.1:3002/health` — confirm the API is responding.
2. `Get-Process bun,emulator,qemu-system-x86_64-headless,adb -ErrorAction SilentlyContinue | Select Id,ProcessName,ProcessorAffinity` — check what's running.
3. If `adb -P 5037 devices` returns empty but `/devices` shows entries — there's a routing bug. Check `proxy/router.ts` and the recent commit list.
4. If `/emulators` shows `vmPid: null` for a managed AVD — the qemu-child discovery (PowerShell `Get-CimInstance`) failed or timed out. Logs should show `qemu VM child did not appear in time`. Possible causes:
   - Service running as LocalSystem (cannot query Win32_Process for `.\plusu`-owned children)
   - Emulator failed to spawn the child (AVD home not accessible)
   - PowerShell exec policy or `Win32_Process` permission issue

## If a device wedges and doesn't recover

1. Check `Invoke-RestMethod 'http://127.0.0.1:3002/incidents'` — is there an entry with `resolvedAt: null`?
2. If yes, that incident is open. Check the service log for the recovery cascade:
   ```
   tail -50 logs/adbpd.stdout.log | findstr "wedge recovery relaunch backend"
   ```
3. If the cascade ran but didn't succeed:
   - Was the AVD in the managed Map? Look for `managed-launch` or `managed-claim-via-discovery` event types in `/events`.
   - If not managed, the watchdog can only do transport-reconnect. Add the AVD to `ADBPD_MANAGED_AVDS` or POST to `/emulators` so it's tracked.
4. Manual recovery:
   ```powershell
   # Force-reconnect transport
   Invoke-RestMethod -Method POST http://127.0.0.1:3002/devices/emulator-5554/reconnect
   # If that fails, stop + restart the managed AVD
   Invoke-RestMethod -Method DELETE http://127.0.0.1:3002/emulators/emulator-5554
   $body = @{ avdName='Pixel_9_Pro'; consolePort=5554 } | ConvertTo-Json
   Invoke-RestMethod -Method POST http://127.0.0.1:3002/emulators -Body $body -ContentType 'application/json'
   ```

## SQLite queries you'll want

The database lives at the path in `$env:ADBPD_DB_PATH` (default `M:\FutureApps\adb-proxy-daemon\adbpd.sqlite`). Use any SQLite client; here's the bun:sqlite REPL:

```powershell
cd M:\FutureApps\adb-proxy-daemon
bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('adbpd.sqlite', { readonly: true });

// Recovery time distribution
console.log(db.query('SELECT incident_type, COUNT(*) AS n, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms FROM incidents WHERE resolved_at IS NOT NULL GROUP BY incident_type').all());

// Open incidents
console.log(db.query('SELECT id, serial, incident_type, created_at FROM incidents WHERE resolved_at IS NULL').all());

// Recent wedges per device
console.log(db.query(\"SELECT serial, COUNT(*) AS wedge_count FROM events WHERE event_type='device.wedged' GROUP BY serial\").all());

// Maestro port utilization
console.log(db.query('SELECT host_port, COUNT(*) AS uses FROM maestro_ports GROUP BY host_port ORDER BY uses DESC LIMIT 10').all());

// Pending FM events
console.log(db.query('SELECT COUNT(*) AS pending FROM events WHERE fm_synced = 0').get());
"
```

## NSSM service settings reference

Once installed, the service has these settings (view with `nssm get ADBPD <param>`):

| Param | Value | Purpose |
|---|---|---|
| `Application` | `C:\Users\<you>\.bun\bin\bun.exe` | The exe NSSM supervises |
| `AppParameters` | `run M:\FutureApps\adb-proxy-daemon\src\main.ts` | Args |
| `AppDirectory` | `M:\FutureApps\adb-proxy-daemon` | CWD |
| `ObjectName` | `.\<you>` (after the switch) | Service account |
| `Start` | `SERVICE_AUTO_START` | Boot-time start |
| `AppEnvironmentExtra` | `ADBPD_ADB_PATH=...; ADBPD_EMULATOR_BIN=...; ADBPD_DB_PATH=...; ADBPD_MANAGED_AVDS=...` | Per-instance env |
| `AppStdout` | `logs\adbpd.stdout.log` | Pino output |
| `AppStderr` | `logs\adbpd.stderr.log` | Crash output |
| `AppRotateFiles` | `1` | Rotate logs |
| `AppRotateBytes` | `10485760` | 10MB rotation threshold |
| `AppExit Default` | `Restart` | Auto-restart on non-zero exit |
| `AppRestartDelay` | `5000` | 5s pause before restart |
| `AppThrottle` | `10000` | Crash-loop guard (10s minimum process lifetime) |
| `AppStopMethodConsole` | `30000` | 30s SIGTERM grace |

To change one: `C:\Tools\nssm\nssm.exe set ADBPD <param> <value>` from elevated, then `nssm restart ADBPD`.

## Uninstalling

From elevated PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
```

This stops the service if running and removes it cleanly. The repo, the SQLite database, and the logs are left untouched.
