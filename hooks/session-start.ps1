# session-start.ps1: Claude Code SessionStart hook.
# Fetches Bridge conversation summary and emits it wrapped in <bridge-history> tags.
# Claude Code captures stdout and injects it as additionalContext for the new session.
#
# Per Blueprint 2 §1: this is one of the only hook points where additionalContext
# injection actually works. Mid-turn injection is impossible by design.
#
# Fail-open: any failure (broker down, network error, missing bun) is a silent
# no-op. We must never break a Claude Code session start because Bridge is sick.

$ErrorActionPreference = "Stop"

try {
    $bridgeRoot = "Z:\FutureApps\universal_tools\tools\Bridge"
    $fetchScript = Join-Path $bridgeRoot "scripts\hook-fetch-summary.ts"

    if (-not (Test-Path $fetchScript)) {
        exit 0
    }

    # Resolve bun. Prefer explicit override (BRIDGE_BUN), then PATH lookup.
    # Silent no-op if bun is not reachable.
    $bunPath = $null
    if (-not [string]::IsNullOrWhiteSpace($env:BRIDGE_BUN)) {
        if (Test-Path $env:BRIDGE_BUN) { $bunPath = $env:BRIDGE_BUN }
    }
    if ($null -eq $bunPath) {
        $bun = Get-Command bun -ErrorAction SilentlyContinue
        if ($null -ne $bun) { $bunPath = $bun.Source }
    }
    if ($null -eq $bunPath) {
        exit 0
    }

    # Capture summary. 5s wall-clock cap — bun has its own 2s fetch timeout
    # inside the script, so this is just a belt-and-braces guard.
    # Native command stderr can trip $ErrorActionPreference=Stop in PS 5.1.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $summary = & $bunPath run $fetchScript 2>$null
    $fetchExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($fetchExit -ne 0) {
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($summary)) {
        exit 0
    }

    Write-Output "<bridge-history>"
    Write-Output $summary
    Write-Output "</bridge-history>"
    exit 0
}
catch {
    # Silent fail — Bridge unavailability is never fatal to a session start.
    exit 0
}
