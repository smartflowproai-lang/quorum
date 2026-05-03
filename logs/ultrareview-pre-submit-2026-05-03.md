# ultrareview log — pre-submit final (Day 10, 2026-05-03)

**Scope**: post-fixes adversarial verification before 18:00 CEST submit. Triple-persona fresh-context (OpenZeppelin auditor + ex-Coinbase x402/EVM eng + ETHGlobal Gensyn liaison) hostile review of HEAD `87d2ebc` (post-OZ-2a docker-build.yml English fix).

**Method**: full repo audit via direct file reads + raw GitHub URL spot-checks + Base mainnet RPC verification of all three headline TXs.

**Verification of declared 5 HIGH fixes**: ALL CLEAN (OZ-1 env-var rename, OZ-2 Polish-language strip, CB-1 eth_getCode evidence, CB-3 keypair caveat, GX-2 chronology disclaimer). Six audit-note files HTTP 404 confirmed gone from public surface.

**New findings (5 to fix pre-submit, all addressed in same commit batch)**:
1. **HIGH** — direct contradiction: README/SUBMISSION anchored on shipped attestation TX `0x19bb1d0e…` while three locations still claimed "first programmatic Base-mainnet attestation tx is deferred post-submit". Reconciled to manual one-shot landed + programmatic loop deferred.
2. **MED** — SUBMISSION:113 "zero-dependency Node script" contradicted README:30 "single dep viem". Corrected.
3. **MED** — `.env.example` missing TREASURER_PRIVATE_KEY / TREASURER_ENV_FILE that OZ-1-refactored scripts now require. Added with placeholder + comment.
4. **LOW-MED** — lockfiles leaked absolute path `/root/x402-payment-tracker/payments.db`. Made relative.
5. **MED** — README:18 + SUBMISSION:14 + SUBMISSION:22 framing implied on-chain TX itself proves cross-continent ed25519 signing; CB-3 disclaimer admits both keypairs spun fresh single-host. Tightened: cross-continent independence is concrete at AXL mesh layer (CHAOS-TEST.md), on-chain TX encodes role-signing shape.

**Verdict**: BORDERLINE → **PASS-WITH-MINOR after this commit batch closes all 5 new findings**.

Per-persona scoring: OZ ADVANCE WITH MINOR (security posture fine, documentation hygiene was the half-grade). Coinbase eng ADVANCE WITH RESERVATIONS (KH x402 settlement + EIP-7702 eth_getCode evidence solid; FLAW #1 contradiction was the burn). Gensyn liaison ADVANCE (chaos-test artifact genuinely good, cross-continent framing tightening per FLAW #5 will make it cleaner).

**Reference**: full multi-persona review held offline (untracked per audit-notes .gitignore patterns). Summary preserved here for ETHGlobal pre-commit-hook compliance.
