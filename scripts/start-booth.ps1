# Requires -Version 5.1
<#
    start-booth.ps1
    One-key launcher for the demo2 booth machine:
      1) Calls start-demo.ps1 -NoBrowser to spin up the gateway
      2) Waits for :18790 to bind
      3) Launches Firefox in kiosk mode (-K), pointed at the dashboard URL

    Why Firefox-kiosk:
      - Firefox is the only browser where getUserMedia works on the demo2
        dashboard (Chromium blocks via Permissions-Policy from the gateway).
      - --kiosk hides URL bar / tabs / menus so booth visitors can't click
        away from the demo accidentally.

    Exit kiosk on the Surface: Alt+F4 (closes the Firefox window).
    Stop everything:           .\scripts\stop-demo.ps1

    Usage:
        .\scripts\start-booth.ps1
        .\scripts\start-booth.ps1 -Mock          # synthetic data, no ESP32
        .\scripts\start-booth.ps1 -ForceHeat     # mock-only: instantly trip
                                                 #   heat_sustained
#>

param(
    [switch]$Mock,
    [switch]$ForceHeat,
    [switch]$Dev       # windowed Firefox (URL bar + taskbar) instead of kiosk
)
$ErrorActionPreference = "Stop"

# Single source of truth for ports / profile / models — edit demo.config.ps1.
. "$PSScriptRoot\..\demo.config.ps1"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "!! $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "XX $msg" -ForegroundColor Red; exit 1 }

# -- Pre-flight: locate Firefox -------------------------------------------

Step "Locating Firefox"
$firefoxCandidates = @(
    "$env:ProgramFiles\Mozilla Firefox\firefox.exe",
    "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe",
    "$env:LOCALAPPDATA\Mozilla Firefox\firefox.exe",
    "$env:ProgramFiles\Mozilla\Firefox\firefox.exe"
)
$firefox = $null
foreach ($p in $firefoxCandidates) {
    if (Test-Path $p) { $firefox = $p; break }
}
if (-not $firefox) {
    Fail @"
Firefox not found at any of:
$($firefoxCandidates -join "`n  ")
Install Firefox (winget install Mozilla.Firefox) and re-run.
"@
}
Write-Host "    using $firefox"

# -- Start gateway (idempotent — skip if already up) ----------------------

$already = Get-NetTCPConnection -LocalPort $DEMO2_GATEWAY_PORT -State Listen -ErrorAction SilentlyContinue
if ($already) {
    Step "Gateway already LISTEN-ing (pid $($already.OwningProcess)) — skipping start"
} else {
    Step "Starting gateway (delegating to start-demo.ps1 -NoBrowser)"
    # NB: $args is a PowerShell automatic variable. Use a hashtable splat
    # with explicit param names so the [switch] params bind unambiguously
    # (positional binding of -NoBrowser was getting eaten by [string]$UsbPort).
    $startArgs = @{ NoBrowser = $true }
    if ($Mock)      { $startArgs.Mock = $true }
    if ($ForceHeat) { $startArgs.ForceHeat = $true }
    & "$PSScriptRoot\start-demo.ps1" @startArgs

    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        $c = Get-NetTCPConnection -LocalPort $DEMO2_GATEWAY_PORT -State Listen -ErrorAction SilentlyContinue
        if ($c) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { Fail "Gateway not LISTEN-ing on :$DEMO2_GATEWAY_PORT after start-demo.ps1 returned." }
}

# -- Start HTTPS reverse proxy (idempotent — skip if already up) ----------
# Mobile Firefox needs HTTPS for getUserMedia on a LAN IP. The proxy listens
# on :18443 and transparently forwards to the gateway on :18790.

$repo = Resolve-Path "$PSScriptRoot\.."
$proxyDir = Join-Path $repo "tools\https-proxy"
$proxyAlready = Get-NetTCPConnection -LocalPort $DEMO2_HTTPS_PORT -State Listen -ErrorAction SilentlyContinue
if ($proxyAlready) {
    Step "HTTPS proxy already LISTEN-ing (pid $($proxyAlready.OwningProcess)) — skipping start"
} elseif (Test-Path $proxyDir) {
    Step "Starting HTTPS proxy :$DEMO2_HTTPS_PORT -> :$DEMO2_GATEWAY_PORT"
    if (-not (Test-Path (Join-Path $proxyDir "node_modules"))) {
        Push-Location $proxyDir
        Write-Host "    npm install (first run only)..."
        npm install --silent 2>&1 | Out-Null
        Pop-Location
    }
    # proxy.mjs reads DEMO2_HTTPS_PORT + DEMO2_UPSTREAM from env — feed them
    # from demo.config.ps1 so the proxy follows the same single source of truth.
    $proxyCmd = "Set-Location '$proxyDir'; " +
                "`$env:DEMO2_HTTPS_PORT='$DEMO2_HTTPS_PORT'; " +
                "`$env:DEMO2_UPSTREAM='$DEMO2_GATEWAY_URL'; " +
                "Write-Host 'demo2 https-proxy - Ctrl+C to stop.' -ForegroundColor Cyan; " +
                "node proxy.mjs"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $proxyCmd | Out-Null

    $proxyReady = $false
    for ($i = 0; $i -lt 20; $i++) {
        $c = Get-NetTCPConnection -LocalPort $DEMO2_HTTPS_PORT -State Listen -ErrorAction SilentlyContinue
        if ($c) { $proxyReady = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $proxyReady) {
        Warn "HTTPS proxy didn't bind :18443 in 10s — booth dashboard still works on Surface, but mobile webcam SCAN will fail with 'insecure context'."
    } else {
        Write-Host "    https proxy ready"
    }
} else {
    Warn "tools\https-proxy missing — phones won't get HTTPS QR URL"
}

# -- Build dashboard URL --------------------------------------------------

$envPath = Resolve-Path "$PSScriptRoot\..\.env.local"
$token = (Get-Content $envPath | Where-Object { $_ -match "^OPENCLAW_GATEWAY_TOKEN=" }) `
    -replace "^OPENCLAW_GATEWAY_TOKEN=",""
if (-not $token) { Fail "OPENCLAW_GATEWAY_TOKEN missing in $envPath" }

# Surface itself uses 127.0.0.1 — Firefox grants webcam/mic on localhost
# without an HTTPS cert. Phones scan the QR on the dashboard for the LAN URL.
$url = "$DEMO2_GATEWAY_URL/?token=$token"

# -- Pre-warm Ollama VLM (background) -------------------------------------
# qwen2.5vl:3b weighs ~10GB resident. First call after boot or after the
# Ollama idle eviction takes 30-60s — booth-killing latency. Pre-warm now
# so the first SCAN is already warm. Per-call `keep_alive: "10m"` in
# vision.ts keeps it alive across visitor gaps.
$visionModel = $DEMO2_VISION_MODEL
Step "Pre-warming $visionModel (background, won't block kiosk launch)"
$warmCmd = @"
try {
    `$body = '{`"model`":`"$visionModel`",`"prompt`":`" `",`"stream`":false,`"keep_alive`":`"10m`",`"options`":{`"num_predict`":1}}'
    `$null = Invoke-RestMethod -Uri '$DEMO2_OLLAMA_URL/api/generate' -Method Post -Body `$body -ContentType 'application/json' -TimeoutSec 180
    Write-Host '[ollama-warmup] $visionModel pre-warmed and pinned for 10m' -ForegroundColor Green
} catch {
    Write-Host ('[ollama-warmup] failed: ' + `$_.Exception.Message) -ForegroundColor Yellow
}
"@
Start-Process powershell -ArgumentList "-WindowStyle","Hidden","-Command",$warmCmd | Out-Null

# -- Launch Firefox --------------------------------------------------------

if ($Dev) {
    Step "Launching Firefox (windowed — dev mode)"
    Write-Host "    $firefox --new-window $url"
    Start-Process -FilePath $firefox -ArgumentList "--new-window", $url | Out-Null
} else {
    Step "Launching Firefox kiosk"
    Write-Host "    $firefox --kiosk $url"
    Start-Process -FilePath $firefox -ArgumentList "--kiosk", $url | Out-Null
}

Write-Host ""
Write-Host "============================================================"
Write-Host "  demo2 booth running"
Write-Host "============================================================"
Write-Host "  Dashboard (this PC) : $url"
Write-Host "  LAN URL (phones)    : visible as QR on dashboard"
Write-Host ""
Write-Host "  Exit kiosk Firefox  : Alt+F4   (focus the Firefox window)"
Write-Host "  Stop everything     : .\scripts\stop-demo.ps1"
Write-Host "============================================================"
