# Bridge - one-shot recovery for a wedged broker.
#
# Mirrors ADBPD's scripts\reset-adbpd.ps1. Use when:
#   - `Get-Service Bridge` shows Running, but
#   - `Invoke-RestMethod http://127.0.0.1:4701/health` fails, OR
#   - WS port 4700 / HTTP port 4701 are bound by a stray bun.exe that the
#     NSSM supervisor lost track of.
#
# Sequence:
#   1. Elevation gate (refuse if not Administrator)
#   2. Locate the NSSM supervisor PID for the Bridge service
#   3. Stop-Service via SCM (graceful)
#   4. If NSSM is still alive after grace, force-kill (releases inherited
#      socket handles - same gotcha as ADBPD, documented in adbpd_v1_release)
#   5. Sweep any stray bun.exe holding 4700 or 4701
#   6. Verify both ports are released at the kernel level
#   7. Start-Service (SCM should auto-restart, but be explicit)
#   8. Poll /health until status=ok (default 60s)

[CmdletBinding()]
param(
    [string]$ServiceName    = 'Bridge',
    [int]$WsPort            = 4700,
    [int]$HttpPort          = 4701,
    [int]$HealthTimeoutSec  = 60
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
$svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if ($null -eq $svc) {
    Write-Err "$ServiceName service is not installed. Run install-service.ps1 first."
    exit 2
}
$nssmPid = $svc.ProcessId
Write-Ok "service installed, NSSM supervisor pid: $nssmPid (state: $($svc.State))"

# 3. Graceful stop via SCM.
Write-Step "Stopping $ServiceName via SCM"
try {
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
    Write-Ok "Stop-Service returned"
} catch {
    Write-Warn2 "Stop-Service threw: $($_.Exception.Message) - falling through to force-kill"
}
Start-Sleep -Seconds 3

# 4. Force-kill the NSSM supervisor if it survived the SCM stop.
$nssmAlive = $false
if ($nssmPid -gt 0) {
    $proc = Get-Process -Id $nssmPid -ErrorAction SilentlyContinue
    if ($null -ne $proc) {
        $nssmAlive = $true
        Write-Warn2 "NSSM pid $nssmPid still alive after Stop-Service - force-killing"
        Stop-Process -Id $nssmPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}
if (-not $nssmAlive) { Write-Ok "NSSM exited cleanly" }

# 5. Sweep stray bun.exe processes holding our ports.
foreach ($port in @($WsPort, $HttpPort)) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($null -ne $conns) {
        foreach ($c in $conns) {
            $owner = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($null -ne $owner) {
                Write-Warn2 "killing stray $($owner.ProcessName) pid=$($owner.Id) holding port $port"
                Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
Start-Sleep -Seconds 2

# 6. Verify both ports are released at the kernel level.
Write-Step "Verifying ports $WsPort and $HttpPort are released"
foreach ($port in @($WsPort, $HttpPort)) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($null -ne $listener) {
        Write-Err "Port $port still LISTENING (owning pid: $($listener.OwningProcess)). Last-resort fix: Restart-Computer."
        exit 3
    }
}
Write-Ok "ports $WsPort and $HttpPort released"

# 7. Start the service.
Write-Step "Starting $ServiceName"
try {
    Start-Service -Name $ServiceName -ErrorAction Stop
} catch {
    Write-Warn2 "Start-Service returned: $($_.Exception.Message). Trying SCM directly."
    sc.exe start $ServiceName | Out-Null
}
Start-Sleep -Seconds 3

# 8. Poll /health until status=ok or timeout.
Write-Step "Waiting for /health (up to ${HealthTimeoutSec}s)"
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/health" -TimeoutSec 3 -ErrorAction Stop
        if ($h.status -eq 'ok') {
            Write-Ok ("status=ok uptime={0}s connectedAgents={1} version={2}" -f $h.uptime, $h.connectedAgents, $h.version)
            $healthy = $true
            break
        }
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) {
    Write-Err "Broker did not respond on /health within ${HealthTimeoutSec}s. Check logs\broker.stderr.log."
    exit 4
}

Write-Step "Recovery complete"
Write-Host "Bridge broker is back. Connected agents will need to re-register." -ForegroundColor Green
