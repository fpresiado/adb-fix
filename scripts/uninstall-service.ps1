# Bridge - NSSM service uninstaller.
# Stops the Bridge service and removes it from the SCM. Run from elevated PS.

[CmdletBinding()]
param(
    [string]$ServiceName = 'Bridge',
    [string]$NssmPath    = 'C:\Tools\nssm\nssm.exe'
)

$ErrorActionPreference = 'Stop'

$IsAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    throw "Must be run from an elevated PowerShell prompt."
}

if (-not (Test-Path $NssmPath)) {
    throw "NSSM not found at $NssmPath. Pass -NssmPath if installed elsewhere."
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $svc) {
    Write-Host "Service $ServiceName not installed; nothing to do." -ForegroundColor Yellow
    return
}

if ($svc.Status -eq 'Running') {
    Write-Host "Stopping $ServiceName..."
    & $NssmPath stop $ServiceName | Out-Null
    Start-Sleep -Seconds 3
}

Write-Host "Removing $ServiceName..."
& $NssmPath remove $ServiceName confirm | Out-Null
Write-Host "Done. (data\isko.token left in place; delete manually if rotating.)" -ForegroundColor Green
