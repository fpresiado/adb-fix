# Bridge — Operations

## Install (Windows)

```powershell
# 1. Clone + install deps (one-time)
cd Z:\FutureApps\universal_tools\tools
git clone <repo-url> Bridge
cd Bridge
bun install

# 2. Verify a clean dev run
bun run src/server/broker.ts
# Expect "Bridge ready" in stdout; Ctrl+C to stop.

# 3. Install as a Windows service (elevated PowerShell)
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 `
    -BunPath C:\Users\$env:USERNAME\.bun\bin\bun.exe

# 4. Verify
Get-Service Bridge
Invoke-RestMethod http://127.0.0.1:4701/health
```

The installer creates an NSSM service named `Bridge`, sets `Start = SERVICE_AUTO_START`, redirects stdout/stderr to `logs\broker-stdout.log` / `logs\broker-stderr.log`, sets `AppNoConsole 1` and `AppRotateBytes 52428800` (50 MB rotation), and starts the service.

## Install (Linux, future ATOM machine)

```bash
# 1. Clone + install
cd /opt
git clone <repo-url> bridge
cd bridge
bun install

# 2. Install systemd unit
sudo cp scripts/bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bridge

# 3. Verify
systemctl status bridge
curl http://127.0.0.1:4701/health
```

The systemd unit runs Bridge as a dedicated `bridge` user, with `ProtectSystem=strict`, `PrivateTmp=true`, and `RestartSec=5`. Logs go to `journalctl -u bridge`.

## Environment variables

The broker reads these from its environment (set in the NSSM `AppEnvironmentExtra` block or the systemd `Environment=` lines):

| Var | Default | Purpose |
|---|---|---|
| `BRIDGE_HOST` | `127.0.0.1` | Bind host. **Do not change to `0.0.0.0`** — loopback is the trust boundary. |
| `BRIDGE_WS_PORT` | `4700` | WebSocket port. |
| `BRIDGE_HTTP_PORT` | `4701` | HTTP (dashboard + hooks) port. |
| `BRIDGE_DB_PATH` | `./data/bridge.db` | SQLite WAL location. Use absolute paths under NSSM. |
| `BRIDGE_LOG_LEVEL` | `info` | pino level: `trace`/`debug`/`info`/`warn`/`error`. |
| `BRIDGE_ISKO_TOKEN` | (unset) | Reserved. Future per-dashboard token; v1.0 is loopback-trust only. |

Agent-side (set in the per-project shell that runs the MCP server or the TUI):

| Var | Default | Purpose |
|---|---|---|
| `BRIDGE_AGENT_ID` | (required) | Agent identity, e.g. `aegis_agent`. |
| `BRIDGE_URL` | `ws://127.0.0.1:4700` | Broker WebSocket URL. |
| `BRIDGE_PROJECT_DIR` | cwd | Project directory reported on register. |

## Daily commands

```powershell
# Service control (elevated)
Get-Service Bridge
C:\Tools\nssm\nssm.exe stop Bridge
C:\Tools\nssm\nssm.exe start Bridge
C:\Tools\nssm\nssm.exe restart Bridge

# Read service env block
C:\Tools\nssm\nssm.exe get Bridge AppEnvironmentExtra

# Health + roster
Invoke-RestMethod http://127.0.0.1:4701/health
Invoke-RestMethod http://127.0.0.1:4701/api/agents

# Live log tail
Get-Content Z:\FutureApps\universal_tools\tools\Bridge\logs\broker-stdout.log -Tail 30 -Wait
Get-Content Z:\FutureApps\universal_tools\tools\Bridge\logs\broker-stderr.log -Tail 30 -Wait

# Dashboard
Start-Process http://127.0.0.1:4701/dashboard
```

## Health check shape

`GET /health` returns:

```json
{
  "status": "ok",
  "uptime": 12345,
  "connectedAgents": 3,
  "version": "1.0.0"
}
```

`uptime` is seconds since broker boot. `connectedAgents` is the count of currently-online agents (the presence layer's truth, not the agent table's stored state). `version` reads from `package.json` at startup. Field order and names mirror ADBPD's `/health` so the same monitoring scripts work for both.

## Log locations

| File | Format | Source |
|---|---|---|
| `logs/broker-stdout.log` | Pino JSON, one line per event | All `info`/`warn`/`error` from broker production paths |
| `logs/broker-stderr.log` | Plain text | Uncaught exceptions, NSSM service messages |
| `logs/bridge.log` | Pino JSON (alias) | Configured fallback if NSSM redirection misbehaves |

The broker emits `pino` JSON with these standard fields: `level`, `time`, `pid`, `hostname`, `msg`, plus per-call context (`agentId`, `messageId`, `floorState`, etc.). Pretty-print for human reading:

```powershell
Get-Content logs\broker-stdout.log -Tail 30 | bun x pino-pretty
```

## Soak procedure (4h, mirrors ADBPD)

The owner's standard for declaring a release shippable: a 4-hour production soak with zero data loss and zero floor deadlocks. Mirrors ADBPD's `M:\FutureApps\adb-proxy-daemon\` v1.0 4h soak format.

### Setup

1. **Clean slate**: stop the service, archive `data/bridge.db` (`Copy-Item data\bridge.db data\bridge.db.pre-soak-<date>`), restart the service.
2. **Confirm `/health`**: `status=ok`, `connectedAgents=0`.
3. **Spin up three simulated agents** via `scripts/soak.ts`:
   ```powershell
   cd Z:\FutureApps\universal_tools\tools\Bridge
   bun run scripts/soak.ts --agents 3 --rate 1.0 --duration 4h
   ```
   `--rate 1.0` = one message per agent per second (3 msgs/s sustained, ~43,200 messages total).

### What `scripts/soak.ts` does

- Registers `soak_a`, `soak_b`, `soak_c`.
- Each agent runs a loop: send `status` every 5s, send `question` to a random peer every 30s, send `chat` (with floor request) every 60s, reply `answer` to any incoming question within 10s.
- Logs every send/receive to `logs/soak.log` with monotonic seq number.
- Every 5 minutes, dumps a checkpoint summary: messages sent, messages received, floor grants, floor denies, floor timeouts, current presence.

### Pass criteria

After 4h:

1. **Zero data loss.** For each agent, `messages_sent` from `logs/soak.log` equals `messages_received` minus that agent's own sends, summed across the other two peers.
2. **Zero floor deadlocks.** `floor_timeouts` should be near-zero (one or two from natural stalls is fine); no agent stuck waiting for floor at the end of the soak.
3. **Zero broker restarts.** `Get-Service Bridge` `StartTime` = the soak start time, not later.
4. **WAL size sane.** `data/bridge.db-wal` < 10 MB at end of soak (auto-checkpoint working).
5. **Memory steady.** Broker RSS at end of soak ≤ 1.5× RSS at start (taken from `Get-Process bun -ErrorAction SilentlyContinue | Where {$_.Path -like '*Bridge*'} | Select WS`).

Document the run in `docs/03-build-history.md` (to be added on first ship) with start time, end time, total messages, and any anomalies. ADBPD's v1.0 soak entry is the format reference.

### Failure → diagnose

A failed soak rolls back the version bump. Diagnose with:
- `logs/broker-stderr.log` for crashes
- `logs/soak.log` for the first cross-agent mismatch (the leading edge of any data loss)
- `Invoke-RestMethod 'http://127.0.0.1:4701/api/agents'` for presence sanity
- SQLite query for the message count: `SELECT COUNT(*) FROM messages`

## Running tests

```powershell
cd Z:\FutureApps\universal_tools\tools\Bridge

# All
bun test

# Unit only (no broker spin-up)
bun test tests/unit/

# One file
bun test tests/unit/floor.test.ts

# Integration (needs ports 4700 + 4701 free — stop the service first)
C:\Tools\nssm\nssm.exe stop Bridge
bun test tests/integration/
C:\Tools\nssm\nssm.exe start Bridge
```

If `bun test` fails specifically on an integration test, ports 4700/4701 are in use. Either the service is running (expected — stop it) or another local process is squatting.

## NSSM service settings reference

After `scripts/install-service.ps1`, the service has these settings (view with `nssm get Bridge <param>`):

| Param | Value | Purpose |
|---|---|---|
| `Application` | `C:\Users\<you>\.bun\bin\bun.exe` | The exe NSSM supervises |
| `AppParameters` | `run Z:\FutureApps\universal_tools\tools\Bridge\src\server\broker.ts` | Args |
| `AppDirectory` | `Z:\FutureApps\universal_tools\tools\Bridge` | CWD |
| `ObjectName` | `LocalSystem` (default) or `.\<you>` | Service account |
| `Start` | `SERVICE_AUTO_START` | Boot-time start |
| `AppEnvironmentExtra` | `BRIDGE_HOST=127.0.0.1; BRIDGE_WS_PORT=4700; BRIDGE_HTTP_PORT=4701; BRIDGE_DB_PATH=Z:\...\data\bridge.db` | Per-instance env |
| `AppNoConsole` | `1` | No console window |
| `AppStdout` | `logs\broker-stdout.log` | Pino output |
| `AppStderr` | `logs\broker-stderr.log` | Crash output |
| `AppRotateFiles` | `1` | Rotate logs |
| `AppRotateBytes` | `52428800` | 50 MB rotation threshold |
| `AppExit Default` | `Restart` | Auto-restart on non-zero exit |
| `AppRestartDelay` | `5000` | 5s pause before restart |
| `AppThrottle` | `10000` | Crash-loop guard (10s minimum process lifetime) |
| `AppStopMethodConsole` | `30000` | 30s SIGTERM grace for connected-client drain |

To change one: `C:\Tools\nssm\nssm.exe set Bridge <param> <value>` from elevated, then `nssm restart Bridge`.

## SQLite queries you'll want

The database lives at `$env:BRIDGE_DB_PATH` (default `Z:\FutureApps\universal_tools\tools\Bridge\data\bridge.db`). Use the `bun:sqlite` REPL:

```powershell
cd Z:\FutureApps\universal_tools\tools\Bridge
bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('data/bridge.db', { readonly: true });

// Message volume per agent
console.log(db.query('SELECT from_agent, COUNT(*) AS n FROM messages GROUP BY from_agent ORDER BY n DESC').all());

// Open questions (questions without an answer)
console.log(db.query(\"SELECT q.id, q.from_agent, q.to_agent, q.body FROM messages q WHERE q.type='question' AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.type='answer' AND a.reply_to=q.id) ORDER BY q.ts DESC LIMIT 20\").all());

// Floor-related status broadcasts (incidents)
console.log(db.query(\"SELECT ts, body FROM messages WHERE from_agent='broker' AND type='status' AND body LIKE '%floor%' ORDER BY ts DESC LIMIT 20\").all());

// Recent errors
console.log(db.query(\"SELECT ts, from_agent, body FROM messages WHERE type='error' ORDER BY ts DESC LIMIT 20\").all());

// Per-agent last seen
console.log(db.query('SELECT agent_id, state, last_seen FROM agents ORDER BY last_seen DESC').all());
"
```

## If the service won't start

Symptoms: `Get-Service Bridge` shows `Stopped` or stays in `StartPending` indefinitely.

1. **Stderr log first**: `Get-Content logs\broker-stderr.log -Tail 50`. Crash stack traces land here.
2. **Stdout log**: `Get-Content logs\broker-stdout.log -Tail 50`. Pino output with startup errors.
3. **Common errors**:
   - `EADDRINUSE 127.0.0.1:4700` — zombie listener; see `docs/04-disaster-recovery.md` §2 and use the in-session escape hatch.
   - `Cannot find module '...'` — `bun install` was not run, or `node_modules/` is on a path NSSM can't read (e.g. C: when the service runs as a non-admin user without C: drive access). Re-run `bun install` from the project directory.
   - `SQLITE_CANTOPEN` — `BRIDGE_DB_PATH` points at a directory the service account cannot write. Either fix the path or switch the service to run as your user via `nssm set Bridge ObjectName .\<you> '<password>'`.
   - `SQLITE_CORRUPT` — see `docs/04-disaster-recovery.md` §3.

## If the broker is up but messages are not flowing

1. `Invoke-RestMethod http://127.0.0.1:4701/health` — confirm `status=ok`, `connectedAgents > 0`.
2. `Invoke-RestMethod http://127.0.0.1:4701/api/agents` — confirm the expected agents are registered.
3. Open the dashboard and watch the global stream. If the dashboard is silent but `/api/agents` says agents are online, the WS subscription path is broken in the dashboard HTML — check the browser console for WS errors and confirm the dashboard is connecting to `ws://127.0.0.1:4700` (not 4701).
4. From an agent shell, run `scripts/smoke-send.ts` (if present) or:
   ```powershell
   $env:BRIDGE_AGENT_ID = "smoke_test"
   bun run src/mcp/bridge-mcp.ts
   # Send: { "jsonrpc": "2.0", "id": 1, "method": "tools/call",
   #         "params": { "name": "bridge_send",
   #                     "arguments": { "to": "all", "type": "status",
   #                                    "body": "smoke" } } }
   ```
   The smoke status should appear in the dashboard within a second.

## Uninstalling

From elevated PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
```

Stops the service if running and removes it cleanly. The repo, `data/bridge.db`, and `logs/` are left untouched. To wipe state too:
```powershell
Remove-Item Z:\FutureApps\universal_tools\tools\Bridge\data\bridge.db*
Remove-Item Z:\FutureApps\universal_tools\tools\Bridge\logs\*.log
```
