#!/bin/bash
# Deploy QUORUM agents to Frankfurt VPS-A and NYC VPS-B via SSH + docker compose.
#
# Long-lived per-host ed25519 signing keys are provisioned on each host as part
# of this script. Each role-host pair owns exactly one keypair, generated the
# first time this script runs against the host and reused for every subsequent
# attestation. The secret half (`.sec`) is generated on-host (never leaves it);
# the public half (`.pub`) is rsynced back so co-signers can pre-load it.
#
# Layout per host:
#   $REPO_DIR/agents/judge/keys/host-frankfurt.{pub,sec}     # on VPS_A
#   $REPO_DIR/agents/verifier/keys/host-nyc.{pub,sec}        # on VPS_B
#
# .sec is chmod 600. The shared loader (`shared/host-keys.ts`) enforces an
# ed25519 + keypair self-check at load time so a mismatched .pub/.sec pair is
# refused before it can sign an attestation.

set -euo pipefail

VPS_A="${VPS_A:-root@143.244.204.114}"   # Frankfurt — Scout + Judge
VPS_B="${VPS_B:-root@159.65.172.200}"    # NYC — Verifier + Executor + Treasurer
REPO_DIR="${REPO_DIR:-/root/quorum}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Helper: idempotently generate an ed25519 keypair on a remote host.
# Args: $1=ssh-target  $2=keys-dir-relative-to-REPO_DIR  $3=base-filename  $4=role  $5=host
ensure_host_key() {
  local target="$1" keys_dir="$2" base="$3" role="$4" host_label="$5"
  echo "[deploy] ensure ed25519 keypair ${role}/${host_label} on ${target}..."
  ssh "$target" "
    set -euo pipefail
    cd $REPO_DIR
    mkdir -p ${keys_dir}
    pub=${keys_dir}/${base}.pub
    sec=${keys_dir}/${base}.sec
    if [ -f \"\$sec\" ] && [ -f \"\$pub\" ]; then
      echo '[deploy:remote] keypair already present — keeping existing long-lived key'
    else
      echo '[deploy:remote] generating new ed25519 keypair'
      tmp=\$(mktemp -d)
      openssl genpkey -algorithm ED25519 -out \"\$tmp/sec.pem\" 2>/dev/null
      openssl pkey -in \"\$tmp/sec.pem\" -pubout -out \"\$tmp/pub.pem\" 2>/dev/null
      mv \"\$tmp/sec.pem\" \"\$sec\"
      mv \"\$tmp/pub.pem\" \"\$pub\"
      rm -rf \"\$tmp\"
    fi
    chmod 600 \"\$sec\"
    chmod 644 \"\$pub\"
  "
  # Pull the .pub back to local so co-signers can pre-load it.
  mkdir -p "$LOCAL_DIR/${keys_dir}"
  rsync -az "$target:$REPO_DIR/${keys_dir}/${base}.pub" "$LOCAL_DIR/${keys_dir}/${base}.pub"
}

echo "[deploy] rsync scaffold to Frankfurt..."
rsync -az --delete \
  --exclude=".git" --exclude="node_modules" --exclude=".env" \
  --exclude="agents/*/keys/*.sec" \
  "$LOCAL_DIR/" "$VPS_A:$REPO_DIR/"

echo "[deploy] rsync scaffold to NYC..."
rsync -az --delete \
  --exclude=".git" --exclude="node_modules" --exclude=".env" \
  --exclude="agents/*/keys/*.sec" \
  "$LOCAL_DIR/" "$VPS_B:$REPO_DIR/"

# Provision long-lived signing keys per role-host pair. Idempotent: re-runs of
# deploy-vps.sh reuse the existing keypair, preserving the on-chain identity
# anchored by the first attestation.
ensure_host_key "$VPS_A" "agents/judge/keys"     "host-frankfurt" "judge"    "frankfurt"
ensure_host_key "$VPS_B" "agents/verifier/keys"  "host-nyc"       "verifier" "nyc"

# Cross-distribute the .pub files so each host can verify the other's sigs.
echo "[deploy] cross-distribute public keys (Frankfurt judge .pub → NYC, NYC verifier .pub → Frankfurt)..."
rsync -az "$LOCAL_DIR/agents/judge/keys/host-frankfurt.pub"    "$VPS_B:$REPO_DIR/agents/judge/keys/"
rsync -az "$LOCAL_DIR/agents/verifier/keys/host-nyc.pub"       "$VPS_A:$REPO_DIR/agents/verifier/keys/"

echo "[deploy] compose up Frankfurt (scout, judge)..."
ssh "$VPS_A" "cd $REPO_DIR && docker compose up -d scout judge"

echo "[deploy] compose up NYC (verifier, executor, treasurer)..."
ssh "$VPS_B" "cd $REPO_DIR && docker compose up -d verifier executor treasurer"

echo "[deploy] health check..."
sleep 5
ssh "$VPS_A" "cd $REPO_DIR && docker compose ps"
ssh "$VPS_B" "cd $REPO_DIR && docker compose ps"

echo "[deploy] done"
