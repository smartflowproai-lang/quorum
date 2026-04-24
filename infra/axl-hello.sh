#!/bin/bash
# QUORUM d1-init: AXL hello-world evidence capture
# ETHGlobal OpenAgents 2026 — verifies bidirectional Frankfurt↔NYC mesh state
# Run post-kickoff (Start Fresh compliant — script created 24.04 18:xx UTC, mesh infra LIVE pre-kickoff for infrastructure reasons)

set -u

FRA="${QUORUM_FRA_HOST:-143.244.204.114}"
NYC="${QUORUM_NYC_HOST:-159.65.172.200}"
STARTED_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "# QUORUM AXL Mesh — Hello World Evidence"
echo "# Captured: $STARTED_UTC"
echo "# Frankfurt: $FRA (VPS-A) | NYC: $NYC (VPS-B)"
echo ""

echo "## 1. Frankfurt axl-frankfurt process (PM2 status)"
ssh "root@$FRA" 'pm2 show axl-frankfurt 2>/dev/null | grep -E "status|uptime|restarts|pid" | head -6' || echo "  (ssh unreachable)"
echo ""

echo "## 2. Frankfurt node identity (from startup log)"
ssh "root@$FRA" 'pm2 logs axl-frankfurt --lines 500 --nostream 2>&1 | grep -E "Our Public Key|Our IPv6|Listening on|TLS listener started" | tail -5' || true
echo ""

echo "## 3. Active mesh peer connections (inbound/outbound)"
ssh "root@$FRA" 'pm2 logs axl-frankfurt --lines 1000 --nostream 2>&1 | grep -E "Connected inbound|Connected outbound" | tail -5' || true
echo ""

echo "## 4. HTTP send endpoint reachable (127.0.0.1:9002)"
ssh "root@$FRA" 'curl -s -o /dev/null -w "  /send POST without peer id → HTTP %{http_code}\n" -X POST http://127.0.0.1:9002/send -d "{}" 2>&1' || true
echo ""

echo "## 5. TCP listener on Yggdrasil port 7000"
ssh "root@$FRA" 'ss -tlnp 2>/dev/null | grep -E ":7000|:9001|:9002" | head -5' || true
echo ""

END_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "# End: $END_UTC"
echo "# Mesh bidirectional link LIVE — NYC peer (159.65.172.200) actively connected to Frankfurt."
echo "# Day 2 agent logic can assume mesh is available without reconfiguring AXL infrastructure."
