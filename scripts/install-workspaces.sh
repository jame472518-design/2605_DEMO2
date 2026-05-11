#!/bin/bash
# install-workspaces.sh — Linux equivalent of install-workspaces.ps1
# Idempotently registers judge-1 in ~/.openclaw-strixdemo2/openclaw.json's
# agents.list[]. Uses python3 (no jq dep).
set -euo pipefail

PROFILE="${PROFILE:-strixdemo2}"
PROFILE_DIR="$HOME/.openclaw-$PROFILE"
CONFIG="$PROFILE_DIR/openclaw.json"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WS_ROOT="$REPO_ROOT/openclaw-workspaces"

if [ ! -f "$CONFIG" ]; then
    echo "ERROR: $CONFIG not found. Run bootstrap-profile.sh first." >&2
    exit 1
fi

JUDGE_WS="$WS_ROOT/judge-1"
mkdir -p "$JUDGE_WS"
echo "ws  judge-1 -> $JUDGE_WS"

BACKUP="$CONFIG.bak.$(date +%Y%m%d-%H%M%S)"
cp "$CONFIG" "$BACKUP"
echo "backup -> $BACKUP"

python3 - "$CONFIG" "$JUDGE_WS" <<'PYEOF'
import json, sys
config_path, judge_ws = sys.argv[1], sys.argv[2]
with open(config_path, encoding="utf-8") as f:
    cfg = json.load(f)
agents = cfg.setdefault("agents", {})
lst = agents.setdefault("list", [])
# Drop existing judge-1 entry if present
lst = [a for a in lst if a.get("id") != "judge-1"]
# Preserve "main" first, then append judge-1, then any others
main = [a for a in lst if a.get("id") == "main"]
others = [a for a in lst if a.get("id") != "main"]
lst = main + others + [{"id": "judge-1", "name": "judge-1", "workspace": judge_ws}]
agents["list"] = lst
with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print("agents.list updated: judge-1 registered")
PYEOF

cat <<INFO

============================================================
  Workspaces installed for profile: $PROFILE
============================================================
  Agents:     judge-1
  Backup:     $BACKUP

  Verify:     openclaw --profile $PROFILE agents list
============================================================
INFO
