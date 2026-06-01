# ADBPD — NSSM service uninstaller.
# Run from an elevated PowerShell prompt.

[CmdletBinding()]
param(
    [string]$ServiceName = 'ADBPD',
    [string]$NssmPath    = 'C:\Tools\nssm\nssm.exe'
)

$ErrorActionPreference = 'Stop'

$IsAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    throw "Must be run from an elevated PowerShell prompt."
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
Write-Host "Done." -ForegroundColor Green
