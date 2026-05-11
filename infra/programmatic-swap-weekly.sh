#!/usr/bin/env bash
# Programmatic Treasurer swap loop — weekly USDC→WETH on Base.
# Invoked from /etc/cron.d/quorum-weekly-swap (Monday 09:00 UTC).
#
# Usage:
#   programmatic-swap-weekly.sh              # live swap (1 USDC → WETH)
#   programmatic-swap-weekly.sh --dry-run    # balance + gas estimate, no broadcast
#
# Validation target: 4 swaps over 4 consecutive Mondays. Each run writes
#   /root/quorum/logs/d12-programmatic-swap-weekN.json
# where N auto-increments based on existing log files.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

REPO_ROOT="/root/quorum"
LOG_DIR="${REPO_ROOT}/logs"
RUN_LOG="${LOG_DIR}/d12-programmatic-swap-cron.log"
TREASURER_ENV_FILE="${TREASURER_ENV_FILE:-/root/x402-api/.env}"

mkdir -p "${LOG_DIR}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" | tee -a "${RUN_LOG}"; }

MODE=$([[ ${DRY_RUN} -eq 1 ]] && echo "dry-run" || echo "live")
log "=== programmatic-swap START mode=${MODE} ==="

cd "${REPO_ROOT}/agents/treasurer"
export TREASURER_ENV_FILE

ARGS=()
[[ ${DRY_RUN} -eq 1 ]] && ARGS+=("--dry-run")

if node scripts/swap-usdc-weth.mjs "${ARGS[@]}" 2>&1 | tee -a "${RUN_LOG}"; then
  STATUS="ok"
else
  STATUS="error"
fi

log "=== programmatic-swap END status=${STATUS} ==="
[[ "${STATUS}" == "ok" ]] && exit 0 || exit 1
