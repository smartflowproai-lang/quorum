#!/bin/bash
# PRE-KICKOFF DRAFT — generated 2026-04-24 by background runner, pending Tom review before copy to live repo
# Deploy QUORUM agents to Frankfurt VPS-A and NYC VPS-B via SSH + docker compose

set -euo pipefail

VPS_A="${VPS_A:-root@143.244.204.114}"   # Frankfurt
VPS_B="${VPS_B:-root@159.65.172.200}"    # NYC
REPO_DIR="${REPO_DIR:-/root/quorum}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[deploy] rsync scaffold to Frankfurt..."
rsync -az --delete \
  --exclude=".git" --exclude="node_modules" --exclude=".env" \
  "$LOCAL_DIR/" "$VPS_A:$REPO_DIR/"

echo "[deploy] rsync scaffold to NYC..."
rsync -az --delete \
  --exclude=".git" --exclude="node_modules" --exclude=".env" \
  "$LOCAL_DIR/" "$VPS_B:$REPO_DIR/"

echo "[deploy] compose up Frankfurt (scout, judge)..."
ssh "$VPS_A" "cd $REPO_DIR && docker compose up -d scout judge"

echo "[deploy] compose up NYC (executor, treasurer)..."
ssh "$VPS_B" "cd $REPO_DIR && docker compose up -d executor treasurer"

echo "[deploy] health check..."
sleep 5
ssh "$VPS_A" "cd $REPO_DIR && docker compose ps"
ssh "$VPS_B" "cd $REPO_DIR && docker compose ps"

echo "[deploy] done"
