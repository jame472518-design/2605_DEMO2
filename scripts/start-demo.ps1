# Requires -Version 5.1
<#
    start-demo.ps1
    One-shot launcher for the demo2 sensor station.

    Default mode (ESP32-S3-CAM, post-W3): just starts the gateway + opens
    the browser. The ESP32 firmware (see arduino/esp32_sensor_node) connects
    to WiFi independently and POSTs frames to the plugin — no Python bridge.

    Mock mode (-Mock): spawns mock_serial.py via the Python bridge so you
    can demo without hardware. Pass -ForceHeat to instantly trigger the
    heat_sustained rule (handy for the booth).

    Each spawned service runs in a separate visible PowerShell window so
    the operator can glance at logs (especially "judge enriched" lines)
    and stop with Ctrl+C cleanly.

    Usage:
        # Production (ESP32 already running on LAN):
        .\scripts\start-demo.ps1

        # No hardware — synthetic data via Python:
        .\scripts\start-demo.ps1 -Mock
        .\scripts\start-demo.ps1 -Mock -ForceHeat

        # USB Arduino (legacy, pre-ESP32):
        .\scripts\start-demo.ps1 -UsbPort COM3

        # Skip auto-opening the browser:
        .\scripts\start-demo.ps1 -NoBrowser

    Stop with .\scripts\stop-demo.ps1.
#>

param(
    [switch]$Mock,           # spawn Python mock bridge instead of expecting ESP32
    [string]$UsbPort,        # legacy: spawn Python bridge with USB Arduino on this COM port
    [switch]$ForceHeat,      # mock-only: hold 32+°C for 70s starting 5s after launch
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

$useBridge = $Mock -or $UsbPort

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

if ($useBridge) {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) {
        Fail "python not on PATH. Install Python or run without -Mock/-UsbPort (ESP32 mode)."
    }
    $port8765 = Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue
    if ($port8765) {
        Fail "Port 8765 already in use (pid $($port8765.OwningProcess)). Run scripts\stop-demo.ps1 first."
    }
}

# Optional checks (warn-only)
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    Warn "ollama not on PATH — judge enrichment unavailable; alerts ship without Chinese explanation."
} else {
    $hasQwen = (ollama list 2>&1 | Select-String -Quiet "qwen2:1.5b")
    if (-not $hasQwen) {
        Warn "qwen2:1.5b not pulled. Run: ollama pull qwen2:1.5b   (alerts ship without explanation until then)"
    }
}

# -- Read token ------------------------------------------------------------

$token = (Get-Content $envPath | Where-Object { $_ -match "^OPENCLAW_GATEWAY_TOKEN=" }) `
    -replace "^OPENCLAW_GATEWAY_TOKEN=",""
if (-not $token) { Fail "OPENCLAW_GATEWAY_TOKEN missing in $envPath" }

# -- Launch gateway --------------------------------------------------------

Step "Launching gateway in a new window"

$gatewayCmd = "Set-Location '$repo'; " +
              "Write-Host 'demo2 gateway window - Ctrl+C to stop.' -ForegroundColor Cyan; " +
              "openclaw --profile strixdemo2 gateway --port 18790 --verbose"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $gatewayCmd | Out-Null

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:18790/?token=$token" `
            -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        if ($_.Exception.Message -match "401") { $ready = $true; break }
    }
}
if (-not $ready) { Fail "Gateway didn't respond on :18790 within 20s. Check the gateway window for errors." }
Write-Host "    gateway ready"

# -- Launch bridge (only in mock or USB mode) ------------------------------

if ($useBridge) {
    Step "Launching Python bridge"
    $bridgeArgs = if ($UsbPort) { "--port $UsbPort" } else { "--mock" }
    if ($ForceHeat) { $bridgeArgs += " --force-heat" }
    $bridgeCmd = "Set-Location '$repo'; " +
                 "Write-Host 'demo2 bridge window - Ctrl+C to stop.' -ForegroundColor Cyan; " +
                 "python bridge\bridge.py $bridgeArgs"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $bridgeCmd | Out-Null
    Write-Host "    bridge started ($bridgeArgs)"
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
if (-not $useBridge) {
    Write-Host "  Source        : ESP32 (over WiFi)"
    Write-Host "                  Power up the ESP32; it connects to WiFi and"
    Write-Host "                  POSTs sensor frames to /api/sensor/ingest."
    Write-Host "                  Dashboard's CameraCard polls /api/device-info"
    Write-Host "                  for the ESP32's IP and embeds the MJPEG stream."
} elseif ($Mock) {
    Write-Host "  Source        : Python mock_serial (1Hz synthetic data)"
    if ($ForceHeat) {
        Write-Host "                  -ForceHeat: heat_sustained will fire ~70s in"
    }
} else {
    Write-Host "  Source        : USB Arduino on $UsbPort"
}
Write-Host ""
Write-Host "  Stop          : .\scripts\stop-demo.ps1"
Write-Host "============================================================"
