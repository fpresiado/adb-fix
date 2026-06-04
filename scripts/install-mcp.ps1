# install-mcp.ps1 — copy Bridge .mcp.json templates into target project roots.
# Idempotent: skips when destination already matches source byte-for-byte.
# Backs up any existing non-matching .mcp.json to .mcp.json.bak before overwrite.

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$BridgeRoot = Split-Path -Parent $PSScriptRoot
$TemplatesDir = Join-Path $BridgeRoot 'templates'

# Source -> Destination map. Add a new entry when onboarding a new Bridge-aware
# project; keep keys aligned with templates/*.mcp.json file names.
$Targets = @(
    @{
        Name   = 'AegisRx'
        Source = Join-Path $TemplatesDir 'aegisrx.mcp.json'
        Dest   = 'P:\futureapps\AegisRx\kage_src\.mcp.json'
    },
    @{
        Name   = 'ADBPD'
        Source = Join-Path $TemplatesDir 'adbpd.mcp.json'
        Dest   = 'M:\FutureApps\adb-proxy-daemon\.mcp.json'
    }
)

function Get-FileHashOrNull([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

$installed = 0
$skipped = 0
$missing = 0

foreach ($t in $Targets) {
    Write-Host ""
    Write-Host "[$($t.Name)] $($t.Dest)"

    if (-not (Test-Path -LiteralPath $t.Source -PathType Leaf)) {
        Write-Warning "  source template missing: $($t.Source) — skipping"
        $missing++
        continue
    }

    $destDir = Split-Path -Parent $t.Dest
    if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
        Write-Warning "  target project dir not found: $destDir — skipping"
        $missing++
        continue
    }

    $srcHash = Get-FileHashOrNull $t.Source
    $dstHash = Get-FileHashOrNull $t.Dest

    if ($null -ne $dstHash -and $srcHash -eq $dstHash) {
        Write-Host "  already up-to-date — skipping"
        $skipped++
        continue
    }

    if ($null -ne $dstHash) {
        $backup = "$($t.Dest).bak"
        if ($DryRun) {
            Write-Host "  DRY-RUN: would back up existing .mcp.json -> $backup"
        } else {
            Copy-Item -LiteralPath $t.Dest -Destination $backup -Force
            Write-Host "  backed up existing .mcp.json -> $backup"
        }
    }

    if ($DryRun) {
        Write-Host "  DRY-RUN: would copy $($t.Source) -> $($t.Dest)"
    } else {
        Copy-Item -LiteralPath $t.Source -Destination $t.Dest -Force
        Write-Host "  installed"
    }
    $installed++
}

Write-Host ""
Write-Host "Summary: installed=$installed skipped=$skipped missing/unavailable=$missing"
