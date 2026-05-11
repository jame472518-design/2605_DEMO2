#!/bin/bash
# stop-demo.sh — Linux equivalent of stop-demo.ps1
# Kills whatever owns port 18790 (gateway) and 8765 (Python bridge if used).
set -euo pipefail

PROFILE="${PROFILE:-strixdemo2}"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || true
fi

stop_port() {
    local port="$1" label="$2"
    local pid
    pid=$(ss -tlnp "src :$port" 2>/dev/null | awk -F'pid=' 'NR>1 {print $2}' | sed 's/,.*//' | head -1)
    if [ -z "$pid" ]; then
        # Fallback to lsof if installed
        if command -v lsof >/dev/null 2>&1; then
            pid=$(lsof -ti ":$port" 2>/dev/null | head -1)
        fi
    fi
    if [ -n "$pid" ]; then
        echo "$label (:$port): stopping pid $pid"
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
    else
        echo "$label (:$port): nothing running"
    fi
}

# Try graceful first
openclaw --profile "$PROFILE" gateway stop 2>&1 | tail -3 || true
sleep 1

stop_port 18790 "gateway"
stop_port 8765 "bridge"

echo ""
echo "demo2 stopped."
