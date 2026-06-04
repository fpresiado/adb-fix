# stop.ps1: Claude Code Stop hook — fires at end of every turn.
# Drains the agent's queued Bridge messages via a transient WS connection and
# emits them wrapped in <bridge-messages> tags so Claude Code can inject them
# as additionalContext for the next turn.
#
# Per Blueprint 2 §1: Stop is one of the few hook points where additionalContext
# injection works reliably. Mid-turn delivery is impossible — messages always
# land at the boundary between turns.
#
# Fail-open: broker down = silent no-op. Hooks must NEVER break a session.

$ErrorActionPreference = "Stop"

try {
    $bridgeRoot = "Z:\FutureApps\universal_tools\tools\Bridge"
    $drainScript = Join-Path $bridgeRoot "scripts\hook-drain-queue.ts"

    if (-not (Test-Path $drainScript)) {
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($env:BRIDGE_AGENT_ID)) {
        # Hook fired in a non-Bridge project — silently skip.
        exit 0
    }
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

    # Native command stderr can trip $ErrorActionPreference=Stop in PS 5.1.
    # Capture stdout only, discard stderr, and tolerate non-zero exit.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $raw = & $bunPath run $drainScript 2>$null
    $drainExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($drainExit -ne 0) {
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        exit 0
    }

    # The drain script prints a JSON array. If it's empty ("[]"), do not inject.
    try {
        $parsed = $raw | ConvertFrom-Json
    }
    catch {
        exit 0
    }
    if ($null -eq $parsed) {
        exit 0
    }
    $count = @($parsed).Count
    if ($count -eq 0) {
        exit 0
    }

    Write-Output "<bridge-messages>"
    Write-Output $raw
    Write-Output "</bridge-messages>"
    exit 0
}
catch {
    exit 0
}
