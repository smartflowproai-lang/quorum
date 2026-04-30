# QUORUM — judge intro (read this first, ~60 seconds)

**One line.** Five agents on a two-continent encrypted mesh, paying each other in x402, posting signed rug verdicts to Base mainnet — Scout + Judge in Frankfurt, Verifier + Executor + Treasurer in NYC.

**Why now.** The x402 agent economy is real Base traffic — 6.41M raw payment candidates indexed across an 18-day window, 22,056 endpoints catalogued (numbers verified live against `payments.db` + `mapper.db`, methodology in `DATA-COVERAGE.md`). What's missing is multi-continent verification: most "multi-agent" demos run four functions in one process. QUORUM physically separates verdict production (Frankfurt) from validation + settlement (NYC) and signs the roundtrip — which is the shape the next thousand agent-pipelines will need.

## Five differentiators (each with a hard anchor)

1. **Multi-continent AXL mesh, signed bidirectional roundtrip.** Frankfurt + NYC, both AXL nodes PM2-wrapped, peered over TLS:9001 on Yggdrasil since 2026-04-22. Anchor: commit [`777cc08`](https://github.com/smartflowproai-lang/quorum/commit/777cc08), `infra/axl-hello.sh`, `logs/d1-axl-mesh-live.log` (Frankfurt pubkey `68d7077e…`, NYC inbound peer recorded).

2. **On-chain mainnet receipt — not a testnet screenshot.** Treasurer wallet `0xd779cE46…58C893` swapped 1 USDC → WETH via Universal Router + Permit2. Anchor: tx [`0xc03b8350…79b49849`](https://basescan.org/tx/0xc03b8350c982c805e5e2b4aa072fb69138e26c2364b7a70c3ef3b34079b49849), block 45,300,516, chainId 8453, verified via `eth_getTransactionByHash` against `mainnet.base.org`.

3. **Retraction discipline as a build asset.** I caught a numerator/denominator filter mismatch in the data-coverage figures and shipped the correction publicly: 32.7% → 13.0%, then 14.5% as backfill progressed. Anchor: commit [`550cf5e`](https://github.com/smartflowproai-lang/quorum/commit/550cf5e) `fix: correct classified subset 32.7% → 13.0%`.

4. **DATA-COVERAGE.md transparency split.** Every dataset is broken down by chain, scope, and what the project does NOT claim. Anchor: `DATA-COVERAGE.md` — EVM wallet graph (231,633 addresses, 100% EVM, zero Solana), Solana copy-bot archive (58,432 events, 14 curated wallets), x402 mapper (99.9% EVM / 0.78% Solana).

5. **Verifier hardened independently.** 38 unit tests covering schema validation, ed25519 signature recovery, ERC-8004 payload roundtrip, replay-attack rejection, partition-recovery. Anchor: commit [`19d47bf`](https://github.com/smartflowproai-lang/quorum/commit/19d47bf), `agents/verifier/verifier.test.ts`, CI green.

## Where to dig

- Commit history: `git log --oneline` on `main` — every commit AI-attributed inline.
- Mesh evidence: `logs/d1-axl-mesh-live.log`, `infra/axl-hello.sh`.
- Partner feedback (bounty submissions): `FEEDBACK-GENSYN.md`, `FEEDBACK-UNISWAP.md`, `FEEDBACK-KeeperHub.md`.
- Honest data scope: `DATA-COVERAGE.md`.
- Full writeup: `SUBMISSION.md`.
