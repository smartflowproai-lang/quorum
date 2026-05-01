# DATA-COVERAGE.md

Explicit per-chain breakdown of every dataset QUORUM reads from. If a number appears in the README, the demo video, or a partner write-up, its origin is listed here.

**Last verified**: 2026-04-30 16:10 UTC (numbers locked in `lockfile-2026-04-30-evening.json`; regenerated from `payments.db` on author's infrastructure). Supersedes earlier `numbers-ground-truth-lockfile-2026-04-28` lock.

---

## 1. EVM Wallet Graph (`wallet_profiles.db`)

- **Size**: 231,633 profiled addresses, ~180 MB structured records.
- **Chains**: Base + Ethereum mainnet. **100% EVM. Zero Solana.**
- **Source**: on-chain indexing of x402 payment participants + behavioural labeling. Authored 2026-Q1 through 2026-04-17.
- **What QUORUM uses it for**: cross-chain rug-farmer lookup. When an EVM-bridge-linker (Wormhole / deBridge / Allbridge) resolves a Solana buyer to an EVM counterparty, Judge looks up the counterparty's `evm_rug_prior_count` in this graph.
- **What QUORUM does NOT claim**: this graph does not cover Solana wallets. Any claim to that effect is an error.
- **Expected bridge-linker hit rate** on random Solana memecoin buyers: 5–20% (most memecoin buyers never bridge). If measured hit rate falls below 15% during Day-2 data plumbing, cross-chain features are demoted to "bonus uplift" status and Solana-native features remain the primary signal.

## 2. Solana Copy-Bot Event Archive (`payments.db`, `mapper.db`-derived)

- **Size**: 58,432 observed events, ~60 MB compressed, 18-day window (2026-04-01 → 2026-04-18 as of snapshot).
- **Chains**: **Solana mainnet only.**
- **Source**: author's existing public copy-bot infrastructure (14 hand-curated smart-money wallets). Pure-read via Helius RPC.
- **What QUORUM uses it for**: Solana-native feature extraction — buyer-cluster overlap with prior Solana rugs, sniper-bot share, wallet age, holder count at T+5min.
- **Wallet count**: 14 curated smart-money wallets (not "231K Solana wallets" — that claim would be an error).
- **Label set for training**: ≈46 confirmed rugs labelled within the 18-day window (Day-3 backtest target).

## 3. x402 Endpoint Mapper (`mapper.db`)

- **Size**: 22,054 registered endpoints (canonical figure used across SUBMISSION / FEEDBACK / JUDGE_INTRO; snapshot fed forward from 2026-04-29 mapper run).
- **Chain composition**: **99.9% EVM (Base + Ethereum + misc EVM L2s) / 0.78% Solana**. Publicly reported.
- **Source**: author's x402 network mapper, authored 2026-Q1 through 2026-04-17.
- **What QUORUM uses it for**: pitch-level ecosystem context only ("agent economy has a trust crisis"). Not a runtime data source for agent logic.

## 3b. x402 Payment Index (`payments.db`)

- **Size at lock 2026-04-30 16:10 UTC**: 6,448,184 raw Base x402 payment candidates over an 18.4-day window (2026-04-12 09:05 → 2026-04-30 18:02 UTC).
- **After wash filter**: 3,409,612 clean payments (47.1% removed as self-referential / dust / burst-pattern noise).
- **Classified subset** (`is_facilitator_mediated IS NOT NULL` within clean): 511,716 = 15.01% of clean. Of those: 169,740 mediated (=1) / 341,976 P2P (=0).
- **Wallet diversity (clean)**: 439,113 distinct from-wallets, 408,859 distinct to-wallets.
- **Mean payment**: $1.14.
- **Backfill progress note**: 13.0% (29.04 09:19 UTC) → 15.01% (30.04 16:10 UTC). Monotonic backfill against Base RPC `eth_getTransactionByHash`; the gap to 100% is a backfill rate problem, not a query problem. The 29.04 lock published at smartflowproai.substack.com (commit `550cf5e`) is superseded by `lockfile-2026-04-30-evening.json`.

## 4. ERC-8004 Registry (read via 8004scan API)

- **Snapshot**: 151,370 agents registered as of 2026-04-17.
- **Chains**: Base + Ethereum (ERC-8004 canonical deployments).
- **What QUORUM uses it for**: self-registration. QUORUM's five agents (Scout / Judge / Verifier / Executor / Treasurer) each register on ERC-8004 Day 7, making the agent mesh discoverable in the same registry judges and external agents are watching.
- **What QUORUM does NOT do**: lookup Solana memecoin contract deployers in ERC-8004. The 151K registry is dominated by AI agents, MCP servers, and infrastructure — not memecoin deployer addresses. That cross-reference would fire on <1% of cases.

---

## Why this document exists

Data-honesty is a submission asset, not a liability. The v1 blueprint of this project conflated the 231K EVM wallet graph with Solana detection in several places; that would have been the single most dangerous honesty gap in the submission. v2 (audited 2026-04-17) split every data claim by chain, added the bridge-linker as the explicit mechanism that makes the two datasets talk, and produced this document for reviewer diligence.

Any README line, demo voiceover sentence, or partner write-up paragraph that implies a single combined number across chains without naming the bridge-linker step is **wrong**. Report via issue if you find one.

## Cross-chain claim protocol

Whenever a claim combines the EVM and Solana datasets, it must:

1. Name the **bridge** (Wormhole / deBridge / Allbridge) and the **direction** (Solana → EVM buyer lookup).
2. Cite the **hit rate** (measured, not assumed) of the bridge-linker on the observation window.
3. State whether the claim stands **if the cross-chain feature is removed** (Solana-native baseline).

If a claim fails any of the three tests, it must be rewritten or dropped.
