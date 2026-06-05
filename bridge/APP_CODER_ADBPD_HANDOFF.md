# ADBPD — Onboarding for the App Coder

**Audience:** A coder working on a different Future @I app, sharing this Windows workstation with another active coder (working on AegisRx + Bridge under Android Studio + emulator-5554). You'll be testing on the **Note 20 Ultra** while the other coder uses the **headless emulator** via Android Studio.

**Why you're reading this:** ADBPD is the adb host daemon on this machine. Every `adb` command you run, every `npx react-native run-android`, every `expo run:android`, every Maestro flow — all of it routes through ADBPD on port 5037 instead of stock Google adb. If ADBPD is broken, NOTHING Android-side works. This doc tells you what it is, how to use it, what NOT to do, and how to recover if it breaks while you're mid-build.

If you have ZERO prior context, read this doc start to finish before running any command. The "Resume-from-scratch" section at the very end has the cold-start verification.

---

## 1. What ADBPD is and why it exists

ADBPD ("ADB Proxy Daemon") is a sovereign replacement for Google's bundled adb host daemon. Same wire protocol on the same port (127.0.0.1:5037) — every adb client (Studio, gradle, Maestro, react-native, expo, scrcpy) treats it as if it were Google's adb. Internally it's a Bun + TypeScript daemon that:

- Manages multiple Android devices (USB phones + headless emulators) at once with per-device backend isolation
- Spawns and supervises headless emulators itself (no Android Studio process needed to keep an AVD alive)
- Has a watchdog that detects wedged devices and auto-recovers
- Exposes a Control API on `127.0.0.1:3002` for health checks and management
- Runs as a Windows NSSM service named `ADBPD` — Automatic start, survives reboots

Owner replaced Google's adb because Google's daemon has known bugs (process-shutdown handle leaks, NUMA-blind emulator spawning, no per-device isolation) that block reliable multi-device CI on this machine.

**Current ship state:** ADBPD v1.0.1 (commit `924e87e` on `master`, tag `v1.0.1`). Public repo at `https://github.com/fpresiado/adb-fix`.

---

## 2. The device split (read carefully)

This workstation has **two Android targets connected** at any given time:

| Device | Used by | How it's connected |
|---|---|---|
| `emulator-5554` (Pixel_9_Pro AVD, headless) | The OTHER coder (AegisRx + Bridge work, via Android Studio) | Spawned by ADBPD itself in Windows session 0, invisible to your desktop |
| `R5CN90VPWQW` (Samsung Note 20 Ultra) | **YOU** | Physical phone over USB |

**Your default device is the Note 20.** Every adb command you run that targets "a device" should explicitly use `-s R5CN90VPWQW` so you don't accidentally drive the other coder's emulator.

```powershell
# ✓ correct — targets your phone
adb -s R5CN90VPWQW install my-app.apk

# ✗ wrong — without -s, adb picks "the only device" or fails ambiguously;
#   either way you might hit the wrong target
adb install my-app.apk
```

If `adb devices -l` ever shows you only ONE device instead of two, surface it. Most of the time it means the other coder's emulator crashed (their problem, not yours) or your USB cable disconnected.

---

## 3. Pre-flight (run this before starting any work session)

```powershell
# 1. ADBPD service alive?
Get-Service ADBPD
# StartType should be Automatic, Status should be Running

# 2. ADBPD daemon healthy?
Invoke-RestMethod http://127.0.0.1:3002/health
# Expect: { status: "ok", uptime: <s>, deviceCount: 2, fmEnabled: false, version: "0.1.0" }

# 3. Both devices visible and online?
adb devices -l
# Expect TWO rows, both with state = device:
#   emulator-5554   device product:unknown model:unknown ...
#   R5CN90VPWQW     device product:unknown model:unknown ...

# 4. Your phone reachable?
adb -s R5CN90VPWQW shell getprop ro.build.version.release
# Expect a number like 13 / 14 (the Android version on your phone)
```

If ALL four pass: you're clear to work. If ANY fail: see § 7 (Disaster recovery).

---

## 4. Useful daily commands

Use these for normal app dev. Nothing here will hurt the other coder's session.

```powershell
# Install / reinstall an APK
adb -s R5CN90VPWQW install -r my-app.apk

# Uninstall
adb -s R5CN90VPWQW uninstall com.your.package

# Logcat (your phone only)
adb -s R5CN90VPWQW logcat -v threadtime *:I

# Logcat filtered to your app's tag
adb -s R5CN90VPWQW logcat -s YourTag:V

# Push a file
adb -s R5CN90VPWQW push localfile.txt /sdcard/Download/

# Pull a file
adb -s R5CN90VPWQW pull /sdcard/Download/whatever.txt .

# Shell on your phone
adb -s R5CN90VPWQW shell

# Forward a port (e.g. dev server on phone to your localhost)
adb -s R5CN90VPWQW forward tcp:8081 tcp:8081

# Screenshot
adb -s R5CN90VPWQW exec-out screencap -p > screenshot.png

# List your packages
adb -s R5CN90VPWQW shell pm list packages | findstr "com.your.app"

# React Native / Expo dev runs (these will auto-target your phone if it's the only USB device,
#   but be safe and explicitly export ANDROID_SERIAL):
$env:ANDROID_SERIAL = "R5CN90VPWQW"
npx react-native run-android
# or
npx expo run:android --device
```

---

## 5. HARD RULES — do not violate

These are the rules that keep ADBPD alive across both coders' sessions.

| Rule | Why |
|---|---|
| **Never run `adb kill-server`** | Kills ADBPD's bun process. Service auto-restarts but every connected client (Studio, gradle, Maestro, your dev runs) gets dropped. The OTHER coder's emulator session might never recover. |
| **Never run `Stop-Service ADBPD` mid-build** | Same as above plus you might hit the 5037 kernel-zombie pattern (see §7) where the port stays bound after the daemon dies. Owner has burned a session debugging this. |
| **Never run `taskkill /f` against `bun.exe`** | Same outcome. If a bun process is misbehaving, surface to owner first. |
| **Never install Google's standalone adb on this machine** | Anyone's adb client will route to whatever's on port 5037. Adding stock adb to PATH does nothing harmful, but DON'T run a separate adb-server. |
| **Never close the OTHER coder's emulator window** | There is no window — it's headless in session 0. But if you SEE one (unexpected), don't kill it. It belongs to ADBPD's EmulatorManager and killing it triggers a wedge recovery cycle. |
| **Never run `nssm restart ADBPD`** | Owner's standing rule. Use `Restart-Service ADBPD` if you absolutely must, and only when nobody is mid-build. |
| **Never edit ADBPD source** to work around something | File the gap (mention it to owner). The infra coder's backlog has a place for ADBPD protocol gaps already (see `bridge/INFRA_BACKLOG_HANDOFF.md` on this branch). |
| **Never run a 4-hour soak test against your app on the shared emulator** | Use your Note 20 for soaks. The other coder needs the emulator for their work. |

If your build needs something ADBPD doesn't support yet (e.g. some obscure adb subcommand returns "unknown command: host:..."), surface the gap. It's a known-and-OK pattern that ADBPD has a few gaps. Recently filed: `host:get-state`, `host:reconnect`, `host:reconnect-offline` — all on the v1.1 backlog.

---

## 6. When everything is working — a normal flow

You probably want to:
1. Verify pre-flight (`§3`) — green
2. Build your app (`./gradlew assembleDebug` or `npx expo prebuild && npx expo run:android --device`)
3. Install (`adb -s R5CN90VPWQW install -r ...`)
4. Open the app, drive it, watch logcat
5. Iterate

You'll go entire days without touching ADBPD directly. It just sits there serving 5037 like Google's adb would.

---

## 7. Disaster recovery (when something breaks)

There are five common failure modes. In order from "trivial" to "owner-escalation":

### 7.1 — `adb devices` returns empty or "daemon not running"

**First check:** is the service actually alive?
```powershell
Get-Service ADBPD
```
If Stopped: `Start-Service ADBPD`. If Running but `adb devices` still empty: jump to 7.2.

### 7.2 — `adb` reports "cannot connect to daemon"

This is the **5037 zombie pattern.** Something held the kernel listen socket open after the previous bun process exited; the new bun can't bind, so adb gets RST. Run the disaster-recovery script:

```powershell
# Must be elevated PS
powershell -ExecutionPolicy Bypass -File M:\FutureApps\adb-proxy-daemon\scripts\reset-adbpd.ps1
```

The script: stops the service via SCM, force-kills NSSM if it's lingering, sweeps stray bun processes, verifies port 5037 is free, restarts the service, polls `/health` for up to 180 seconds, verifies adb sees the daemon.

Exit codes:
- 0 — clean recovery
- 1 — not elevated (re-run from admin PS)
- 2 — service not installed (broken setup; escalate to owner)
- 3 — port 5037 STILL held after kill (kernel zombie that survives Stop-Service; usually means **Studio's bundled adb is the squatter**; see § 7.3)
- 4 — daemon didn't respond on /health (check `M:\FutureApps\adb-proxy-daemon\logs\adbpd.stderr.log`)
- 5 — adb couldn't connect even though /health said ok (rare; escalate)

### 7.3 — Port 5037 owned by an invisible pid (Studio's adb)

If `reset-adbpd.ps1` exits 3, run:

```powershell
Get-NetTCPConnection -LocalPort 5037 -State Listen | Format-List LocalAddress,OwningProcess
```

If the OwningProcess pid is NOT visible via `Get-Process -Id <pid>` (returns nothing) but `netstat -ano | findstr 5037` shows ESTABLISHED rows whose CLIENT pids are Java processes from `C:\Users\plusu\AppData\Local\...\jdk-17...\java.exe` — that's Android Studio's bundled adb that died uncleanly. The kernel keeps its listen socket bound.

**Only fix:** cold restart of the Windows machine. This will end EVERYONE's session including yours and the other coder's. Surface to owner before doing this. Owner has explicitly authorized cold restart in past incidents; standing rule is don't reboot unilaterally.

### 7.4 — Your phone shows `offline` instead of `device`

Most common reason: USB authorization expired or USB cable is now power-only.

```powershell
# Confirm device state
adb devices -l

# If R5CN90VPWQW shows "offline":
adb -s R5CN90VPWQW reconnect          # may fail — "unknown command: host:reconnect" is a known v1.1 gap

# If reconnect doesn't help:
# 1. Unplug + replug USB
# 2. On the phone, accept the "Allow USB debugging?" prompt if it appears
# 3. adb devices -l again
```

If the phone shows `unauthorized`: tap the prompt on the phone, then `adb -s R5CN90VPWQW kill-server` — WAIT no, **never run kill-server**. Instead: unplug/replug, the daemon picks up the new auth automatically.

### 7.5 — `/health` says ok but a specific adb command hangs

Some adb commands hit code paths that aren't fully implemented (the protocol gaps mentioned in § 5). If a command hangs for >30s:

1. `Ctrl+C` your client (the daemon won't crash; it'll just lose that connection)
2. Try a different equivalent if there is one (e.g. `adb -s X shell getprop ...` instead of `adb -s X get-state`)
3. Note the exact command and surface to owner — it's likely a protocol gap to file

---

## 8. Where things live (if you need to dig)

| Thing | Path |
|---|---|
| ADBPD source | `M:\FutureApps\adb-proxy-daemon\` |
| ADBPD service install script | `M:\FutureApps\adb-proxy-daemon\scripts\install-service.ps1` |
| ADBPD disaster-recovery script | `M:\FutureApps\adb-proxy-daemon\scripts\reset-adbpd.ps1` |
| ADBPD logs | `M:\FutureApps\adb-proxy-daemon\logs\adbpd.stdout.log` / `adbpd.stderr.log` |
| ADBPD docs | `M:\FutureApps\adb-proxy-daemon\docs\01-overview.md` through `docs\05-operations.md` |
| ADBPD public repo | `https://github.com/fpresiado/adb-fix` (branch `master`) |
| ADBPD backlog handoff (for infra coder) | `bridge/INFRA_BACKLOG_HANDOFF.md` on this same branch |
| Bridge (the cross-Claude-Code coordination broker; not your concern unless integrating) | `Z:\FutureApps\universal_tools\tools\Bridge\` |
| Android SDK | `C:\Android\` (NOT in the standard `%LOCALAPPDATA%` location) |
| `adb.exe` (stock client, points at ADBPD on 5037) | `C:\Android\platform-tools\adb.exe` |
| Your phone serial | `R5CN90VPWQW` |
| Other coder's emulator serial | `emulator-5554` (Pixel_9_Pro AVD) |

---

## 9. If you absolutely cannot recover (escalation path)

In this order:

1. Run the reset script (§ 7.2). If exit 0: done.
2. If reset exits 3: check § 7.3 — Studio's adb might be the squatter.
3. Check the daemon's stderr log (`M:\FutureApps\adb-proxy-daemon\logs\adbpd.stderr.log`) for the last 50 lines. Often the actual error message is there.
4. Confirm the OTHER coder hasn't done something destructive to ADBPD in their session (ask them; their CLAUDE.md tells them not to touch ADBPD source).
5. Surface to owner with: (a) what you were doing when it broke, (b) the output of `Get-Service ADBPD`, (c) the output of `Invoke-RestMethod http://127.0.0.1:3002/health` (or the error), (d) the output of `adb devices -l` (or the error), (e) the last 30 lines of `adbpd.stderr.log`.

Owner will decide if it's worth a cold restart (kills all sessions, clears any kernel-level wedge), or whether the daemon needs a code-level fix in `M:\FutureApps\adb-proxy-daemon\src\`.

---

## 10. What you should NOT do (recap, because this matters)

- Don't `adb kill-server`
- Don't `Stop-Service ADBPD` mid-build
- Don't `taskkill bun.exe`
- Don't `nssm restart ADBPD`
- Don't install a parallel Google adb server
- Don't kill the headless emulator process
- Don't run a soak against the shared emulator (use your Note 20)
- Don't reboot the machine without owner's go-ahead
- Don't edit ADBPD source to work around a gap — file the gap instead

If you're tempted to do any of these, take a breath. There's almost always a non-destructive recovery in § 7.

---

## 11. Resume-from-scratch (if you've been parachuted in with zero context)

You're a fresh coder. Either your prior session ended or someone handed you this app cold. Do this in order before writing any code:

1. **Read this entire doc.** Don't skim. Especially § 5 hard rules and § 7 recovery.
2. **Run pre-flight** (§ 3). All four checks green.
3. **Read** `M:\FutureApps\adb-proxy-daemon\docs\01-overview.md` and `docs\05-operations.md` — official ADBPD product docs.
4. **Confirm your phone**: `adb -s R5CN90VPWQW shell getprop ro.product.model` should return `SM-N986U` (Note 20 Ultra) or similar.
5. **Set your default device** for the session: `$env:ANDROID_SERIAL = "R5CN90VPWQW"`.
6. **Now you can build.** Your app source is wherever owner pointed you; ADBPD is the adb you'll be talking to.

If you cannot complete steps 1-4: stop, surface to owner, do not start coding. A broken environment will waste hours of debugging that's actually infrastructure, not your app.

---

## Useful one-liners

```powershell
# Quick env setup for a session
$env:ANDROID_HOME = 'C:\Android'
$env:ANDROID_SERIAL = 'R5CN90VPWQW'
$env:PATH = 'C:\Android\platform-tools;' + $env:PATH

# Daily health sanity (paste into a fresh terminal at start of session)
Get-Service ADBPD ; Invoke-RestMethod http://127.0.0.1:3002/health ; adb devices -l

# Recovery one-liner (elevated PS only)
powershell -ExecutionPolicy Bypass -File M:\FutureApps\adb-proxy-daemon\scripts\reset-adbpd.ps1
```

---

Ship clean. ADBPD is rock-solid in normal use; this doc exists for the day it isn't.
