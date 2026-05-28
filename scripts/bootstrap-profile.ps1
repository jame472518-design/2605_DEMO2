# Requires -Version 5.1
<#
    bootstrap-profile.ps1
    Initializes the OpenClaw "strixdemo2" profile config (~/.openclaw-strixdemo2/openclaw.json)
    for the demo2 sensor station. Single plugin (sensor-bridge), single small model (qwen2:1.5b)
    that's only invoked by judge-1 on threshold breach — never in the live sensor loop.

    Universal Rule: every openclaw invocation in demo2 MUST use --profile strixdemo2
    so it doesn't pollute the user's personal ~/.openclaw/.

    Schema notes (mirroring demo1's lessons learned 2026-05-08):
      - gateway.bind = "lan" — schema only accepts bind modes (auto|lan|loopback|custom|tailnet).
      - plugin.entries.<id>.* extra keys may be rejected by the core config validator
        depending on whether plugin manifests are merged before validation. Keep entries
        minimal here; per-plugin config goes in the plugin's own manifest.
#>

# Single source of truth for ports / profile / models. Edit demo.config.ps1
# when migrating machines or swapping models.
. "$PSScriptRoot\..\demo.config.ps1"

$profileDir = $DEMO2_PROFILE_DIR
$configPath = Join-Path $profileDir "openclaw.json"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

if (Test-Path $configPath) {
    Write-Host "Profile config already exists: $configPath"
    Write-Host "Skipping bootstrap (manual edit if you need a fresh start)."
    exit 0
}

$gatewayToken = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Min 0 -Max 16) })

$config = @{
    agents = @{
        defaults = @{
            maxConcurrent = 1
            model = @{
                primary = "ollama/$DEMO2_JUDGE_MODEL"
                fallbacks = @()
            }
        }
    }
    approvals = @{ exec = @{ enabled = $false } }
    gateway = @{
        auth = @{ mode = "token"; token = $gatewayToken }
        bind = "lan"
        mode = "local"
        port = $DEMO2_GATEWAY_PORT
        tailscale = @{ mode = "off" }
    }
    models = @{
        providers = @{
            ollama = @{
                api = "ollama"
                apiKey = "ollama-local"
                baseUrl = $DEMO2_OLLAMA_URL
                models = @(
                    @{
                        id = $DEMO2_JUDGE_MODEL
                        name = $DEMO2_JUDGE_MODEL
                        contextWindow = 32768
                        input = @("text")
                        cost = @{ input = 0; output = 0; cacheRead = 0; cacheWrite = 0 }
                        reasoning = $false
                    }
                )
            }
        }
    }
    plugins = @{
        allow = @("sensor-bridge")
        entries = @{
            "sensor-bridge" = @{ enabled = $true }
        }
    }
    tools = @{
        allow = @(
            "message",
            "memory_search", "memory_get",
            "sessions_list", "sessions_send", "session_status",
            "gateway", "agents_list"
        )
        deny = @("exec", "process", "nodes", "canvas", "llm_task", "lobster", "image")
        web = @{ fetch = @{ enabled = $false }; search = @{ enabled = $false } }
    }
}

$config | ConvertTo-Json -Depth 10 | Set-Content -Path $configPath -Encoding utf8
Write-Host "Wrote profile config: $configPath"

# Persist the gateway token to <repo>/.env.local so dashboard / scripts can read it.
$envPath = (Resolve-Path "$PSScriptRoot\..").Path + "\.env.local"
$envLine = "OPENCLAW_GATEWAY_TOKEN=$gatewayToken"

if (Test-Path $envPath) {
    $existing = Get-Content -Path $envPath -Raw -ErrorAction SilentlyContinue
    if ($existing -match '(?m)^\s*OPENCLAW_GATEWAY_TOKEN\s*=') {
        Write-Host ""
        Write-Host "ERROR: $envPath already contains an OPENCLAW_GATEWAY_TOKEN line."
        Write-Host "       Refusing to overwrite. Delete that line (or the whole file) and re-run."
        exit 2
    }
    $needsNewline = $existing -and -not $existing.EndsWith("`n")
    if ($needsNewline) { Add-Content -Path $envPath -Value "" -Encoding utf8 }
    Add-Content -Path $envPath -Value $envLine -Encoding utf8
    Write-Host "Appended OPENCLAW_GATEWAY_TOKEN to: $envPath"
} else {
    Set-Content -Path $envPath -Value $envLine -Encoding utf8
    Write-Host "Created env file with OPENCLAW_GATEWAY_TOKEN: $envPath"
}

Write-Host ""
Write-Host "============================================================"
Write-Host "  strixdemo2 profile bootstrapped"
Write-Host "============================================================"
Write-Host "  Gateway token : $gatewayToken"
Write-Host "  Config path   : $configPath"
Write-Host "  Env file path : $envPath"
Write-Host ""
Write-Host "  Next: openclaw --profile $DEMO2_PROFILE doctor"
Write-Host "============================================================"
