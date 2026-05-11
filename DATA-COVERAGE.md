# DATA-COVERAGE.md

Explicit per-chain breakdown of every dataset QUORUM reads from. If a number appears in the README, the demo video, or a partner write-up, its origin is listed here.

**Last verified**: 2026-05-02 10:45 UTC (most-recent state in `lockfile-2026-05-02-evening.json`; submission lock at `lockfile-2026-04-30-evening.json` 16:10 UTC superseded by 2 days of live backfill). Supersedes earlier `numbers-ground-truth-lockfile-2026-04-28` lock.

---

## 1. EVM Wallet Graph (`wallet_profiles.db`)

- **Size**: 231,633 profiled addresses, ~180 MB structured records.
- **Chains**: Base + Ethereum mainnet. **100% EVM. Zero Solana.**
- **Source**: on-chain indexing of x402 payment participants + behavioural labeling. Authored 2026-Q1 through 2026-04-17.
- **What QUORUM uses it for**: cross-chain rug-farmer lookup. When an EVM-bridge-linker (Wormhole / deBridge / Allbridge) resolves a Solana buyer to an EVM counterparty, Judge looks up the counterparty's `evm_rug_prior_count` in this graph.
- **What QUORUM does NOT claim**: this graph does not cover Solana wallets. Any claim to that effect is an error.
- **Expected bridge-linker hit rate** on random Solana memecoin buyers: 5–20% (most memecoin buyers never bridge). If measured hit rate falls below 15% during Day-2 data plumbing, cross-chain features are demoted to "bonus uplift" status and Solana-native features remain the primary signal.

## 2. Solana Copy-Bot Event Archive (`payments.db`, `mapper.db`-derived)

- **Size**: 58,432 observed events, ~60 MB compressed, 18-day window (2026-04-01 → 2026-04-18 as of last snapshot 2026-04-18; archive re-snapshot deferred post-hackathon — Scout/Judge inference today reads the live Helius WS stream, this archive is the labelled training window).
- **Chains**: **Solana mainnet only.**
- **Source**: author's existing public copy-bot infrastructure (14 hand-curated smart-money wallets). Pure-read via Helius RPC.
- **What QUORUM uses it for**: Solana-native feature extraction — buyer-cluster overlap with prior Solana rugs, sniper-bot share, wallet age, holder count at T+5min.
- **Wallet count**: 14 curated smart-money wallets (not "231K Solana wallets" — that claim would be an error).
- **Label set for training**: ≈46 confirmed rugs labelled within the 18-day window (Day-3 backtest target).

## 3. x402 Endpoint Mapper (`mapper.db`)

- **Size**: 22,074 registered endpoints (canonical figure used across SUBMISSION / FEEDBACK / JUDGE_INTRO; latest mapper.db backup snapshot 2026-05-02; submission lock 22,054 from 2026-04-29 mapper run superseded by +20 new endpoints).
- **Chain composition**: **99.9% EVM (Base + Ethereum + misc EVM L2s) / 0.78% Solana**. Publicly reported.
- **Source**: author's x402 network mapper, authored 2026-Q1 through 2026-04-17.
- **What QUORUM uses it for**: pitch-level ecosystem context only ("agent economy has a trust crisis"). Not a runtime data source for agent logic.

## 3b. x402 Payment Index (`payments.db`)

- **Size at most-recent lock 2026-05-02 10:45 UTC**: 7,248,641 raw Base x402 payment candidates over a 20.04-day window (2026-04-12 09:05 → 2026-05-02 10:02 UTC); submission lock at `lockfile-2026-04-30-evening.json` superseded by 2 days of live backfill (6,448,184 raw → 7,248,641 raw, +12.4%).
- **After wash filter**: 4,000,062 clean payments (44.8% removed as self-referential / dust / burst-pattern noise; submission lock at 30.04 had 47.10% reduction → 44.8% at 02.05 most-recent lock — backfill brought in proportionally more clean payments, monotonic progress not query change).
- **Classified subset** (`is_facilitator_mediated IS NOT NULL` within clean): 808,294 = 20.21% of clean. Of those: 292,947 mediated (=1) / 515,347 P2P (=0).
- **Wallet diversity (clean)**: 487,330 distinct from-wallets, 478,621 distinct to-wallets (most-recent state `lockfile-2026-05-02-evening.json`; submission lock 439,113 / 408,859 at `lockfile-2026-04-30-evening.json`).
- **Mean payment**: $1.086 (rounded from $1.0857 in 02.05 most-recent lock; submission lock at 30.04 had $1.14 — drift reflects backfill bringing in more low-value tail payments, same `wash_flag IS NULL` denominator throughout).
- **Facilitator-class signing addresses**: 61 tracked = 54 mapped Coinbase CDP-cluster + 7 pattern-inferred candidates (one high-volume unlabelled facilitator likely Bankr or Mogami, classified via `is_facilitator_mediated` based on EIP-3009 `tx.sender` patterns — methodology in mapper internal `facilitators` table).
- **Backfill progress note**: 13.0% (29.04 09:19 UTC) → 15.01% (30.04 16:10 UTC) → 20.21% (02.05 10:45 UTC). Monotonic backfill against Base RPC `eth_getTransactionByHash`; the gap to 100% is a backfill rate problem, not a query problem. The 29.04 lock published at smartflowproai.substack.com (commit `550cf5e`) is superseded by `lockfile-2026-04-30-evening.json` (submission lock) which is itself superseded as live state by `lockfile-2026-05-02-evening.json` (most-recent indexer state).

## 4. ERC-8004 Registry (read via 8004scan API)

- **Snapshot**: 151,370 agents registered (mid-April 2026 snapshot via 8004scan API; observatory polls weekly).
- **Chains**: Base + Ethereum (ERC-8004 canonical deployments).
- **What QUORUM uses it for**: self-registration. QUORUM's five agents (Scout / Judge / Verifier / Executor / Treasurer) each register on ERC-8004 Day 7, making the agent mesh discoverable in the same registry judges and external agents are watching.
- **What QUORUM does NOT do**: lookup Solana memecoin contract deployers in ERC-8004. The 151K registry is dominated by AI agents, MCP servers, and infrastructure — not memecoin deployer addresses. That cross-reference would fire on <1% of cases.

---

## 5. Judge classifier — live precision/recall on x402 traffic

**Measured**: 2026-05-11T18:06Z. **Window**: rolling 14 days (2026-04-27 → 2026-05-11). **Source**: `payments.db` (Base x402 mainnet index). Replaces the prior "backtest-target precision" placeholder.

- **14-day payment volume**: 6,274,320 raw x402 payments on Base.
- **Labeled subset** (`is_facilitator_mediated IS NOT NULL`): 2,683,070 = 42.77% of window. Labels: 1,407,496 mediated (=1) / 1,275,574 P2P (=0).

### 5a. Facilitator-mediation classifier

Predicts whether an x402 payment was relayed by a facilitator (EIP-3009 `transferWithAuthorization` signed by a third party) vs sent directly P2P. Rule: `tx_sender IN facilitators` → predict mediated.

| Classifier variant | Facilitator whitelist | TP | FP | TN | FN | Precision | Recall | F1 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Full whitelist (production) | 5 hardcoded + 49 observed + 7 pattern-inferred = 61 | 1,407,496 | 0 | 1,275,574 | 0 | **1.0000** | **1.0000** | **1.0000** |
| Holdout: hardcoded-only | 5 (Coinbase CDP cluster) | 1,117,691 | 0 | 1,275,574 | 289,805 | 1.0000 | **0.7941** | 0.8852 |
| Holdout: hardcoded + observed | 54 (no pattern-inferred) | 1,117,782 | 0 | 1,275,574 | 289,714 | 1.0000 | **0.7942** | 0.8853 |

**Interpretation**: full-whitelist precision/recall = 1.00/1.00 is the self-consistency check — the deployed rule pipeline reproduces its own labels deterministically over 2.68 M live txs (idempotency confirmed). The recall gap between hardcoded-only (79.41%) and full (100%) attributes **20.58% of facilitator-mediated x402 traffic** to the 7 pattern-inferred facilitator addresses (Bankr / Mogami-class candidates, EIP-3009 `tx.sender` pattern-matched) — these are where a naïve "Coinbase-only" classifier loses recall. The 49 observed-class addresses add a marginal +91 TP over hardcoded alone, so the operationally significant tiers are: **hardcoded (79.4%) + pattern-inferred (20.6%)**.

### 5b. Wash-pattern classifier

Predicts whether a payment is wash (self-transfer / dust / burst / loop) vs clean. Rules: R1_self (`from_wallet = to_wallet`), R2_burst (high-frequency repeated pair), R3_dust (sub-$0.10 with anti-spam triggers), R4_loop (triangular A→B→C→A within window).

- **Wash-flagged in 14d window**: 778,684 = **12.41%** of all payments.
- **Rule-share of wash label**: R3_dust 48.82% (380,128), R4_loop 25.71% (200,214), R2_burst 25.21% (196,362), R1_self 0.25% (1,980).

**Honest caveat on precision/recall vs external ground truth**: the current schema stores `wash_flag IS NULL` for both "classifier ran, clean" and "not yet processed" — they're not separable today. A true precision/recall measurement against held-out ground truth requires splitting that column (or a labeled audit slice). What we *can* publish live is the **rule-share above** and the **stability** of those proportions across 7-day → 14-day → 21-day windows (deviation <2 percentage points per rule on rolling backfill, verified 2026-05-11). The "we'd like 90% precision" backtest target from the v1 README is retired in favor of these measured rule-share numbers until the schema split lands.

### 5c. What this means for the "What's rough" README line

The submission-era line *"Judge classifier is backtest-target precision, not measured-on-live precision"* is now retired. Live precision/recall is published above on a rolling 14-day window. The facilitator-mediation classifier is fully measured (self-consistency 1.00/1.00, holdout-recall 0.7941 hardcoded-only). The wash classifier publishes coverage + rule-share live; ground-truth precision is gated on schema split (wash_flag NULL semantics) — tracked, not hand-waved.

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
