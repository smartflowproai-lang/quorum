#!/bin/bash
# Activate QUORUM pre-commit hook. Run once after clone + scaffold cp.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Not in git repo"; exit 1; }
cd "$REPO_ROOT"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
mkdir -p logs

echo "✅ Pre-commit hook activated (.githooks/pre-commit)"
echo "✅ logs/ directory created for audit artifacts"
echo ""
echo "Tests OK:"
echo "  - Secrets scan on staged diffs"
echo "  - .env file block"
echo "  - Day 7+ requires recent /ultrareview log"
echo "  - Day 10 submission blocked without all 3 /ultrareview logs"
echo ""
echo "To bypass in emergency: git commit --no-verify (NOT recommended)"
