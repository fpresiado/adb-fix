# user-prompt-submit.ps1: Claude Code UserPromptSubmit hook.
# Identical mechanics to stop.ps1 — drains queued Bridge messages and emits
# them wrapped in <bridge-messages> so they're injected before the agent
# processes the human's new prompt.
#
# Fail-open on all error paths.

$ErrorActionPreference = "Stop"

try {
    $bridgeRoot = "Z:\FutureApps\universal_tools\tools\Bridge"
    $drainScript = Join-Path $bridgeRoot "scripts\hook-drain-queue.ts"

    if (-not (Test-Path $drainScript)) {
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($env:BRIDGE_AGENT_ID)) {
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
