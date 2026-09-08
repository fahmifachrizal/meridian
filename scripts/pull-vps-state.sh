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
# strategy-library.json, market-regime-profiles.json, token-deploy-count.json,
# and — if present — smart-wallets.json/token-blacklist.json/
# dev-blocklist.json/discord-signals.json) is the VPS's live running state,
# so it IS the ground truth and is pulled verbatim. A file missing on the
# VPS is skipped, not an error.
#
# Also pulls (best-effort, never a hard failure):
#   - logs/ via rsync — the repo's own rotated logs (logs/agent-*.log,
#     logs/actions-*.jsonl) AND the dated archive shards (logs/archive/).
#   - PM2's raw stdout/stderr tail (last PM2_LOG_LINES lines) from inside the
#     container, if VPS_CONTAINER is set — these live in the container's own
#     filesystem, not on the VPS_PATH bind mount, so a plain file copy can't
#     reach them; one `docker exec ... tail` over ssh does.
#   - A live process snapshot (`pm2 jlist`, `docker ps`) — redundant
#     corroboration alongside the log files, not a replacement for them.
#   - Finally runs scripts/show-effective-config.js, which reconstructs the
#     TRUE live config (baseline + active regime overlay, recomputed locally
#     with the same pure function the agent itself uses — see that script's
#     header for why this is exact, not an approximation) and flags
#     staleness if the VPS has gone quiet.
#
# Usage:
#   VPS_HOST=deploy@203.0.113.10 VPS_PATH=/home/deploy/meridian ./scripts/pull-vps-state.sh
#
# Or create scripts/.env.vps (gitignored) with:
#   VPS_HOST=deploy@203.0.113.10
#   VPS_PATH=/home/deploy/meridian
#   VPS_PORT=22
#   VPS_KEY=~/.ssh/id_ed25519
#   VPS_CONTAINER=              # optional — docker container name running the
#                                # agent, needed only for the PM2-log pull.
#                                # Find it once with `docker ps` on the VPS.
#   PM2_LOG_LINES=2000          # optional — tail window for the PM2 log pull
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
VPS_CONTAINER="${VPS_CONTAINER:-}"
PM2_LOG_LINES="${PM2_LOG_LINES:-2000}"

if [ -z "$VPS_HOST" ] || [ -z "$VPS_PATH" ]; then
  echo "Missing VPS_HOST / VPS_PATH." >&2
  echo "Set them as env vars, or create scripts/.env.vps — see this script's header for the format." >&2
  exit 1
fi

# scp uses -P (capital) for port; ssh uses -p (lowercase). Two separate
# arrays so an scp call never gets ssh's -p and silently misparses the port
# number as a source file argument (this bit us once already — see CLAUDE.md).
SCP_OPTS=(-P "$VPS_PORT" -o ConnectTimeout=10)
SSH_OPTS=(-p "$VPS_PORT" -o ConnectTimeout=10)
if [ -n "$VPS_KEY" ]; then
  RESOLVED_KEY="${VPS_KEY/#\~/$HOME}"
  SCP_OPTS+=(-i "$RESOLVED_KEY")
  SSH_OPTS+=(-i "$RESOLVED_KEY")
fi

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

# Connectivity self-check. If SSH itself is unreachable, every scp/ssh call
# below will silently "skip" one by one with no single clear signal of why —
# so check once, up front, and if it fails print the caller's own outbound
# IP as a diagnostic (best-effort — this environment's egress IP is not
# necessarily stable, so treat it as a data point, not a fixed identity to
# permanently allowlist). Never blocks the rest of the script.
if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=5 "$VPS_HOST" "true" >/dev/null 2>&1; then
  SSH_REACHABLE=1
else
  SSH_REACHABLE=0
  echo "==> WARNING: SSH to ${VPS_HOST} (port ${VPS_PORT}) is unreachable — every ssh/scp step below will be skipped."
  MY_IP="$(curl -s --max-time 5 https://ifconfig.me 2>/dev/null || echo "unknown")"
  echo "    This environment's outbound IP right now: ${MY_IP}"
  echo "    If your VPS firewall/security group allowlists SSH by source IP,"
  echo "    check that list against the IP above. If port 22 is closed while"
  echo "    other ports (80/443) respond, this more likely means sshd is down"
  echo "    or a port-specific rule changed, not a source-IP allowlist issue —"
  echo "    check the VPS console directly either way."
  echo ""
fi

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
  token-deploy-count.json
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
echo "==> Pulling logs/ (rotated logs + dated archive shards)"
echo ""

mkdir -p "$REPO_ROOT/logs/vps-snapshot"

# One rsync gets both logs/archive/*.jsonl (this session's dated archive
# layer) and the repo's own logs/agent-*.log / logs/actions-*.jsonl in one
# shot — they all live under the same VPS_PATH/logs/ directory. No --delete:
# local-only files (e.g. from a local migrate-archive.js run) are never
# removed, keeping this strictly additive/pull-only. Only new/changed bytes
# transfer on repeat runs.
if command -v rsync >/dev/null 2>&1; then
  if rsync -az -e "ssh -p ${VPS_PORT} $([ -n "$VPS_KEY" ] && echo "-i $RESOLVED_KEY") -o ConnectTimeout=10" \
      "${VPS_HOST}:${VPS_PATH}/logs/" "$REPO_ROOT/logs/" 2>/dev/null; then
    echo "  ok    logs/ (archive + rotated logs)"
  else
    echo "  skip  logs/ (rsync failed — VPS_PATH/logs/ may not exist yet)"
  fi
else
  echo "  skip  logs/ (rsync not found on this machine)"
fi

echo ""
echo "==> Pulling PM2 process log + live status (best-effort, never blocks the rest of this script)"
echo ""

if [ -n "$VPS_CONTAINER" ]; then
  if ssh "${SSH_OPTS[@]}" "$VPS_HOST" \
      "docker exec ${VPS_CONTAINER} tail -n ${PM2_LOG_LINES} /root/.pm2/logs/meridian-out.log" \
      > "$REPO_ROOT/logs/vps-snapshot/pm2-out.log" 2>/dev/null; then
    echo "  ok    pm2-out.log (last ${PM2_LOG_LINES} lines)"
  else
    echo "  skip  pm2-out.log (ssh/docker exec failed)"
    rm -f "$REPO_ROOT/logs/vps-snapshot/pm2-out.log"
  fi
  if ssh "${SSH_OPTS[@]}" "$VPS_HOST" \
      "docker exec ${VPS_CONTAINER} tail -n ${PM2_LOG_LINES} /root/.pm2/logs/meridian-error.log" \
      > "$REPO_ROOT/logs/vps-snapshot/pm2-error.log" 2>/dev/null; then
    echo "  ok    pm2-error.log (last ${PM2_LOG_LINES} lines)"
  else
    echo "  skip  pm2-error.log (ssh/docker exec failed)"
    rm -f "$REPO_ROOT/logs/vps-snapshot/pm2-error.log"
  fi
else
  echo "  skip  PM2 log pull (VPS_CONTAINER not set in scripts/.env.vps — see this script's header)"
fi

# Live process snapshot — redundant corroboration alongside the log files
# above, not a replacement for them. Saved to disk (not just printed) so
# it's available for later reanalysis. Best-effort; never a hard failure.
if ssh "${SSH_OPTS[@]}" "$VPS_HOST" "pm2 jlist" > "$REPO_ROOT/logs/vps-snapshot/pm2-status.json" 2>/dev/null; then
  echo "  ok    pm2-status.json (pm2 jlist)"
else
  echo "  skip  pm2-status.json (ssh/pm2 failed)"
  rm -f "$REPO_ROOT/logs/vps-snapshot/pm2-status.json"
fi
if ssh "${SSH_OPTS[@]}" "$VPS_HOST" "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'" > "$REPO_ROOT/logs/vps-snapshot/docker-ps.txt" 2>/dev/null; then
  echo "  ok    docker-ps.txt"
else
  echo "  skip  docker-ps.txt (ssh/docker failed)"
  rm -f "$REPO_ROOT/logs/vps-snapshot/docker-ps.txt"
fi

echo ""
echo "==> Reconstructing effective runtime config + staleness check"
node "$REPO_ROOT/scripts/show-effective-config.js"

echo "==> Done. Read-only against the VPS and Supabase — nothing was pushed, no remote state was changed."
