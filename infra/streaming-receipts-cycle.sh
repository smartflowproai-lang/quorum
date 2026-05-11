#!/usr/bin/env bash
# Streaming receipts daily cycle driver.
# Runs the canonical Scout->Judge->Verifier->Executor->Base attestation
# evidence-hash + dual-ed25519 calldata TX once. Logs cycle metadata to
# logs/d11-streaming-receipts-cron.{log,jsonl}.
#
# Usage:
#   streaming-receipts-cycle.sh            # send live TX
#   streaming-receipts-cycle.sh --dry-run  # estimate gas + budget, no send
#
# Cron entry: /etc/cron.d/quorum-daily-cycle (03:00 UTC daily).

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

REPO_ROOT="/root/quorum"
LOG_DIR="${REPO_ROOT}/logs"
LOG_FILE="${LOG_DIR}/d11-streaming-receipts-cron.log"
JSONL_FILE="${LOG_DIR}/d11-streaming-receipts-cron.jsonl"
TREASURER_ENV_FILE="${TREASURER_ENV_FILE:-/root/x402-api/.env}"
TREASURER_ADDR="0xd779cE46567d21b9918F24f0640cA5Ad6058C893"
USDC_BASE="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
BASE_RPC="${BASE_RPC_URL:-https://mainnet.base.org}"

mkdir -p "${LOG_DIR}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" | tee -a "${LOG_FILE}"; }

cycle_n() {
  local jsonl_count=0
  if [[ -f "${JSONL_FILE}" ]]; then
    jsonl_count=$(grep -c '"tx_hash"' "${JSONL_FILE}" 2>/dev/null || echo 0)
  fi
  echo $((jsonl_count + 1))
}

CYCLE=$(cycle_n)
MODE=$([[ ${DRY_RUN} -eq 1 ]] && echo "dry-run" || echo "live")
log "=== cycle ${CYCLE} START mode=${MODE} ==="

# Pre-flight budget check (live RPC).
ETH_HEX=$(curl -fsS -m 15 -X POST -H "Content-Type: application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBalance\",\"params\":[\"${TREASURER_ADDR}\",\"latest\"],\"id\":1}" \
  "${BASE_RPC}" | python3 -c "import json,sys;print(json.load(sys.stdin)['result'])")
ETH_WEI=$(python3 -c "print(int('${ETH_HEX}', 16))")
ETH_BAL=$(python3 -c "print(${ETH_WEI}/1e18)")

USDC_HEX=$(curl -fsS -m 15 -X POST -H "Content-Type: application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"${USDC_BASE}\",\"data\":\"0x70a08231000000000000000000000000d779cE46567d21b9918F24f0640cA5Ad6058C893\"},\"latest\"],\"id\":1}" \
  "${BASE_RPC}" | python3 -c "import json,sys;print(json.load(sys.stdin)['result'])")
USDC_RAW=$(python3 -c "print(int('${USDC_HEX}', 16))")
USDC_BAL=$(python3 -c "print(${USDC_RAW}/1e6)")

log "treasurer ${TREASURER_ADDR}: ETH=${ETH_BAL} USDC=${USDC_BAL}"

# Min budget guard for live runs: ~10 cycles of headroom at typical Base gas.
# Per-cycle cost at 0.01 gwei * 60k gas ~= 6e-10 ETH; we still require 0.0001 ETH float.
if [[ ${DRY_RUN} -eq 0 ]]; then
  if python3 -c "import sys; sys.exit(0 if ${ETH_BAL} > 0.0001 else 1)"; then :; else
    log "ABORT: ETH balance ${ETH_BAL} below 0.0001 floor"
    echo "{\"cycle\":${CYCLE},\"ts\":\"$(ts)\",\"status\":\"aborted_budget\",\"eth\":${ETH_BAL},\"usdc\":${USDC_BAL}}" >> "${JSONL_FILE}"
    exit 2
  fi
fi

if [[ ${DRY_RUN} -eq 1 ]]; then
  # Estimate gas for a calldata-only TX of the size attestation-tx.mjs produces (~828 bytes).
  # We use a probe payload of all-zero bytes of similar size to get a realistic estimate.
  PROBE_DATA="0x$(python3 -c 'print("00"*828)')"
  GAS_EST_HEX=$(curl -fsS -m 15 -X POST -H "Content-Type: application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_estimateGas\",\"params\":[{\"from\":\"${TREASURER_ADDR}\",\"to\":\"0x000000000000000000000000000000000000dEaD\",\"value\":\"0x0\",\"data\":\"${PROBE_DATA}\"}],\"id\":1}" \
    "${BASE_RPC}" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('result') or d)")
  GP_HEX=$(curl -fsS -m 15 -X POST -H "Content-Type: application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_gasPrice\",\"params\":[],\"id\":1}" \
    "${BASE_RPC}" | python3 -c "import json,sys;print(json.load(sys.stdin)['result'])")
  COST_LINE=$(python3 -c "
gas=int('${GAS_EST_HEX}',16); gp=int('${GP_HEX}',16)
cost=gas*gp/1e18
print(f'gas_est={gas} gas_price_gwei={gp/1e9:.6f} cost_eth_per_cycle={cost:.10f} cost_eth_30_cycles={cost*30:.10f}')")
  log "DRY-RUN budget: ${COST_LINE}"
  echo "{\"cycle\":${CYCLE},\"ts\":\"$(ts)\",\"status\":\"dry_run_ok\",\"eth\":${ETH_BAL},\"usdc\":${USDC_BAL},\"${COST_LINE// /\",\"}\"}" \
    | sed 's/=/":"/g' >> "${JSONL_FILE}" || true
  log "=== cycle ${CYCLE} END status=dry_run_ok ==="
  exit 0
fi

# Live run: invoke attestation-tx.mjs from the treasurer module.
cd "${REPO_ROOT}/agents/treasurer"
export TREASURER_ENV_FILE
START_TS=$(ts)
RUN_LOG=$(mktemp)
if node scripts/attestation-tx.mjs >"${RUN_LOG}" 2>&1; then
  STATUS="ok"
else
  STATUS="error"
fi
cat "${RUN_LOG}" | tee -a "${LOG_FILE}"

TX_HASH=$(grep -oE "TX SENT: 0x[0-9a-fA-F]{64}" "${RUN_LOG}" | head -1 | awk '{print $3}' || true)
BLOCK=$(grep -oE "CONFIRMED block: [0-9]+" "${RUN_LOG}" | head -1 | awk '{print $3}' || true)
rm -f "${RUN_LOG}"

python3 - <<PY >> "${JSONL_FILE}"
import json,sys
print(json.dumps({
  "cycle": ${CYCLE},
  "ts_start": "${START_TS}",
  "ts_end": "$(ts)",
  "status": "${STATUS}",
  "tx_hash": "${TX_HASH:-}",
  "block": "${BLOCK:-}",
  "eth_pre": ${ETH_BAL},
  "usdc_pre": ${USDC_BAL}
}))
PY

log "=== cycle ${CYCLE} END status=${STATUS} tx=${TX_HASH:-none} block=${BLOCK:-none} ==="
[[ "${STATUS}" == "ok" ]] && exit 0 || exit 1
