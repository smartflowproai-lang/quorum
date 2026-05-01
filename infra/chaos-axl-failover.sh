#!/bin/bash
# chaos-axl-failover.sh — reproducible AXL mesh chaos test for QUORUM.
#
# Builds Test A + Test B + Test C from CHAOS-TEST.md:
#   A) Process kill on Frankfurt (pm2 stop / start)
#   B) Short network partition (76s iptables DROP to NYC)
#   C) Long partition (243s iptables DROP)
#
# Run on Frankfurt VPS-A only. NYC SSH not available under current keys
# (per CHAOS-TEST.md), so reverse direction is simulated via iptables.
#
# Total wall-clock: ~9 minutes. Stamps every marker to /tmp/axl-chaos.log
# in the canonical format CHAOS-TEST.md was generated from.
#
# Output: /tmp/axl-chaos.log (raw run log)
# Doc:    CHAOS-TEST.md (analysis + recovery measurements)
#
# Usage: bash infra/chaos-axl-failover.sh

set -e
NYC_IP="159.65.172.200"
LOG="/tmp/axl-chaos.log"
TOPO_URL="http://127.0.0.1:9002/topology"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

stamp() {
  local marker="$1"
  echo "$(ts)  $marker" | tee -a "$LOG"
}

snapshot_estab() {
  ss -tnp 2>/dev/null | grep "$NYC_IP" | head -2 | tee -a "$LOG" || echo "no-estab" | tee -a "$LOG"
}

echo "=== chaos-axl-failover.sh — START $(ts) ===" | tee -a "$LOG"
echo "Pre-baseline:" | tee -a "$LOG"
snapshot_estab
curl -s "$TOPO_URL" | python3 -m json.tool | head -20 | tee -a "$LOG"

# === TEST A — Process kill on Frankfurt ===
stamp "TEST_A_pm2_stop_frankfurt"
pm2 stop axl-frankfurt || true
sleep 5
snapshot_estab
echo "Holding stop for 27s..." | tee -a "$LOG"
sleep 22
stamp "TEST_A_pm2_start_frankfurt"
pm2 start axl-frankfurt
sleep 5
snapshot_estab
echo "Test A complete — verify ESTAB on new ephemeral port" | tee -a "$LOG"
sleep 3

# === TEST B — Short network partition (76s) ===
stamp "TEST_B_partition_start_76s"
iptables -I INPUT  1 -s "$NYC_IP" -j DROP
iptables -I OUTPUT 1 -d "$NYC_IP" -j DROP
sleep 60
echo "T+60s: ESTAB still expected (kernel TCP retry budget)" | tee -a "$LOG"
snapshot_estab
sleep 16
stamp "TEST_B_partition_heal"
iptables -D INPUT  -s "$NYC_IP" -j DROP
iptables -D OUTPUT -d "$NYC_IP" -j DROP
sleep 5
snapshot_estab
echo "Test B complete — recovery should be ~0s (kernel-side socket survived)" | tee -a "$LOG"
sleep 3

# === TEST C — Long network partition (243s) ===
stamp "TEST_C_partition_start_243s"
iptables -I INPUT  1 -s "$NYC_IP" -j DROP
iptables -I OUTPUT 1 -d "$NYC_IP" -j DROP
sleep 240
stamp "TEST_C_partition_heal"
iptables -D INPUT  -s "$NYC_IP" -j DROP
iptables -D OUTPUT -d "$NYC_IP" -j DROP
sleep 100
stamp "TEST_C_recovery_check"
snapshot_estab
echo "Test C complete — peer-side reconnect, fresh ephemeral port expected" | tee -a "$LOG"

# === Final state ===
stamp "FINAL_STATE"
echo "iptables INPUT/OUTPUT to $NYC_IP:" | tee -a "$LOG"
iptables -L INPUT  -n | grep "$NYC_IP" || echo "  clean" | tee -a "$LOG"
iptables -L OUTPUT -n | grep "$NYC_IP" || echo "  clean" | tee -a "$LOG"
echo "axl-frankfurt:" | tee -a "$LOG"
pm2 jlist 2>/dev/null | python3 -c "import sys, json; d = json.load(sys.stdin); f = next((p for p in d if p[\"name\"] == \"axl-frankfurt\"), None); print(f\"  status={f[\\\"pm2_env\\\"][\\\"status\\\"]} pid={f[\\\"pid\\\"]} restarts={f[\\\"pm2_env\\\"][\\\"restart_time\\\"]}\" if f else \"  not found\")" | tee -a "$LOG"
snapshot_estab
echo "=== chaos-axl-failover.sh — END $(ts) ===" | tee -a "$LOG"
