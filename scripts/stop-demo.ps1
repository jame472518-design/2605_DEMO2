# Requires -Version 5.1
<#
    stop-demo.ps1
    Cleanly stops anything start-demo.ps1 launched. Kills the process(es)
    bound to ports 18790 (gateway) and 8765 (Python bridge /cmd server).
    Browser window is left alone — close it manually.
#>

$ErrorActionPreference = "Continue"

function StopOnPort($port, $label) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) {
        Write-Host "$label (:$port): nothing running" -ForegroundColor DarkGray
        return
    }
    foreach ($c in $conns) {
        $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "$label (:$port): stopping pid $($proc.Id) ($($proc.ProcessName))" -ForegroundColor Yellow
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            } catch {
                Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor Red
            }
        }
    }
}

# Try graceful gateway stop first (cleaner shutdown of channels/sidecars)
try {
    $null = openclaw --profile strixdemo2 gateway stop 2>&1
} catch {
    # ignore — fall through to port-kill
}
Start-Sleep -Seconds 1

StopOnPort 18790 "gateway"
StopOnPort 8765  "bridge"

Write-Host ""
Write-Host "demo2 stopped." -ForegroundColor Green
