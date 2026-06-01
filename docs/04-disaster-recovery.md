# Disaster Recovery — How to Rebuild from Scratch

This doc exists so the owner can hand a fresh Claude (or any engineer) the full picture and resume the project on a new machine. Read it top-to-bottom before touching anything.

## The 30-second summary

ADBPD is a Bun + TypeScript daemon that replaces Google's `adb-server` on `127.0.0.1:5037`. It runs as a Windows service supervised by NSSM, owns the proxy port before Android Studio launches, and routes per-device traffic to a pool of isolated stock-adb backends (one per device, each with `--one-device <serial>`). On top of that it adds NUMA-aware emulator pinning, a watchdog with auto-recovery, a Maestro port allocator, a Control API on 3002, and a WebSocket event stream on 3003.

Eight build phases (P1–P8) are GREEN. P9 (soak + integration) is the remaining work for v1.0.0.

## Files you should give Claude on a fresh machine

Paste these into the new Claude session in order:

1. **`docs/01-overview.md`** — what this is and why it exists.
2. **`docs/02-architecture.md`** — layer map, key files, protocol details, schema, endpoints.
3. **`docs/03-build-history.md`** — every phase, every bug, every fix. The "what we tried that didn't work" record.
4. **`docs/05-operations.md`** — how to run it, how to debug it.
5. **`CLAUDE.md`** — non-negotiables and locked decisions.
6. **This file (`docs/04-disaster-recovery.md`)** — the resume prompt.

## Resume prompt for a fresh Claude session

Copy the block below into a new Claude Code session, after pasting the docs above:

> I'm resuming work on ADBPD, a sovereign ADB host daemon written in Bun + TypeScript. The full project history, architecture, and build log are in the docs/ folder of this repo. Read all of docs/ before doing anything. The non-negotiables are in CLAUDE.md.
>
> Current status: Phases P1 through P8 are GREEN. P9 (4-hour soak + AegisRx integration baseline) is the remaining work to tag v1.0.0.
>
> My host: AMD Ryzen Threadripper 2970WX, Windows 11, working directory `M:\FutureApps\adb-proxy-daemon\`. Android SDK at `C:\Users\<me>\AppData\Local\Android\Sdk\`. Platform-tools at `C:\Android\platform-tools\`. Bun at `C:\Users\<me>\.bun\bin\bun.exe`. NSSM at `C:\Tools\nssm\nssm.exe`.
>
> ADBPD is installed as a Windows service named `ADBPD` running as `.\plusu`. It auto-starts at boot. Verify with: `Get-Service ADBPD`, `Invoke-RestMethod http://127.0.0.1:3002/health`, `adb -P 5037 devices`. If those pass, the service is healthy. If not, see docs/05-operations.md § "If the service won't start".
>
> Read BUILD_REPORT.md / docs/03-build-history.md for the full failure-and-fix record before introducing any change — many "obvious" approaches have already been tried and ruled out (Direct daemon protocol → deviation D4. better-sqlite3 → deviation D1. LocalSystem service account → can't access user AVD home, switched to `.\plusu`).
>
> When you make changes: bun test must stay green. Document deviations in BUILD_REPORT.md BEFORE implementing, not after. Every claim of "GREEN" needs a live verification, not a unit test pass. The owner enforces a no-completion-claims rule — never say "done" without DONE PROOF evidence.

## Cold-start install on a new machine

If you have nothing but a fresh Windows install and this Git repo:

### 1. Install prerequisites

```powershell
# Bun (run as you, not admin):
powershell -c "irm bun.sh/install.ps1 | iex"

# Android SDK platform-tools + emulator:
#   Easiest: install Android Studio (sdkmanager bundled), then sdkmanager
#   "platform-tools" "emulator" "system-images;android-34;google_apis;x86_64".
#   Or grab https://dl.google.com/android/repository/platform-tools-latest-windows.zip
#   and extract to C:\Android\platform-tools\.

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

Verify NSSM SHA-256 (NSSM 2.24 win64): `F689EE9AF94B00E9E3F0BB072B34CAAF207F32DCB4F5782FC9CA351DF9A06C97`.

### 2. Clone + install deps

```powershell
cd M:\FutureApps    # or wherever you want it
git clone https://github.com/<your-user>/adb-fix.git adb-proxy-daemon
cd adb-proxy-daemon
bun install
```

### 3. Smoke-test in dev shell first

```powershell
$env:ADBPD_EMULATOR_BIN = "C:\Users\$env:USERNAME\AppData\Local\Android\Sdk\emulator\emulator.exe"
$env:ADBPD_MANAGED_AVDS = "Pixel_9_Pro@5554"   # optional — only if you have this AVD
bun run src/main.ts
```

You should see (in order, ~30s):
- `NUMA topology detected`
- `smart socket listening` on 5037
- `spawning emulator` (if managed AVD configured)
- `process pinned` (launcher)
- `qemu VM child pinned` (≤1s after launcher)
- `backend ready, device online`
- `Control API HTTP listening` (3002)
- `Control API WebSocket listening` (3003)
- `ADBPD ready`

In a separate shell:
```powershell
adb -P 5037 devices            # should list emulator-5554 online
adb -P 5037 -s emulator-5554 shell echo hello   # should print hello
Invoke-RestMethod http://127.0.0.1:3002/health  # status=ok
```

If those pass, the code itself is healthy. Stop with Ctrl+C.

### 4. Install as Windows service

```powershell
# From elevated PowerShell:
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 `
    -BunPath C:\Users\$env:USERNAME\.bun\bin\bun.exe `
    -ManagedAvds "Pixel_9_Pro@5554"    # optional
```

The installer defaults to LocalSystem. **If you want managed AVDs to work**, switch to your user account immediately after install:

```powershell
# Still in elevated PowerShell, replace <password> with your own:
C:\Tools\nssm\nssm.exe set ADBPD ObjectName .\$env:USERNAME '<password>'
C:\Tools\nssm\nssm.exe restart ADBPD
```

Why: LocalSystem can't access your user's `~/.android/avd` directory and doesn't have a desktop session for the emulator to attach to. The emulator binary fails silently. Running as your user account fixes both.

### 5. Verify reboot survival

```powershell
Restart-Computer
# At login (do NOT open Android Studio first):
Get-Service ADBPD                                   # Status: Running
Invoke-RestMethod http://127.0.0.1:3002/health      # status: ok
adb -P 5037 devices                                 # devices listed
```

All three must pass. If any fail, see [`docs/05-operations.md`](05-operations.md) § "If the service won't start".

## Known gotchas (machine-specific things to recognize)

- **NSSM AppRestart loop on TDZ.** If you're running an older snapshot of `main.ts`, watch the service log for `Cannot access 'watchdog' before initialization`. That's a TDZ — fixed in commit `543b832` by hoisting `proxy`/`watchdog`/`api` as nullable `let` decls.

- **Port 5037 zombie listener** (**known limitation, no in-process fix**). After ADBPD shuts down under NSSM supervision, the kernel can keep the 5037 listen socket bound to the dead pid. Cause: NSSM inherits the bun child's socket handle and doesn't release it until NSSM itself rotates. Even a clean exit (forceful socket `destroy()` in `SmartSocketProxy.stop()`) doesn't help — the kernel-level binding is held by NSSM's inherited handle, not bun's. **The only reliable way to clear it is a system reboot or `nssm remove ADBPD confirm`** (which kills the NSSM process tree). Symptoms: `netstat -ano | findstr 5037` shows LISTENING on a pid that `Get-Process` says doesn't exist; service restart loops on EADDRINUSE. The smart-socket has an EADDRINUSE retry loop (12 × 5s) that survives the *new* code's own restart cycle when NSSM does manage to rotate, but cannot wait out a sustained inherited-handle leak. **Follow-up for v1.1:** investigate `nssm set ADBPD AppNoConsole 1` + `AppDontSpawnConsole 1` (suppress handle inheritance), or migrate from NSSM to a Windows-native service via `sc.exe create` with explicit `SERVICE_WIN32_OWN_PROCESS` and no handle inheritance.

- **Stock adb daemon racing.** `adb devices` from a fresh shell auto-starts a daemon on 5037 if nothing is there. If your service is in StartPending, that stock daemon will win the bind. Either wait for the service or `adb kill-server` before re-checking.

- **AVD cold-boot timeout.** The `HybridBackendTransport.connect` default is 20s, fine for warm AVDs and USB. Cold AVDs spawned by the service take 27–40s on this host — the managed-AVD launch passes `readyTimeoutMs: 120_000` to absorb that. If you change this and a managed AVD ends up in the pool but not in the managed Map, the watchdog won't auto-relaunch on wedge. There's a discovery-path claim fallback in main.ts as a belt-and-suspenders.

- **Emulator → qemu child.** Killing `emulator.exe` does NOT kill the VM — that's the qemu child process. For wedge tests, kill `qemu-system-x86_64-headless`.

- **Note 20 (or any USB phone) booting offline.** Screen-lock or USB autosuspend can show the device as `offline` post-reboot. Unlock the screen; the per-device backend's polling should pick it back up.

## Owner-side context

- **Identity:** Francisco Ricardo Preciado Jr (GitHub `fpresiado`).
- **Host hardware:** Threadripper 2970WX (24C/48T, 4 NUMA nodes × 12 logical processors each).
- **Working directory:** `M:\FutureApps\adb-proxy-daemon\` on a fast SSD. M: is the canonical drive; never write build artifacts to C:.
- **Bun version pin:** `1.3.9` (locked at start of build).
- **`@yume-chan/adb` pin:** `2.6.0` (locked; don't upgrade without a deliberate decision).

If the build host dies and you need to bring this back up on a different machine, the NUMA mask values in the hardcoded fallback (`numa-pinner.ts` `HARDCODED_FALLBACK`) won't match the new CPU. The Bun FFI `GetLogicalProcessorInformationEx` detection is the source of truth — the fallback only fires if FFI fails entirely, and we log a warning when it does. If you see that warning on a non-Threadripper host, replace the fallback masks with whatever Windows reports via `Get-Counter '\NUMA Node Memory(*)\Total MBytes'` for that host.

## Recovery path priority order

If something is broken, work through this list top to bottom:

1. **Is the service running?** `Get-Service ADBPD`. If Stopped/StartPending → check the service log at `logs/adbpd.stderr.log` and `logs/adbpd.stdout.log`.
2. **Is port 5037 owned by ADBPD?** `netstat -ano | findstr 5037` then `Get-Process -Id <pid>`. If owned by stock `adb.exe` → `adb kill-server`; the service will reclaim.
3. **Does /health respond?** `Invoke-RestMethod http://127.0.0.1:3002/health`. If no response but service is Running → check stderr log for a crash.
4. **Does adb -P 5037 devices list both?** If emulator missing → check `/emulators` (was the managed AVD launched?). If USB missing → unlock the device, check Win32 USB enumeration didn't race.
5. **Are there active incidents?** `Invoke-RestMethod 'http://127.0.0.1:3002/incidents?active=true'`. Open incidents mean the watchdog detected a wedge it couldn't recover from.
6. **Last resort:** `nssm stop ADBPD` from elevated, `Restart-Computer`, then verify the boot-up cleanly.

## Re-publishing this repo

If you ever need to rebuild from a private fork or push an updated public version:

1. Strip anything proprietary first. The repo at `M:\FutureApps\adb-proxy-daemon\` originally contained:
   - `.blueprint.txt` — the proprietary spec extracted via Word COM. Never publish.
   - Internal-LAN IPs (`192.168.x.x` style). Use placeholders in public docs.
   - References to internal sibling repos in any path under `M:\FutureApps\` other than `adb-proxy-daemon\`. Generalize to "an internal pattern".
2. The `.gitignore` should always include: `node_modules/`, `data/`, `logs/`, `adbpd.sqlite*`, `adbpd.log`, `*.transcript.log`, `.env`, `.blueprint.txt`.
3. Run `git log -p` against the public branch and look for accidentally-committed secrets before pushing.
