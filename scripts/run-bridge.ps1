param(
    [string]$Port,
    [switch]$NoPip
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\.."

if (-not (Test-Path (Join-Path $repo ".env.local"))) {
    Write-Host "ERROR: .env.local not found. Run '.\scripts\bootstrap-profile.ps1' first." -ForegroundColor Red
    exit 1
}

if (-not $NoPip) {
    python -m pip install --quiet --disable-pip-version-check -r (Join-Path $repo "bridge\requirements.txt")
}

$args = @("$repo\bridge\bridge.py")
if ($Port) { $args += "--port", $Port }
python @args
