# Requires -Version 5.1
<#
    start-demo.ps1
    One-shot launcher for the demo2 sensor station. Starts the OpenClaw
    gateway in its own PowerShell window, the Python bridge in another,
    and opens the browser with the gateway token in the URL.

    Each service runs in a separate VISIBLE PowerShell window so the
    booth operator can glance at logs (especially the gateway's
    "judge enriched" lines) and stop with Ctrl+C cleanly.

    Usage:
        # Mock data (no Arduino needed):
        .\scripts\start-demo.ps1
        .\scripts\start-demo.ps1 -ForceHeat        # mock + 5s in, 70s of 32°C
        .\scripts\start-demo.ps1 -NoBridge         # gateway only, drive frames manually

        # Real Arduino on COM3:
        .\scripts\start-demo.ps1 -Port COM3

        # Skip auto-opening the browser:
        .\scripts\start-demo.ps1 -NoBrowser

    Stop with .\scripts\stop-demo.ps1 (or close each window manually).
#>

param(
    [string]$Port,           # serial port for real Arduino mode; if unset, uses mock
    [switch]$ForceHeat,      # mock-only: hold 32°C for 70s starting 5s after launch
    [switch]$NoBridge,       # don't start the Python bridge
    [switch]$NoBrowser,      # don't auto-open the dashboard
    [switch]$Edge            # use Edge --app instead of default browser
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..").Path

function Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Warn($msg) { Write-Host "!! $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "XX $msg" -ForegroundColor Red; exit 1 }

# -- Pre-flight ------------------------------------------------------------

Step "Pre-flight checks"

$envPath = Join-Path $repo ".env.local"
if (-not (Test-Path $envPath)) {
    Fail ".env.local not found at $envPath. Run scripts\bootstrap-profile.ps1 first."
}

$profileDir = Join-Path $env:USERPROFILE ".openclaw-strixdemo2"
$pluginDist = Join-Path $profileDir "extensions\sensor-bridge\dist\index.js"
if (-not (Test-Path $pluginDist)) {
    Fail "sensor-bridge plugin not installed. Run scripts\install-plugins.ps1 first."
}

$staticIndex = Join-Path $profileDir "extensions\sensor-bridge\static\index.html"
if (-not (Test-Path $staticIndex)) {
    Fail "Dashboard SPA bundle missing. Run 'cd dashboard; pnpm run build' then scripts\install-plugins.ps1"
}

$port18790 = Get-NetTCPConnection -LocalPort 18790 -ErrorAction SilentlyContinue
if ($port18790) {
    Fail "Port 18790 already in use (pid $($port18790.OwningProcess)). Run scripts\stop-demo.ps1 first."
}

if (-not $NoBridge) {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) {
        Warn "python not on PATH — bridge can't start. Re-run with -NoBridge to drive frames manually, or install Python."
        Fail "Aborting. (Use -NoBridge to bypass.)"
    }
    $port8765 = Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue
    if ($port8765) {
        Fail "Port 8765 already in use (pid $($port8765.OwningProcess)). Stop the existing bridge first."
    }
}

# Optional checks (warn-only)
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    Warn "ollama not on PATH — judge enrichment will fail-gracefully (alerts ship without Chinese explanation)."
} else {
    $hasQwen = (ollama list 2>&1 | Select-String -Quiet "qwen2:1.5b")
    if (-not $hasQwen) {
        Warn "qwen2:1.5b not pulled. Run: ollama pull qwen2:1.5b   (alerts will ship without explanation until then)"
    }
}

# -- Read token ------------------------------------------------------------

$token = (Get-Content $envPath | Where-Object { $_ -match "^OPENCLAW_GATEWAY_TOKEN=" }) `
    -replace "^OPENCLAW_GATEWAY_TOKEN=",""
if (-not $token) { Fail "OPENCLAW_GATEWAY_TOKEN missing in $envPath" }

# -- Launch gateway --------------------------------------------------------

Step "Launching gateway in a new window"

$gatewayCmd = "Set-Location '$repo'; " +
              "Write-Host 'demo2 gateway window — Ctrl+C to stop.' -ForegroundColor Cyan; " +
              "openclaw --profile strixdemo2 gateway --port 18790 --verbose"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $gatewayCmd | Out-Null

# Poll until gateway responds
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:18790/?token=$token" `
            -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # Connection refused or 401 — keep polling. 401 means up but auth failing
        # (different problem; let it surface in the gateway window). Time-bound below.
        if ($_.Exception.Message -match "401") { $ready = $true; break }
    }
}
if (-not $ready) { Fail "Gateway didn't respond on :18790 within 20s. Check the gateway window for errors." }
Write-Host "    gateway ready"

# -- Launch bridge ---------------------------------------------------------

if (-not $NoBridge) {
    Step "Launching Python bridge in a new window"
    $bridgeArgs = if ($Port) { "--port $Port" } else { "--mock" }
    if ($ForceHeat) { $bridgeArgs += " --force-heat" }
    $bridgeCmd = "Set-Location '$repo'; " +
                 "Write-Host 'demo2 bridge window — Ctrl+C to stop.' -ForegroundColor Cyan; " +
                 "python bridge\bridge.py $bridgeArgs"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $bridgeCmd | Out-Null
    Write-Host "    bridge started ($bridgeArgs)"
} else {
    Write-Host "    -NoBridge: skipping Python bridge"
}

# -- Open browser ----------------------------------------------------------

$url = "http://127.0.0.1:18790/?token=$token"
if (-not $NoBrowser) {
    Step "Opening dashboard"
    if ($Edge) {
        $edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        if (Test-Path $edgePath) {
            Start-Process $edgePath -ArgumentList "--app=$url" | Out-Null
            Write-Host "    opened in Edge --app mode"
        } else {
            Warn "Edge not found at $edgePath; falling back to default browser"
            Start-Process $url | Out-Null
        }
    } else {
        Start-Process $url | Out-Null
        Write-Host "    opened in default browser"
    }
}

# -- Cheatsheet ------------------------------------------------------------

Write-Host ""
Write-Host "============================================================"
Write-Host "  demo2 running"
Write-Host "============================================================"
Write-Host "  Dashboard URL : $url"
Write-Host "  LAN URL       : http://<this-PC-LAN-IP>:18790/?token=$token"
Write-Host "                  (run 'ipconfig' to find your LAN IP)"
Write-Host ""
Write-Host "  Stop          : .\scripts\stop-demo.ps1"
Write-Host "                  (or Ctrl+C in each spawned window)"
Write-Host ""
Write-Host "  What you should see:"
Write-Host "    - 5 sensor cards filling with values + sparklines (1Hz)"
if ($ForceHeat) {
    Write-Host "    - heat_sustained alert ~70s in (forced via --force-heat)"
}
Write-Host "    - night_intrusion alert when mock PIR fires + lux is low"
Write-Host "    - judge-1 (qwen2:1.5b) enriches each alert with Chinese in ~2-5s"
Write-Host "============================================================"
