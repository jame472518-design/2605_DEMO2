#!/bin/bash
# install-plugins.sh — Linux equivalent of install-plugins.ps1
#
# For each plugin under openclaw-plugins/, build → copy artifacts to install
# dir → npm install --omit=dev for runtime deps. Cleaner than the PS1's
# manual recursive node_modules copy.
set -euo pipefail

PROFILE="${PROFILE:-strixdemo2}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS_ROOT="$REPO_ROOT/openclaw-plugins"
INSTALL_ROOT="$HOME/.openclaw-$PROFILE/extensions"
mkdir -p "$INSTALL_ROOT"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || true
fi

for plugin_src in "$PLUGINS_ROOT"/*/; do
    name=$(basename "$plugin_src")
    [ -d "$plugin_src" ] || continue
    echo ""
    echo "[$name] building..."
    pushd "$plugin_src" >/dev/null
    if [ ! -f "dist/index.js" ] || [ "src/index.ts" -nt "dist/index.js" ]; then
        # Use local tsc binary directly to avoid pnpm v11's approve-builds gate
        if [ -x "node_modules/.bin/tsc" ]; then
            node_modules/.bin/tsc
        else
            npx tsc
        fi
    else
        echo "[$name] dist up-to-date, skipping build"
    fi
    popd >/dev/null

    dst="$INSTALL_ROOT/$name"
    rm -rf "$dst"
    mkdir -p "$dst"
    cp -r "$plugin_src/dist" "$dst/"
    cp "$plugin_src/package.json" "$dst/"
    cp "$plugin_src/openclaw.plugin.json" "$dst/"
    [ -f "$plugin_src/rules.yaml" ] && cp "$plugin_src/rules.yaml" "$dst/"

    echo "[$name] fetching runtime deps via npm install --omit=dev..."
    pushd "$dst" >/dev/null
    npm install --omit=dev --no-audit --no-fund --silent 2>&1 | tail -3 || true
    popd >/dev/null

    echo "[$name] installed -> $dst"

    # sensor-bridge: ship dashboard SPA + judge-prompt
    if [ "$name" = "sensor-bridge" ]; then
        dashboard_dist="$REPO_ROOT/dashboard/dist"
        if [ -d "$dashboard_dist" ]; then
            static_dst="$dst/static"
            mkdir -p "$static_dst"
            cp -r "$dashboard_dist"/* "$static_dst/"
            echo "[$name] copied dashboard SPA -> $static_dst"
        else
            echo "[$name] (no dashboard/dist found — run 'cd dashboard && pnpm run build' first)"
        fi
        judge_ws="$REPO_ROOT/openclaw-workspaces/judge-1"
        if [ -d "$judge_ws" ]; then
            prompt_dst="$dst/judge-prompt"
            mkdir -p "$prompt_dst"
            [ -f "$judge_ws/SOUL.md" ] && cp "$judge_ws/SOUL.md" "$prompt_dst/"
            [ -f "$judge_ws/AGENTS.md" ] && cp "$judge_ws/AGENTS.md" "$prompt_dst/"
            echo "[$name] copied judge-1 prompt -> $prompt_dst"
        fi
    fi
done

echo ""
echo "Done. Profile '$PROFILE' plugins installed at $INSTALL_ROOT"
