#!/usr/bin/env bash
#
# Pull the live JSON state files from the VPS into this local checkout, for
# read-only inspection/audit. This script NEVER pushes anything back to the
# VPS or to Supabase — pull only, in both directions.
#
# user-config.json is the one exception to "pull verbatim": it is reconciled
# key-by-key instead of overwritten, with this priority (highest wins):
#   1. Supabase       — the operator's absolute source of truth
#   2. Local machine  — this machine's current user-config.json
#   3. VPS            — lowest priority; only fills keys missing from both
#
# Everything else (state.json, pool-memory.json, decision-log.json,
# lessons.json, hivemind-cache.json, signal-weights.json,
# strategy-library.json, market-regime-profiles.json, and — if present —
# smart-wallets.json/token-blacklist.json/dev-blocklist.json/
# discord-signals.json) is the VPS's live running state, so it IS the ground
# truth and is pulled verbatim. A file missing on the VPS is skipped, not an
# error.
#
# Usage:
#   VPS_HOST=deploy@203.0.113.10 VPS_PATH=/home/deploy/meridian ./scripts/pull-vps-state.sh
#
# Or create scripts/.env.vps (gitignored) with:
#   VPS_HOST=deploy@203.0.113.10
#   VPS_PATH=/home/deploy/meridian
#   VPS_PORT=22
#   VPS_KEY=~/.ssh/id_ed25519
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$SCRIPT_DIR/.env.vps" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env.vps"
fi

VPS_HOST="${VPS_HOST:-}"
VPS_PATH="${VPS_PATH:-}"
VPS_PORT="${VPS_PORT:-22}"
VPS_KEY="${VPS_KEY:-}"

if [ -z "$VPS_HOST" ] || [ -z "$VPS_PATH" ]; then
  echo "Missing VPS_HOST / VPS_PATH." >&2
  echo "Set them as env vars, or create scripts/.env.vps — see this script's header for the format." >&2
  exit 1
fi

# scp uses -P (capital) for port; ssh uses -p (lowercase). Two arrays so an
# scp call never gets ssh's -p and silently misparses the port number as a
# source file argument.
SCP_OPTS=(-P "$VPS_PORT" -o ConnectTimeout=10)
if [ -n "$VPS_KEY" ]; then
  SCP_OPTS+=(-i "${VPS_KEY/#\~/$HOME}")
fi

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

echo "==> Pulling live state from ${VPS_HOST}:${VPS_PATH}"
echo ""

# Pulled verbatim — this is the VPS's live running state, so it is the
# ground truth for these files. Missing files are skipped silently (several
# of these fail open when absent — see README's JSON reference table).
VERBATIM_FILES=(
  state.json
  pool-memory.json
  decision-log.json
  lessons.json
  hivemind-cache.json
  signal-weights.json
  strategy-library.json
  market-regime-profiles.json
  smart-wallets.json
  token-blacklist.json
  dev-blocklist.json
  discord-signals.json
)

for f in "${VERBATIM_FILES[@]}"; do
  if scp "${SCP_OPTS[@]}" "${VPS_HOST}:${VPS_PATH}/${f}" "$STAGING_DIR/${f}" >/dev/null 2>&1; then
    cp "$STAGING_DIR/${f}" "$REPO_ROOT/${f}"
    echo "  ok    ${f}"
  else
    echo "  skip  ${f}  (not present on VPS)"
  fi
done

echo ""
echo "==> Reconciling user-config.json (Supabase > local > VPS, never overwritten wholesale)"
echo ""

if scp "${SCP_OPTS[@]}" "${VPS_HOST}:${VPS_PATH}/user-config.json" "$STAGING_DIR/user-config.vps.json" >/dev/null 2>&1; then
  node "$REPO_ROOT/scripts/reconcile-user-config.js" "$STAGING_DIR/user-config.vps.json"
else
  echo "  VPS user-config.json not found — reconciling Supabase-only (local stays as-is beyond that)"
  echo '{}' > "$STAGING_DIR/user-config.vps.json"
  node "$REPO_ROOT/scripts/reconcile-user-config.js" "$STAGING_DIR/user-config.vps.json"
fi

echo ""
echo "==> Done. Read-only against both the VPS and Supabase — nothing was pushed."
