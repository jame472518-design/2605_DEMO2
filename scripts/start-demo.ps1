# Requires -Version 5.1
<#
    start-demo.ps1
    One-shot launcher for the demo2 sensor station.

    Default mode (ESP32-S3-CAM, post-W3): just starts the gateway + opens
    the browser. The ESP32 firmware (see arduino/esp32_sensor_node) connects
    to WiFi independently and POSTs frames to the plugin - no Python bridge.

    Mock mode (-Mock): spawns mock_serial.py via the Python bridge so you
    can demo without hardware. Pass -ForceHeat to instantly trigger the
    heat_sustained rule (handy for the booth).

    Each spawned service runs in a separate visible PowerShell window so
    the operator can glance at logs (especially "judge enriched" lines)
    and stop with Ctrl+C cleanly.

    Usage:
        # Production (ESP32 already running on LAN):
        .\scripts\start-demo.ps1

        # No hardware - synthetic data via Python:
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
    [switch]$ForceHeat,      # mock-only: hold 32+ deg C for 70s starting 5s after launch
    [switch]$NoBrowser,      # don't auto-open the dashboard
    [switch]$Edge            # use Edge --app instead of default browser
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..").Path

# Single source of truth for ports / profile / models - edit demo.config.ps1.
. "$PSScriptRoot\..\demo.config.ps1"

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

$profileDir = $DEMO2_PROFILE_DIR
$pluginDist = Join-Path $profileDir "extensions\sensor-bridge\dist\index.js"
if (-not (Test-Path $pluginDist)) {
    Fail "sensor-bridge plugin not installed. Run scripts\install-plugins.ps1 first."
}

$staticIndex = Join-Path $profileDir "extensions\sensor-bridge\static\index.html"
if (-not (Test-Path $staticIndex)) {
    Fail "Dashboard SPA bundle missing. Run 'cd dashboard; pnpm run build' then scripts\install-plugins.ps1"
}

# Filter by State=Listen - TIME_WAIT / ESTABLISHED entries from old client
# connections have OwningProcess=0 and don't block re-binding the port. Only
# a real LISTENing process is a problem.
$portGw = Get-NetTCPConnection -LocalPort $DEMO2_GATEWAY_PORT -State Listen -ErrorAction SilentlyContinue
if ($portGw) {
    $pidGw = ($portGw | Select-Object -First 1).OwningProcess
    Fail "Port $DEMO2_GATEWAY_PORT already in use (pid $pidGw). Run scripts\stop-demo.ps1 first."
}

if ($useBridge) {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) {
        Fail "python not on PATH. Install Python or run without -Mock/-UsbPort (ESP32 mode)."
    }
    $portBridge = Get-NetTCPConnection -LocalPort $DEMO2_BRIDGE_PORT -State Listen -ErrorAction SilentlyContinue
    if ($portBridge) {
        $pidBridge = ($portBridge | Select-Object -First 1).OwningProcess
        Fail "Port $DEMO2_BRIDGE_PORT already in use (pid $pidBridge). Run scripts\stop-demo.ps1 first."
    }
}

# Optional checks (warn-only)
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    Warn "ollama not on PATH - judge enrichment unavailable; alerts ship without Chinese explanation."
} else {
    $hasJudge = (ollama list 2>&1 | Select-String -Quiet ([regex]::Escape($DEMO2_JUDGE_MODEL)))
    if (-not $hasJudge) {
        Warn "$DEMO2_JUDGE_MODEL not pulled. Run: ollama pull $DEMO2_JUDGE_MODEL   (alerts ship without explanation until then)"
    }
}

# -- Read token ------------------------------------------------------------

$token = (Get-Content $envPath | Where-Object { $_ -match "^OPENCLAW_GATEWAY_TOKEN=" }) `
    -replace "^OPENCLAW_GATEWAY_TOKEN=",""
if (-not $token) { Fail "OPENCLAW_GATEWAY_TOKEN missing in $envPath" }

# -- Launch gateway --------------------------------------------------------

Step "Launching gateway in a new window"

# Export the plugin's runtime knobs into THIS process's environment so the
# gateway (launched below via Start-Process, which inherits our env) and in
# turn the sensor-bridge plugin pick up the model / Ollama choices from
# demo.config.ps1. Without this the plugin silently falls back to its
# hard-coded defaults and changing models in the config would do nothing.
$env:OPENCLAW_DEMO2_OLLAMA_URL   = $DEMO2_OLLAMA_URL
$env:OPENCLAW_DEMO2_JUDGE_MODEL  = $DEMO2_JUDGE_MODEL
$env:OPENCLAW_DEMO2_VISION_MODEL = $DEMO2_VISION_MODEL
$env:OPENCLAW_DEMO2_VLM_MODEL    = $DEMO2_VLM_MODEL
$env:OPENCLAW_DEMO2_BRIDGE_URL   = "http://127.0.0.1:$DEMO2_BRIDGE_PORT"

$gatewayCmd = "Set-Location '$repo'; " +
              "`$env:OPENCLAW_DEMO2_OLLAMA_URL='$DEMO2_OLLAMA_URL'; " +
              "`$env:OPENCLAW_DEMO2_JUDGE_MODEL='$DEMO2_JUDGE_MODEL'; " +
              "`$env:OPENCLAW_DEMO2_VISION_MODEL='$DEMO2_VISION_MODEL'; " +
              "`$env:OPENCLAW_DEMO2_VLM_MODEL='$DEMO2_VLM_MODEL'; " +
              "`$env:OPENCLAW_DEMO2_BRIDGE_URL='http://127.0.0.1:$DEMO2_BRIDGE_PORT'; " +
              "Write-Host 'demo2 gateway window - Ctrl+C to stop.' -ForegroundColor Cyan; " +
              "openclaw --profile $DEMO2_PROFILE gateway --port $DEMO2_GATEWAY_PORT --verbose"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $gatewayCmd | Out-Null

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest "$DEMO2_GATEWAY_URL/?token=$token" `
            -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        if ($_.Exception.Message -match "401") { $ready = $true; break }
    }
}
if (-not $ready) { Fail "Gateway didn't respond on :$DEMO2_GATEWAY_PORT within 20s. Check the gateway window for errors." }
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

$url = "$DEMO2_GATEWAY_URL/?token=$token"
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
Write-Host "  LAN URL       : http://<this-PC-LAN-IP>:$DEMO2_GATEWAY_PORT/?token=$token"
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
