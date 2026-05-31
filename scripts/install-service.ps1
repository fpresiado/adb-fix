# ADBPD — NSSM service installer (P8).
#
# Installs ADBPD as a Windows service that starts automatically before any
# user logs in. Survives reboot, recovers from process crash, restarts
# automatically if Bun exits non-zero.
#
# Why NSSM (Non-Sucking Service Manager) vs sc.exe / node-windows:
#   - NSSM handles the "Bun is a console app, not a real Windows service"
#     impedance mismatch (process supervision + stdout/stderr capture).
#   - Mature, single-binary, no .NET dependency, used widely in production.
#
# Requirements:
#   - Run from an elevated PowerShell prompt (RunAs Administrator).
#   - NSSM binary at C:\Tools\nssm\nssm.exe (overridable via -NssmPath).
#     Download: https://nssm.cc/release/nssm-2.24.zip
#   - Bun installed and on PATH for the SYSTEM account, OR pass -BunPath.
#
# Verifies survives-reboot per Session 5 spec: after install, the script
# prints the exact commands the owner should run after rebooting to confirm
# ADBPD started before Android Studio.

[CmdletBinding()]
param(
    [string]$ServiceName = 'ADBPD',
    [string]$NssmPath    = 'C:\Tools\nssm\nssm.exe',
    [string]$BunPath     = '',
    [string]$ProjectPath = 'M:\FutureApps\adb-proxy-daemon',
    [string]$LogDir      = 'M:\FutureApps\adb-proxy-daemon\logs',
    [string]$ManagedAvds = ''
)

$ErrorActionPreference = 'Stop'

function Write-Section($msg) {
    Write-Host ''
    Write-Host "=== $msg ===" -ForegroundColor Cyan
}

# 1. Sanity checks.
Write-Section "Pre-flight"

$IsAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    throw "Must be run from an elevated PowerShell prompt (RunAs Administrator)."
}
Write-Host "[OK] elevated"

if (-not (Test-Path $NssmPath)) {
    throw "NSSM not found at $NssmPath. Download from https://nssm.cc/release/nssm-2.24.zip and extract win64\nssm.exe to $NssmPath, or pass -NssmPath."
}
Write-Host "[OK] nssm at $NssmPath"

if ($BunPath -eq '') {
    $found = Get-Command bun -ErrorAction SilentlyContinue
    if ($null -eq $found) {
        throw "bun not on PATH and -BunPath not provided. Pass -BunPath C:\Users\<you>\.bun\bin\bun.exe"
    }
    $BunPath = $found.Source
}
if (-not (Test-Path $BunPath)) {
    throw "Bun binary not found at $BunPath"
}
Write-Host "[OK] bun at $BunPath"

if (-not (Test-Path "$ProjectPath\src\main.ts")) {
    throw "Project main.ts not found at $ProjectPath\src\main.ts"
}
Write-Host "[OK] project at $ProjectPath"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
Write-Host "[OK] log dir at $LogDir"

# 2. Remove any prior installation (idempotent).
Write-Section "Removing prior installation (if any)"
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    if ($existing.Status -eq 'Running') {
        Write-Host "[..] stopping existing service"
        & $NssmPath stop $ServiceName | Out-Null
        Start-Sleep -Seconds 2
    }
    Write-Host "[..] uninstalling existing service"
    & $NssmPath remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 1
} else {
    Write-Host "[OK] no prior service"
}

# 3. Install service.
Write-Section "Installing $ServiceName"
& $NssmPath install $ServiceName $BunPath "run $ProjectPath\src\main.ts" | Out-Null
& $NssmPath set $ServiceName AppDirectory $ProjectPath | Out-Null
& $NssmPath set $ServiceName DisplayName 'ADB Proxy Daemon (Future ATI LLC)' | Out-Null
& $NssmPath set $ServiceName Description 'Sovereign ADB host daemon replacing Google adb-server on 5037. NUMA-pinned emulators, parallel Maestro support, watchdog auto-recovery.' | Out-Null

# Start automatically at boot, BEFORE user login. This is critical to the
# Session 5 spec: ADBPD must be up before Android Studio launches.
& $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmPath set $ServiceName Type SERVICE_WIN32_OWN_PROCESS | Out-Null

# Run as LocalSystem (full hardware access for USB + emulator).
& $NssmPath set $ServiceName ObjectName LocalSystem | Out-Null

# Environment.
$envBlock = @(
    "ADBPD_ADB_PATH=C:\Android\platform-tools\adb.exe"
    "ADBPD_EMULATOR_BIN=C:\Users\plusu\AppData\Local\Android\Sdk\emulator\emulator.exe"
    "ADBPD_DB_PATH=$ProjectPath\adbpd.sqlite"
) -join "`r`n"
if ($ManagedAvds -ne '') {
    $envBlock += "`r`nADBPD_MANAGED_AVDS=$ManagedAvds"
}
& $NssmPath set $ServiceName AppEnvironmentExtra $envBlock | Out-Null

# Logging.
& $NssmPath set $ServiceName AppStdout "$LogDir\adbpd.stdout.log" | Out-Null
& $NssmPath set $ServiceName AppStderr "$LogDir\adbpd.stderr.log" | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 10485760 | Out-Null

# Crash recovery — restart on non-zero exit, with backoff.
& $NssmPath set $ServiceName AppExit Default Restart | Out-Null
& $NssmPath set $ServiceName AppRestartDelay 5000 | Out-Null
& $NssmPath set $ServiceName AppThrottle 10000 | Out-Null

# Graceful shutdown — give 30s for SIGTERM cleanup.
& $NssmPath set $ServiceName AppStopMethodConsole 30000 | Out-Null
& $NssmPath set $ServiceName AppStopMethodWindow 5000 | Out-Null
& $NssmPath set $ServiceName AppStopMethodThreads 5000 | Out-Null

Write-Host "[OK] service installed"

# 4. Start it.
Write-Section "Starting $ServiceName"
& $NssmPath start $ServiceName | Out-Null
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName
Write-Host "[$($svc.Status)] $ServiceName" -ForegroundColor (if ($svc.Status -eq 'Running') {'Green'} else {'Yellow'})

# 5. Smoke test.
Write-Section "Smoke test"
Start-Sleep -Seconds 5
try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/health' -TimeoutSec 5
    Write-Host "[OK] /health responding: status=$($resp.status) uptime=$($resp.uptime)s devices=$($resp.deviceCount)" -ForegroundColor Green
} catch {
    Write-Host "[WARN] /health not responding yet: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "       Check $LogDir\adbpd.stderr.log"
}

# 6. Reboot verification instructions.
Write-Section "After your next reboot — verify the service starts BEFORE Studio:"
Write-Host @"
  1. Reboot Windows.
  2. As soon as login screen appears (do NOT open Android Studio yet):
       - Open PowerShell.
       - Run:
           Get-Service ADBPD                                       # should be Running
           Invoke-RestMethod http://127.0.0.1:3002/health           # should return status=ok
           adb -P 5037 devices                                     # should list devices
  3. Only after all three pass, open Android Studio.
  4. If anything fails, capture $LogDir\adbpd.stderr.log.

  To uninstall:  powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
"@ -ForegroundColor Cyan
