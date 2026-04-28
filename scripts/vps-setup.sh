#!/usr/bin/env bash
# scripts/vps-setup.sh
#
# Idempotent setup for VPS-level convenience tooling.
# Run as root on the Coolify VPS (178.156.180.212).
#
# Does NOT touch Coolify, Docker services, application config, or secrets.
# Re-running is safe — already-present entries are skipped.
#
# Usage:
#   sudo bash scripts/vps-setup.sh

set -euo pipefail

BASHRC=/root/.bashrc

add_if_missing() {
    local marker="$1"
    if grep -qF "$marker" "$BASHRC" 2>/dev/null; then
        echo "already present: $marker"
    else
        shift
        printf '\n%s\n' "$@" >> "$BASHRC"
        echo "added: $marker"
    fi
}

# --- dps: human-readable docker ps ---
#
# Coolify assigns UUID-based container names (e.g. lrddgp8im0276gllujfu7wm3-151927890021).
# This alias adds the coolify.resourceName label as a second column so containers
# are identifiable without renaming them.
#
# Do NOT rename Coolify containers — the rolling update removes the old container
# by name; renaming the new one before that step completes causes the new
# container to be deleted. See AI_INFRASTRUCTURE_GUIDE.md § Container naming.
add_if_missing '# vps-setup: dps' \
'# vps-setup: dps — docker ps with coolify.resourceName label visible' \
'alias dps='"'"'docker ps --format "table {{.Names}}\t{{.Label "coolify.resourceName"}}\t{{.Status}}\t{{.Image}}"'"'"''

echo
echo "done — run: source $BASHRC"
