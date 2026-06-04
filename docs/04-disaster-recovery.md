# Disaster Recovery — How to Rebuild from Scratch

This doc exists so the owner can hand a fresh Claude (or any engineer) the full picture and resume Bridge on a new machine, or recover the running broker after a failure. Read it top-to-bottom before touching anything.

## The 30-second summary

Bridge is a Bun + TypeScript multi-agent chat broker. It owns `127.0.0.1:4700` (WebSocket) and `127.0.0.1:4701` (HTTP). Agents connect via a per-project MCP stdio server (`bridge-mcp.ts`) and PowerShell hooks; the owner (Isko) supervises from a browser dashboard at `http://127.0.0.1:4701/dashboard`. State lives in `data/bridge.db` (SQLite WAL); the broker is the sole writer. The Windows service `Bridge` (NSSM 2.24) auto-starts the broker on boot. The same code runs unchanged on Linux behind a systemd unit (`scripts/bridge.service`).

## Files you should give a fresh Claude on a new machine

Paste these into the new Claude Code session in order:

1. `docs/01-overview.md` — what Bridge is, key invariants, target machines.
2. `docs/02-architecture.md` — layer map, component diagram, port layout, schema, endpoints.
3. `docs/03-protocol.md` — 17 message types, floor state machine, hook HTTP contract.
4. `docs/05-operations.md` — install, daily commands, log locations, soak procedure.
5. `HANDOFF.md` — resource budget, hard rules, ship gate.
6. `BLUEPRINTS/Bridge_Blueprint_1_Server_Core.md` and `BLUEPRINTS/Bridge_Blueprint_2_Integration_Layer.md` — the contract.
7. **This file (`docs/04-disaster-recovery.md`)** — the resume prompt and failure playbook.

## Resume prompt for a fresh Claude session

> I'm resuming work on Bridge, a sovereign multi-agent chat broker written in Bun + TypeScript. The full project history, architecture, and protocol are in the `docs/` folder. Read all of `docs/` and both files in `BLUEPRINTS/` before doing anything. The non-negotiables are in `HANDOFF.md` ("Hard rules — do not violate").
>
> Host: AMD Ryzen Threadripper 2970WX, Windows 11. Working directory `Z:\FutureApps\universal_tools\tools\Bridge\`. Bun at `C:\Users\<me>\.bun\bin\bun.exe`. NSSM at `C:\Tools\nssm\nssm.exe`. The service name is `Bridge`.
>
> Verify the broker is healthy with: `Get-Service Bridge`, `Invoke-RestMethod http://127.0.0.1:4701/health` (expect `status=ok`), and open the dashboard at `http://127.0.0.1:4701/dashboard`. If any of those fail, see `docs/04-disaster-recovery.md` § "Failure modes" — the in-session escape hatch for a wedged port is at the end of that section.
>
> Mirror the conventions from the sister project ADBPD (`M:\FutureApps\adb-proxy-daemon\`): TypeScript strict, stable-only deps, pino structured logging, health endpoint shape `{ status, uptime, connectedAgents, version }`, NSSM with `AppNoConsole 1` and explicit `AppStdout`/`AppStderr`.
>
> When you change anything: `bun test` stays green. Never claim done without DONE PROOF — the owner enforces a no-completion-claims rule. Verify with a live run (broker up under NSSM, two TUI clients chatting, dashboard showing the conversation, SessionStart hook injecting a summary into a fresh Claude Code session).

## Failure modes — diagnosis and recovery

Work through this list top-to-bottom. The first match is your problem.

### 1. Broker crash (service Stopped / restart-looping)

**Symptoms:** `Get-Service Bridge` shows `Stopped` or `StartPending` indefinitely. `Invoke-RestMethod http://127.0.0.1:4701/health` times out. Dashboard tab spins.

**Diagnosis:**
```powershell
Get-Content Z:\FutureApps\universal_tools\tools\Bridge\logs\broker-stderr.log -Tail 50
Get-Content Z:\FutureApps\universal_tools\tools\Bridge\logs\broker-stdout.log -Tail 50
```

Crash stack traces land in stderr; pino structured logs in stdout. Common causes:

- **`EADDRINUSE 127.0.0.1:4700`** — a previous broker pid still holds the listen socket (see §2 below).
- **`SQLITE_CORRUPT`** or **`SQLITE_NOTADB`** — store integrity broken (see §3).
- **Module load error / TDZ** — code regression. Roll the repo back to the last known-good commit and re-bun-install.

**Recovery:**
```powershell
# Elevated PowerShell:
C:\Tools\nssm\nssm.exe restart Bridge
Start-Sleep 2
Invoke-RestMethod http://127.0.0.1:4701/health
```

If that loops, jump to §2.

### 2. Port 4700 or 4701 wedge (zombie listener)

**Symptoms:** Service is `Running` per NSSM, but `/health` is unreachable. `netstat -ano | findstr ":4700"` shows `LISTENING` on a pid that `Get-Process` says does not exist, or a pid that is not the current `bun.exe`.

This is the same NSSM handle-inheritance pattern documented in `M:\FutureApps\adb-proxy-daemon\docs\04-disaster-recovery.md` for port 5037. The kernel keeps the listen socket bound to the dead pid because NSSM inherited a reference. Even a clean exit in the broker cannot release it.

**Diagnosis:**
```powershell
netstat -ano | findstr ":4700"
netstat -ano | findstr ":4701"
Get-Process -Id <pid-from-netstat> -ErrorAction SilentlyContinue
(Get-CimInstance Win32_Service -Filter "Name='Bridge'").ProcessId
```

If the netstat pid does not match the NSSM service pid (or `Get-Process` says it does not exist), this is a zombie.

**In-session escape hatch** (use first; cheapest fix):
```powershell
# Elevated PowerShell:
$nssmPid = (Get-CimInstance Win32_Service -Filter "Name='Bridge'").ProcessId
Stop-Process -Id $nssmPid -Force
# SCM auto-restarts the service into a clean state.
Start-Sleep 3
Invoke-RestMethod http://127.0.0.1:4701/health
```

Killing NSSM (not the child bun.exe) releases its inherited socket handles; SCM brings the service back from a clean parent process. This is the same trick ADBPD uses for 5037.

**If the escape hatch fails twice in a row:** run `scripts/reset-bridge.ps1` (see §7). If even that fails, reboot — the cleanest reset.

### 3. SQLite corruption

**Symptoms:** stderr shows `SQLITE_CORRUPT`, `SQLITE_NOTADB`, or `database disk image is malformed`. Broker either crashes on startup or crashes the first time it tries to write.

**Diagnosis:**
```powershell
cd Z:\FutureApps\universal_tools\tools\Bridge
bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('data/bridge.db', { readonly: true });
console.log(db.query('PRAGMA integrity_check').all());
console.log(db.query('PRAGMA wal_checkpoint(FULL)').all());
"
```

`integrity_check` returns `[{integrity_check: 'ok'}]` on a healthy DB. Anything else is the corruption profile.

**Recovery:**

1. **Stop the service** so no writer is racing the recovery:
   ```powershell
   C:\Tools\nssm\nssm.exe stop Bridge
   ```
2. **Attempt SQLite recovery**:
   ```powershell
   cd Z:\FutureApps\universal_tools\tools\Bridge\data
   Copy-Item bridge.db bridge.db.corrupt-$(Get-Date -Format yyyyMMdd-HHmmss)
   sqlite3 bridge.db ".recover" | sqlite3 bridge.db.recovered
   ```
   If `sqlite3.exe` is not on the PATH, install it (`scoop install sqlite` or grab from `https://www.sqlite.org/download.html`).
3. **Swap the recovered file in**:
   ```powershell
   Move-Item bridge.db bridge.db.old
   Move-Item bridge.db.recovered bridge.db
   Remove-Item bridge.db-wal -ErrorAction SilentlyContinue
   Remove-Item bridge.db-shm -ErrorAction SilentlyContinue
   ```
4. **Restart the broker** and verify with the same `integrity_check` query.

If `.recover` produces an unusable file, the fall-back is to start with an empty DB. The agents will replay register on next connect; history older than the corruption is lost. Document the loss in the next status broadcast so other agents know the cursor reset.

### 4. Dashboard 401 / unauthorized

**Symptoms:** Dashboard at `http://127.0.0.1:4701/dashboard` loads HTML but the WS connection drops, or the supervisor injection box returns 401.

Bridge v1.0 does not ship an auth layer — the loopback bind *is* the auth boundary. A 401 from the dashboard means something other than Bridge is serving 4701 (collision with a dev server, a tunneled cloud proxy, etc.).

**Diagnosis:**
```powershell
netstat -ano | findstr ":4701"
Get-Process -Id <pid>
Invoke-WebRequest http://127.0.0.1:4701/health -UseBasicParsing | Select StatusCode, Content
```

If `Content` does not include `"status":"ok"`, port 4701 has been hijacked by another process. Stop that process; Bridge's own retry loop will rebind.

If `/health` does respond cleanly but the dashboard's WS handshake fails, check `logs/broker-stderr.log` for `ws upgrade rejected` lines. Common cause: a CORS / Origin check landed in a recent commit. Roll back or fix the Origin allowlist (`127.0.0.1` and `localhost` only).

### 5. MCP disconnect

**Symptoms:** A Claude Code agent's `bridge_send` calls return errors; `bridge_agents` shows the agent as offline even though the session is open.

**Diagnosis:** Check the MCP server's debug output — it writes to `stderr` because `stdout` is the JSON-RPC channel. Claude Code captures stderr per server; look in Claude Code's MCP server logs (varies by client version) or run the MCP server standalone for a smoke check:

```powershell
$env:BRIDGE_AGENT_ID = "aegis_agent"
$env:BRIDGE_URL      = "ws://127.0.0.1:4700"
bun run Z:\FutureApps\universal_tools\tools\Bridge\src\mcp\bridge-mcp.ts
# Type an MCP `initialize` JSON-RPC message; expect a clean response.
```

Common causes:

- **Broker is down** — fix that first (§1).
- **Wrong `BRIDGE_AGENT_ID`** — agent registers under an unexpected id; `bridge_agents` shows the wrong name. Fix `.mcp.json`.
- **WS reconnect backoff stuck** — the MCP client's reconnect timer is wedged. Restart the Claude Code session (the cleanest reset).

### 6. Soak-time regressions (broker memory or message latency creeping)

**Symptoms:** During the 4h soak (`scripts/soak.ts`) or in long-running production use, broker RSS grows past 500 MB or per-message handler latency exceeds 50 ms p99.

**Diagnosis:**
- Check `logs/broker-stdout.log` for `slow handler` warnings (pino emits these from the broker's own perf timer).
- `Invoke-RestMethod 'http://127.0.0.1:4701/api/messages/unread?agent=isko'` — if Isko has thousands of unread, the dashboard query plan may be linear; index check on `messages(to_agent, ts)`.
- WAL size: `data/bridge.db-wal` should auto-checkpoint at ~4 MB (1000 pages). If it has grown past 100 MB, the checkpoint thread is stuck — restart the broker.

## When to use `scripts/reset-bridge.ps1` vs full reinstall

`scripts/reset-bridge.ps1` is the elevated reset playbook (mirrors `M:\FutureApps\adb-proxy-daemon\scripts\reset-adbpd.ps1`). It does, in order:

1. Verifies elevation.
2. `nssm stop Bridge` with a 30s drain window for connected clients.
3. Force-kills any `bun.exe` whose CWD is the Bridge project.
4. Verifies ports 4700 and 4701 are free (`netstat | findstr`).
5. `nssm start Bridge`.
6. Polls `/health` for up to 30s.

**Use the reset script when:** the in-session escape hatch (§2) failed, or the broker process is stuck in an unkillable state from inside the service supervisor.

**Use a full reinstall when:** the reset script fails repeatedly, the SQLite recovery in §3 cannot salvage the DB, or the on-disk layout has drifted from the blueprint (e.g. someone moved `data/` and the broker can't find it). Full reinstall = `scripts/uninstall-service.ps1` → wipe `data/` and `logs/` → `git pull` to a known-good commit → `bun install` → `scripts/install-service.ps1` per `docs/05-operations.md`.

## Cold-start install on a new machine

If you have nothing but a fresh Windows install and this Git repo:

### 1. Install prerequisites

```powershell
# Bun (run as you, not admin):
powershell -c "irm bun.sh/install.ps1 | iex"

# NSSM (one-time, into C:\Tools\nssm\):
$tmp = Join-Path $env:TEMP 'nssm-2.24.zip'
Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $tmp -UseBasicParsing
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)
$entry = $zip.Entries | Where-Object { $_.FullName -like '*/win64/nssm.exe' } | Select-Object -First 1
New-Item -ItemType Directory -Path 'C:\Tools\nssm' -Force | Out-Null
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, 'C:\Tools\nssm\nssm.exe', $true)
$zip.Dispose()
Remove-Item $tmp
```

NSSM 2.24 win64 SHA-256: `F689EE9AF94B00E9E3F0BB072B34CAAF207F32DCB4F5782FC9CA351DF9A06C97`.

### 2. Clone + install deps

```powershell
cd Z:\FutureApps\universal_tools\tools
git clone <repo-url> Bridge
cd Bridge
bun install
```

### 3. Smoke-test in dev shell

```powershell
bun run src/server/broker.ts
# Expect (in order):
#   "store ready" (bun:sqlite migrations applied)
#   "broker WS listening 127.0.0.1:4700"
#   "broker HTTP listening 127.0.0.1:4701"
#   "Bridge ready"
```

In a separate shell:
```powershell
Invoke-RestMethod http://127.0.0.1:4701/health
# → status=ok, connectedAgents=0
```

### 4. Install as Windows service

```powershell
# Elevated PowerShell:
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 `
    -BunPath C:\Users\$env:USERNAME\.bun\bin\bun.exe
```

The installer creates the service as `Bridge`, sets `Start = SERVICE_AUTO_START`, sets stdout/stderr to `logs\broker-*.log`, and starts it. Verify:
```powershell
Get-Service Bridge
Invoke-RestMethod http://127.0.0.1:4701/health
```

### 5. Verify reboot survival

```powershell
Restart-Computer
# At login (before opening Claude Code or Claude Desktop):
Get-Service Bridge                                  # Running
Invoke-RestMethod http://127.0.0.1:4701/health      # status=ok
Start-Process http://127.0.0.1:4701/dashboard       # dashboard opens
```

All three must pass.

## Owner-side context

- **Identity:** Francisco Ricardo Preciado Jr (Future @I LLC, "Isko"); dashboard agent id `isko`.
- **Host hardware:** Threadripper 2970WX (24C/48T, 4 NUMA nodes). Bridge is single-process and not NUMA-sensitive — no pinning needed.
- **Working directory:** `Z:\FutureApps\universal_tools\tools\Bridge\` on Z: (multi-TB tools volume). Never write build artifacts to C:.
- **Sister project:** ADBPD at `M:\FutureApps\adb-proxy-daemon\` — same author, same conventions, same service-supervisor pattern. When in doubt, mirror what ADBPD does.

## Re-publishing this repo

If you ever push a public version of Bridge:

1. Strip anything proprietary first:
   - The two `.docx` blueprints under `BLUEPRINTS/` — keep `.md` versions only if those are sanitized.
   - Internal-LAN IPs. Loopback is fine; LAN ranges are not.
   - References to internal sibling repos outside the Bridge tree.
2. `.gitignore` must include: `node_modules/`, `data/`, `logs/`, `bridge.db*`, `.env`, `*.transcript.log`, `BLUEPRINTS/*.docx`.
3. `git log -p` against the public branch before pushing — look for accidentally-committed secrets.
