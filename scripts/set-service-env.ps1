# ADBPD — set service env vars + restart. Run elevated.
param([string]$NssmPath = 'C:\Tools\nssm\nssm.exe')
$ErrorActionPreference = 'Continue'
Start-Transcript -Path 'M:\FutureApps\adb-proxy-daemon\nssm-set.transcript.log' -Force | Out-Null

# Literal multi-line env block. NSSM AppEnvironmentExtra expects CRLF
# separators, which a here-string with normal newlines produces on Windows.
$envBlock = @"
ADBPD_ADB_PATH=C:\Android\platform-tools\adb.exe
ADBPD_EMULATOR_BIN=C:\Users\plusu\AppData\Local\Android\Sdk\emulator\emulator.exe
ADBPD_DB_PATH=M:\FutureApps\adb-proxy-daemon\adbpd.sqlite
ADBPD_MANAGED_AVDS=Pixel_9_Pro@5554
"@

& $NssmPath set ADBPD AppEnvironmentExtra $envBlock
Write-Output ''
Write-Output '--- AppEnvironmentExtra readback ---'
& $NssmPath get ADBPD AppEnvironmentExtra
Write-Output ''
Write-Output '--- restarting service ---'
& $NssmPath restart ADBPD
Start-Sleep -Seconds 3
& $NssmPath status ADBPD
Stop-Transcript | Out-Null
