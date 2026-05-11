#!/bin/bash
# start-demo.sh — Linux equivalent of start-demo.ps1
#
# Starts the OpenClaw gateway in foreground. On Jetson with qwen2.5:3b, also
# pre-warms the model (one-shot Ollama call) so the first real alert doesn't
# wait the 30+s cold-load.
#
# Usage:
#   ./scripts/start-demo.sh                  # default (ESP32 mode, no bridge)
#   ./scripts/start-demo.sh --no-prewarm     # skip model warmup
#   JUDGE_MODEL=qwen2:1.5b ./scripts/start-demo.sh
set -euo pipefail

PROFILE="${PROFILE:-strixdemo2}"
PORT="${PORT:-18790}"
JUDGE_MODEL="${OPENCLAW_DEMO2_JUDGE_MODEL:-qwen2.5:3b}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

step() { echo ""; echo "==> $1"; }
warn() { echo "!! $1" >&2; }
fail() { echo "XX $1" >&2; exit 1; }

# Activate Node 22 if via NVM
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || true
fi

# -- Pre-flight --
step "Pre-flight checks"
ENV_PATH="$REPO_ROOT/.env.local"
[ -f "$ENV_PATH" ] || fail ".env.local not found at $ENV_PATH. Run bootstrap-profile.sh first."
PROFILE_DIR="$HOME/.openclaw-$PROFILE"
[ -f "$PROFILE_DIR/extensions/sensor-bridge/dist/index.js" ] || \
    fail "sensor-bridge plugin not installed. Run install-plugins.sh first."
[ -f "$PROFILE_DIR/extensions/sensor-bridge/static/index.html" ] || \
    fail "Dashboard SPA missing. Run: cd dashboard && pnpm run build, then install-plugins.sh"

if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
    fail "Port $PORT already in use. Run stop-demo.sh first."
fi

if ! command -v openclaw >/dev/null 2>&1; then
    fail "openclaw CLI not on PATH. Install: npm install -g openclaw@latest"
fi

# Optional check: ollama + judge model
if command -v ollama >/dev/null 2>&1; then
    if ! ollama list 2>/dev/null | grep -q "^${JUDGE_MODEL%:*}"; then
        warn "Ollama model matching '$JUDGE_MODEL' not found. Alerts will ship without enrichment."
    fi
else
    warn "ollama not found. Judge enrichment disabled."
fi

# Read token
TOKEN=$(grep "^OPENCLAW_GATEWAY_TOKEN=" "$ENV_PATH" | sed 's/^OPENCLAW_GATEWAY_TOKEN=//' | tr -d '"' | tr -d "'")
[ -n "$TOKEN" ] || fail "OPENCLAW_GATEWAY_TOKEN missing in $ENV_PATH"

# -- Pre-warm model (background, fire-and-forget) --
DO_PREWARM=true
for arg in "$@"; do
    case "$arg" in
        --no-prewarm) DO_PREWARM=false ;;
    esac
done

if $DO_PREWARM && command -v ollama >/dev/null 2>&1; then
    step "Pre-warming $JUDGE_MODEL (background; gateway starts immediately)"
    (
        # Wait a moment so gateway gets logged first
        sleep 2
        curl -s -X POST http://127.0.0.1:11434/api/generate \
            -H 'Content-Type: application/json' \
            -d "{\"model\":\"$JUDGE_MODEL\",\"prompt\":\"warmup\",\"stream\":false,\"options\":{\"num_predict\":1}}" \
            >/dev/null 2>&1 \
            && echo "[prewarm] $JUDGE_MODEL loaded into RAM" \
            || echo "[prewarm] failed (model may not be installed)"
    ) &
fi

# -- Launch gateway --
step "Launching gateway on :$PORT"
echo "  URL : http://$(hostname -I | awk '{print $1}'):$PORT/?token=$TOKEN"
echo "  Stop: Ctrl+C (or stop-demo.sh from another shell)"
echo ""

# Export env vars for plugin
export OPENCLAW_DEMO2_JUDGE_MODEL="$JUDGE_MODEL"
export OPENCLAW_DEMO2_OLLAMA_URL="${OPENCLAW_DEMO2_OLLAMA_URL:-http://127.0.0.1:11434}"

exec openclaw --profile "$PROFILE" gateway --port "$PORT" --verbose
