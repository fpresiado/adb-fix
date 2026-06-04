# Bridge - NSSM service installer (Phase 4C).
#
# Installs the Bridge sovereign multi-agent broker as a Windows service that
# starts automatically before any user logs in. Survives reboot, recovers from
# process crash, restarts automatically if Bun exits non-zero.
#
# Mirrors ADBPD's install-service.ps1 (M:\FutureApps\adb-proxy-daemon\scripts\
# install-service.ps1) by design - same machine, same author, same supervisor
# pattern. The one delta is the ISKO_TOKEN bootstrap: Bridge ships a per-host
# secret used by the dashboard to authenticate Isko's supervisor seat, written
# to data/isko.token with NTFS ACLs scoped to the installing user.
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
#   - Bun installed and on PATH (auto-detected via Get-Command) OR pass -BunPath.

[CmdletBinding()]
param(
    [string]$ServiceName = 'Bridge',
    [string]$NssmPath    = 'C:\Tools\nssm\nssm.exe',
    [string]$BunPath     = '',
    [string]$ProjectPath = 'Z:\FutureApps\universal_tools\tools\Bridge',
    [string]$LogDir      = 'Z:\FutureApps\universal_tools\tools\Bridge\logs',
    [string]$DataDir     = 'Z:\FutureApps\universal_tools\tools\Bridge\data'
)

$ErrorActionPreference = 'Stop'

function Write-Section($msg) {
    Write-Host ''
    Write-Host "=== $msg ===" -ForegroundColor Cyan
}

# 1. Pre-flight: elevation + binaries + paths.
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

$BrokerEntry = Join-Path $ProjectPath 'src\server\broker.ts'
if (-not (Test-Path $BrokerEntry)) {
    throw "Broker entrypoint not found at $BrokerEntry"
}
Write-Host "[OK] project at $ProjectPath"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
Write-Host "[OK] log dir at $LogDir"

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
Write-Host "[OK] data dir at $DataDir"

# 2. Generate (or reuse) the ISKO supervisor token.
#    32 bytes of cryptographic randomness, lowercase hex (64 chars). Persisted
#    to data\isko.token with an ACL that allows ONLY the installing user (and
#    SYSTEM/Administrators, which already have de-facto access on Windows).
Write-Section "Bootstrapping ISKO supervisor token"

$TokenPath = Join-Path $DataDir 'isko.token'
$IskoToken = ''

if (Test-Path $TokenPath) {
    $existing = (Get-Content $TokenPath -Raw).Trim()
    if ($existing.Length -eq 64) {
        $IskoToken = $existing
        Write-Host "[OK] reusing existing token at $TokenPath"
    } else {
        Write-Host "[..] existing token malformed (len=$($existing.Length)); regenerating" -ForegroundColor Yellow
    }
}

if ($IskoToken -eq '') {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        $IskoToken = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    } finally {
        $rng.Dispose()
    }
    # Write with no trailing newline; broker reads raw.
    [System.IO.File]::WriteAllText($TokenPath, $IskoToken)
    Write-Host "[OK] generated 32-byte token at $TokenPath"
}

# Lock down ACLs on the token file: only the installing user gets read access.
# We disable inheritance and strip everything, then add a single explicit ACE
# for the current user. SYSTEM and Administrators retain access by virtue of
# OS-level privilege; we don't add them to keep the surface minimal.
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
try {
    $acl = Get-Acl $TokenPath
    $acl.SetAccessRuleProtection($true, $false)  # disable inheritance, drop inherited
    # Strip every existing access rule before re-adding ours.
    $existingRules = @($acl.Access)
    foreach ($rule in $existingRules) {
        [void]$acl.RemoveAccessRule($rule)
    }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $currentUser,
        'FullControl',
        'Allow'
    )
    $acl.AddAccessRule($rule)
    Set-Acl -Path $TokenPath -AclObject $acl
    Write-Host "[OK] ACL locked to $currentUser"
} catch {
    Write-Host "[WARN] could not tighten ACL on $TokenPath ($($_.Exception.Message))" -ForegroundColor Yellow
}

# 3. Remove any prior installation (idempotent).
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

# 4. Install service.
Write-Section "Installing $ServiceName"
& $NssmPath install $ServiceName $BunPath "run $BrokerEntry" | Out-Null
& $NssmPath set $ServiceName AppDirectory $ProjectPath | Out-Null
& $NssmPath set $ServiceName DisplayName 'Bridge Broker (Future @I LLC)' | Out-Null
& $NssmPath set $ServiceName Description 'Sovereign multi-agent chat broker on 127.0.0.1:4700 (WS) + 127.0.0.1:4701 (HTTP/dashboard). Coordinates Claude Code sessions across local projects.' | Out-Null

# Start automatically at boot so agents can register from session 1.
& $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmPath set $ServiceName Type SERVICE_WIN32_OWN_PROCESS | Out-Null

# Run as LocalSystem so Z: (mapped drive) and any service-account-only
# resources are reachable. The broker binds 127.0.0.1 only.
& $NssmPath set $ServiceName ObjectName LocalSystem | Out-Null

# AppNoConsole keeps the supervisor from popping a console window.
& $NssmPath set $ServiceName AppNoConsole 1 | Out-Null

# Environment: token + canonical ports/paths consumed by config/bridge.config.ts.
$envBlock = @(
    "BRIDGE_ISKO_TOKEN=$IskoToken"
    "BRIDGE_PROJECT_PATH=$ProjectPath"
    "BRIDGE_DATA_DIR=$DataDir"
    "BRIDGE_LOG_DIR=$LogDir"
) -join "`r`n"
& $NssmPath set $ServiceName AppEnvironmentExtra $envBlock | Out-Null

# Logging.
& $NssmPath set $ServiceName AppStdout "$LogDir\broker.stdout.log" | Out-Null
& $NssmPath set $ServiceName AppStderr "$LogDir\broker.stderr.log" | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 52428800 | Out-Null

# Crash recovery - restart on non-zero exit, with backoff.
& $NssmPath set $ServiceName AppExit Default Restart | Out-Null
& $NssmPath set $ServiceName AppRestartDelay 5000 | Out-Null
& $NssmPath set $ServiceName AppThrottle 10000 | Out-Null

# Graceful shutdown - give 30s for SIGTERM cleanup so connected agents drain.
& $NssmPath set $ServiceName AppStopMethodConsole 30000 | Out-Null
& $NssmPath set $ServiceName AppStopMethodWindow 5000 | Out-Null
& $NssmPath set $ServiceName AppStopMethodThreads 5000 | Out-Null

Write-Host "[OK] service installed"

# 5. Start it.
Write-Section "Starting $ServiceName"
& $NssmPath start $ServiceName | Out-Null
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName
$svcColor = 'Yellow'
if ($svc.Status -eq 'Running') { $svcColor = 'Green' }
Write-Host "[$($svc.Status)] $ServiceName" -ForegroundColor $svcColor

# 6. Smoke test.
Write-Section "Smoke test"
Start-Sleep -Seconds 5
try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:4701/health' -TimeoutSec 5
    Write-Host "[OK] /health responding: status=$($resp.status) uptime=$($resp.uptime)s connectedAgents=$($resp.connectedAgents) version=$($resp.version)" -ForegroundColor Green
} catch {
    Write-Host "[WARN] /health not responding yet: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "       Check $LogDir\broker.stderr.log"
}

# 7. Post-install hints.
Write-Section "Install complete"
Write-Host "  Service:     $ServiceName" -ForegroundColor Cyan
Write-Host "  Location:    $ProjectPath" -ForegroundColor Cyan
Write-Host "  Token file:  $TokenPath" -ForegroundColor Cyan
Write-Host "  Logs:        $LogDir\broker.stdout.log / broker.stderr.log" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Copy the ISKO token into the dashboard supervisor field:" -ForegroundColor Cyan
Write-Host "    Get-Content '$TokenPath'" -ForegroundColor White
Write-Host ""
Write-Host "  Open the dashboard:" -ForegroundColor Cyan
Write-Host "    Start-Process http://127.0.0.1:4701/dashboard" -ForegroundColor White
Write-Host ""
Write-Host "  To uninstall: powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1" -ForegroundColor Cyan
Write-Host "  To recover from a wedged broker: powershell -ExecutionPolicy Bypass -File scripts\reset-bridge.ps1" -ForegroundColor Cyan
