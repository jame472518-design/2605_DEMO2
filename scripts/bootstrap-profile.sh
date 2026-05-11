#!/bin/bash
# bootstrap-profile.sh — Linux equivalent of bootstrap-profile.ps1
#
# Creates ~/.openclaw-strixdemo2/openclaw.json with gateway token, judge agent
# model binding, and minimal tools.allow. Writes the token to ../.env.local
# for downstream scripts/dashboard to read.
set -euo pipefail

PROFILE="${PROFILE:-strixdemo2}"
PROFILE_DIR="$HOME/.openclaw-$PROFILE"
CONFIG="$PROFILE_DIR/openclaw.json"

# JUDGE_MODEL default tracks Strix Halo plan (qwen2:1.5b). On Jetson, override
# via env to use the already-pulled qwen2.5:3b.
JUDGE_MODEL="${JUDGE_MODEL:-ollama/qwen2:1.5b}"

mkdir -p "$PROFILE_DIR"

if [ -f "$CONFIG" ]; then
    echo "Profile config already exists: $CONFIG"
    echo "Skipping bootstrap (manual edit if you want a fresh start)."
    exit 0
fi

# Generate 48-hex gateway token (matching the powershell version)
TOKEN=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')

cat > "$CONFIG" <<EOF
{
  "agents": {
    "defaults": {
      "maxConcurrent": 1,
      "model": {
        "primary": "$JUDGE_MODEL",
        "fallbacks": []
      }
    }
  },
  "approvals": { "exec": { "enabled": false } },
  "gateway": {
    "auth": { "mode": "token", "token": "$TOKEN" },
    "bind": "lan",
    "mode": "local",
    "port": 18790,
    "tailscale": { "mode": "off" }
  },
  "models": {
    "providers": {
      "ollama": {
        "api": "ollama",
        "apiKey": "ollama-local",
        "baseUrl": "http://127.0.0.1:11434",
        "models": [
          {
            "id": "qwen2:1.5b",
            "name": "qwen2:1.5b",
            "contextWindow": 32768,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "reasoning": false
          },
          {
            "id": "qwen2.5:3b",
            "name": "qwen2.5:3b",
            "contextWindow": 32768,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "reasoning": false
          }
        ]
      }
    }
  },
  "plugins": {
    "allow": ["sensor-bridge"],
    "bundledDiscovery": "compat",
    "entries": {
      "sensor-bridge": { "enabled": true }
    }
  },
  "tools": {
    "allow": [
      "message", "memory_search", "memory_get",
      "sessions_list", "sessions_send", "session_status",
      "gateway", "agents_list"
    ],
    "deny": ["exec", "process", "nodes", "canvas", "llm_task", "lobster", "image"],
    "web": { "fetch": { "enabled": false }, "search": { "enabled": false } }
  }
}
EOF

# Write token to repo .env.local for dashboard / ESP32 firmware to consume
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_PATH="$REPO_ROOT/.env.local"

if [ -f "$ENV_PATH" ] && grep -q "^OPENCLAW_GATEWAY_TOKEN=" "$ENV_PATH"; then
    echo ""
    echo "ERROR: $ENV_PATH already has OPENCLAW_GATEWAY_TOKEN line."
    echo "       Delete it (or the file) and re-run, or sync manually from $CONFIG."
    exit 2
fi
echo "OPENCLAW_GATEWAY_TOKEN=$TOKEN" >> "$ENV_PATH"

cat <<INFO

============================================================
  $PROFILE profile bootstrapped
============================================================
  Gateway token : $TOKEN
  Config        : $CONFIG
  Env file      : $ENV_PATH
  Judge model   : $JUDGE_MODEL

  Next: openclaw --profile $PROFILE doctor
============================================================
INFO
