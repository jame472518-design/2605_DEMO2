# Requires -Version 5.1
<#
    install-workspaces.ps1
    Idempotently registers judge-1 in ~/.openclaw-strixdemo2/openclaw.json's
    agents.list[]. judge-1 is demo2's sole agent — invoked per-event by the
    sensor-bridge plugin to enrich alerts with a Chinese explanation.

    Schema: agents.list (array), NOT agents.<id> map (verified in demo1 spike).
#>

param(
    [string]$ProfileName = "strixdemo2"
)
$ErrorActionPreference = "Stop"

$repoRoot   = Resolve-Path "$PSScriptRoot\.."
$wsRoot     = Join-Path $repoRoot "openclaw-workspaces"
$profileDir = Join-Path $env:USERPROFILE ".openclaw-$ProfileName"
$configPath = Join-Path $profileDir "openclaw.json"

if (-not (Test-Path $configPath)) {
    Write-Error "Profile config not found: $configPath`nRun bootstrap-profile.ps1 first."
}

$expectedAgents = @(
    @{ id = "judge-1"  ; workspace = (Join-Path $wsRoot "judge-1")  }
    @{ id = "vision-1" ; workspace = (Join-Path $wsRoot "vision-1") }
)

# Make sure each workspace dir exists (the markdown files were authored by
# hand and committed — this script never overwrites their content).
foreach ($a in $expectedAgents) {
    New-Item -ItemType Directory -Force -Path $a.workspace | Out-Null
    Write-Host "ws  $($a.id) -> $($a.workspace)"
}

# Backup before patching.
$backup = "$configPath.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -Force $configPath $backup
Write-Host "backup -> $backup"

$cfg = Get-Content $configPath -Raw | ConvertFrom-Json

if (-not $cfg.PSObject.Properties.Match('agents').Count) {
    $cfg | Add-Member -NotePropertyName agents -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $cfg.agents.PSObject.Properties.Match('list').Count) {
    $cfg.agents | Add-Member -NotePropertyName list -NotePropertyValue @() -Force
}

$byId = [ordered]@{}
foreach ($entry in @($cfg.agents.list)) {
    if ($entry -and $entry.id) { $byId[$entry.id] = $entry }
}

foreach ($a in $expectedAgents) {
    if ($byId.Contains($a.id)) {
        $entry = $byId[$a.id]
        if ($entry.PSObject.Properties.Match('workspace').Count) {
            $entry.workspace = $a.workspace
        } else {
            $entry | Add-Member -NotePropertyName workspace -NotePropertyValue $a.workspace -Force
        }
        if (-not $entry.PSObject.Properties.Match('name').Count) {
            $entry | Add-Member -NotePropertyName name -NotePropertyValue $a.id -Force
        }
    } else {
        $byId[$a.id] = [pscustomobject]@{
            id        = $a.id
            name      = $a.id
            workspace = $a.workspace
        }
    }
}

# Preserve "main" first if it was auto-created, then our agents, then anything else.
$ordered = @()
if ($byId.Contains('main')) { $ordered += $byId['main'] }
foreach ($a in $expectedAgents) {
    if ($byId.Contains($a.id)) { $ordered += $byId[$a.id] }
}
foreach ($k in $byId.Keys) {
    if ($k -ne 'main' -and ($expectedAgents.id -notcontains $k)) {
        $ordered += $byId[$k]
    }
}
$cfg.agents.list = $ordered

$cfg | ConvertTo-Json -Depth 12 | Set-Content -Path $configPath -Encoding utf8

Write-Host ""
Write-Host "============================================================"
Write-Host "  Workspaces installed for profile: $ProfileName"
Write-Host "============================================================"
Write-Host "  Agents:    $(($expectedAgents | ForEach-Object { $_.id }) -join ', ')"
Write-Host "  Backup:    $backup"
Write-Host ""
Write-Host "  Verify:    openclaw --profile $ProfileName agents list"
Write-Host "============================================================"
