# ADBPD - one-shot recovery for the NSSM 5037 zombie pattern.
#
# Use this when:
#   - `Get-Service ADBPD` shows Running
#   - `Invoke-RestMethod http://127.0.0.1:3002/health` fails to connect
#   - `adb -P 5037 devices` returns "cannot connect to daemon"
#
# What happens here is the documented in-session escape hatch from
# docs/04-disaster-recovery.md, automated end-to-end with verification:
#
#   1. Find the NSSM supervisor PID via Win32_Service
#   2. Stop the service through SCM (graceful)
#   3. If NSSM is still alive after the grace window, force-kill it -
#      that release the inherited 5037 socket handle. SCM auto-restarts.
#   4. If SCM doesn't auto-restart within 10s, Start-Service explicitly.
#   5. Poll /health until status=ok (up to 180s for AVD cold-boot)
#   6. Verify `adb -P 5037 devices` returns at least one device
#
# Must run from elevated PowerShell. Refuses to run unprivileged.
#
# Background: see docs/04-disaster-recovery.md § "Port 5037 zombie listener".
# Permanent fix is the v1.2 Rust service wrapper (CreateProcess with
# bInheritHandles=FALSE), tracked in adbpd_v1_release memory.

[CmdletBinding()]
param(
    [int]$HealthTimeoutSec = 180,
    [int]$AdbPort = 5037,
    [string]$AdbPath = 'C:\Android\platform-tools\adb.exe'
)

$ErrorActionPreference = 'Stop'

function Write-Step($label) { Write-Host "`n=== $label ===" -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg)  { Write-Host "[!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)    { Write-Host "[X]  $msg" -ForegroundColor Red }

# 1. Elevation gate.
Write-Step "Pre-flight"
$IsAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Err "Must run from an elevated PowerShell prompt."
    exit 1
}
Write-Ok "elevated"

# 2. Locate the service + NSSM supervisor PID.
$svc = Get-CimInstance Win32_Service -Filter "Name='ADBPD'" -ErrorAction SilentlyContinue
if ($null -eq $svc) {
    Write-Err "ADBPD service is not installed. Run install-service.ps1 first."
    exit 2
}
$nssmPid = $svc.ProcessId
Write-Ok "service installed, NSSM supervisor pid: $nssmPid (state: $($svc.State))"

# 3. Graceful stop via SCM.
Write-Step "Stopping service via SCM"
try {
    Stop-Service -Name ADBPD -Force -ErrorAction Stop
    Write-Ok "Stop-Service returned"
} catch {
    Write-Warn2 "Stop-Service threw: $($_.Exception.Message) - falling through to force-kill"
}

# Give SCM 3s to settle.
Start-Sleep -Seconds 3

# 4. If NSSM is still alive, force-kill it. This is the step that
#    actually releases the inherited 5037 handle. Without this, SCM's
#    stop just signals NSSM (which signals bun) but NSSM stays alive
#    and keeps the handle.
$nssmAlive = $false
if ($nssmPid -gt 0) {
    $proc = Get-Process -Id $nssmPid -ErrorAction SilentlyContinue
    if ($null -ne $proc) {
        $nssmAlive = $true
        Write-Warn2 "NSSM pid $nssmPid is still alive after Stop-Service - force-killing to release inherited 5037 handle"
        Stop-Process -Id $nssmPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}
if (-not $nssmAlive) {
    Write-Ok "NSSM already exited cleanly"
}

# Sweep any orphan bun children that didn't follow NSSM down.
$orphans = Get-Process bun -ErrorAction SilentlyContinue
if ($null -ne $orphans) {
    Write-Warn2 "killing $($orphans.Count) orphan bun process(es)"
    $orphans | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# 5. Confirm 5037 is free at the kernel level. If it isn't, the zombie
#    pattern is somehow still active - we report and bail.
Write-Step "Verifying port $AdbPort is released"
$listener = Get-NetTCPConnection -LocalPort $AdbPort -State Listen -ErrorAction SilentlyContinue
if ($null -ne $listener) {
    Write-Err "Port $AdbPort is still LISTENING (owning pid: $($listener.OwningProcess)). The zombie persists despite the kill. Last-resort fix: Restart-Computer."
    exit 3
}
Write-Ok "port $AdbPort released"

# 6. Start the service. SCM should auto-restart since NSSM was killed,
#    but it's not guaranteed - be explicit.
Write-Step "Starting service"
try {
    Start-Service -Name ADBPD -ErrorAction Stop
} catch {
    Write-Warn2 "Start-Service returned: $($_.Exception.Message). Trying SCM directly."
    sc.exe start ADBPD | Out-Null
}
Start-Sleep -Seconds 3

# 7. Poll /health until status=ok or we hit the timeout.
Write-Step "Waiting for /health (up to ${HealthTimeoutSec}s - cold AVD boot)"
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    try {
        $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/health' -TimeoutSec 3 -ErrorAction Stop
        if ($h.status -eq 'ok') {
            Write-Ok ("status=ok uptime={0}s deviceCount={1} fmEnabled={2}" -f $h.uptime, $h.deviceCount, $h.fmEnabled)
            $healthy = $true
            break
        }
    } catch { Start-Sleep -Seconds 5 }
}
if (-not $healthy) {
    Write-Err "Daemon did not respond on /health within ${HealthTimeoutSec}s. Check logs\adbpd.stderr.log."
    exit 4
}

# 8. adb sees the daemon.
Write-Step "Verifying adb -P $AdbPort devices"
if (-not (Test-Path $AdbPath)) {
    Write-Warn2 "adb binary not found at $AdbPath - skipping adb-side verify (daemon is up per /health, which is sufficient)"
} else {
    try {
        $out = & $AdbPath -P $AdbPort devices 2>&1 | Out-String
        Write-Host $out
        if ($out -match 'cannot connect to daemon|daemon not running') {
            Write-Err "adb couldn't connect to the daemon. Smart-socket is bound (per /health) but adb is wedged - try once more, then escalate to Restart-Computer."
            exit 5
        }
        Write-Ok "adb is talking to ADBPD"
    } catch {
        Write-Warn2 "adb spawn failed: $($_.Exception.Message)"
    }
}

Write-Step "Recovery complete"
Write-Host "Daemon is back. You can resume Studio / Maestro / Gradle." -ForegroundColor Green
Write-Host ""
Write-Host "If this script becomes a regular part of your day, the right answer is the" -ForegroundColor Gray
Write-Host "v1.2 Rust service wrapper, not running this more often. See:" -ForegroundColor Gray
Write-Host "  docs/04-disaster-recovery.md section 'Port 5037 zombie listener'" -ForegroundColor Gray
