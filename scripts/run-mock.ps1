param(
    [switch]$ForceHeat,
    [switch]$NoPip
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\.."

# Pre-flight checks
$envPath = Join-Path $repo ".env.local"
if (-not (Test-Path $envPath)) {
    Write-Host ""
    Write-Host "ERROR: $envPath not found." -ForegroundColor Red
    Write-Host "       Run '.\scripts\bootstrap-profile.ps1' first." -ForegroundColor Yellow
    exit 1
}

$installRoot = Join-Path $env:USERPROFILE ".openclaw-strixdemo2\extensions\sensor-bridge"
if (-not (Test-Path $installRoot)) {
    Write-Host ""
    Write-Host "ERROR: sensor-bridge plugin not installed." -ForegroundColor Red
    Write-Host "       Run '.\scripts\install-plugins.ps1' first" -ForegroundColor Yellow
    Write-Host "       (and 'cd dashboard; pnpm run build' before that)." -ForegroundColor Yellow
    exit 1
}

# Optionally install pip deps
if (-not $NoPip) {
    Write-Host "[run-mock] verifying pip deps..." -ForegroundColor Cyan
    python -m pip install --quiet --disable-pip-version-check -r (Join-Path $repo "bridge\requirements.txt")
}

Write-Host ""
Write-Host "============================================================"
Write-Host "  demo2 mock-mode runner"
Write-Host "============================================================"
Write-Host "  !!  This terminal will run the Python bridge in MOCK mode."
Write-Host "  !!  In a SEPARATE terminal, start the OpenClaw gateway:"
Write-Host ""
Write-Host "      cd $repo"
Write-Host "      openclaw --profile strixdemo2 gateway --port 18790 --verbose"
Write-Host ""
Write-Host "  Then open the dashboard:"
Write-Host '      $token = (Get-Content "$repo\.env.local" | Where-Object { $_ -match "^OPENCLAW_GATEWAY_TOKEN=" }) -replace "^OPENCLAW_GATEWAY_TOKEN=",""'
Write-Host '      Start-Process "http://127.0.0.1:18790/?token=$token"'
Write-Host "============================================================"
Write-Host ""

$args = @("$repo\bridge\bridge.py", "--mock")
if ($ForceHeat) { $args += "--force-heat" }
python @args
