# QUORUM

Five agents on a multi-continent AXL mesh, paying each other in x402, posting rug verdicts to Base mainnet.

ETHGlobal OpenAgents · MIT · built by Tom Smart

[![CI](https://github.com/smartflowproai-lang/quorum/actions/workflows/ci.yml/badge.svg)](https://github.com/smartflowproai-lang/quorum/actions) · [Live status dashboard](https://smartflowproai-lang.github.io/quorum/) · [BaseScan attestation](https://basescan.org/tx/0x19bb1d0eb990de5152c753e185cd44bca3bf7445abafa982132263a0e1763f22) · [BaseScan swap](https://basescan.org/tx/0xc03b8350c982c805e5e2b4aa072fb69138e26c2364b7a70c3ef3b34079b49849)

---

## What a judge sees in 60 seconds

- **5 agents physically separated** across two continents — Scout + Judge in Frankfurt, Verifier + Executor + Treasurer in NYC. Not 5 functions in one process.
- **Verdicts signed twice** — Judge in Frankfurt + Verifier in NYC, both ed25519, both committed in the on-chain attestation payload before settlement.
- **1 live MCP session converged ok=11/12** vs `app.keeperhub.com` on read-only Sepolia-testnet workflow `zwarm-test-sepolia-balance-check` (5 prior sessions ok=0/12 debugging auth/host) + 62 stub iterations vs local harness validating idempotency, all logged at [`logs/d6-keeperhub-wire-verify.log`](./logs/d6-keeperhub-wire-verify.log). Plus 1 real x402 paid challenge captured live against Base-mainnet [`pack-0-10-demo` workflow](./logs/d8-kh-x402-challenge-response.json) at `app.keeperhub.com/mcp` (schema validated against QUORUM `X402Challenge` type, no settlement).
- **Real x402 challenge captured** from KH paid workflow at [`logs/d8-kh-x402-challenge-response.json`](./logs/d8-kh-x402-challenge-response.json) — schema matches QUORUM's `X402Challenge` type one-for-one (built before the challenge was captured).
- **Real chaos test artifact**: [`infra/chaos-axl-failover.sh`](./infra/chaos-axl-failover.sh) + [`logs/d8-chaos-recovery.log`](./logs/d8-chaos-recovery.log) + [`logs/d8-axl-mesh-current-state.json`](./logs/d8-axl-mesh-current-state.json) (live snapshot showing same Frankfurt pubkey two days after the test, mesh still ESTAB on port 58252 sequence 3282).
- **Live-active observatory, not a snapshot** — indexer kept backfilling between hackathon lockfiles: 13.0% (29.04) → 15.01% (30.04 lock at [`lockfile-2026-04-30-evening.json`](./lockfile-2026-04-30-evening.json)) → 20.21% (02.05 lock at [`lockfile-2026-05-02-evening.json`](./lockfile-2026-05-02-evening.json)). +5.2pt classified rate in 2 days. Same `wash_flag IS NULL` denominator throughout, growing with newly-indexed clean payments. Production-grade live indexer, not a one-shot hackathon snapshot.
- **Methodology before numbers** — public retraction at [Weekly Intel #2: I Published a Wrong Number](https://smartflowproai.substack.com), submission lock at [`lockfile-2026-04-30-evening.json`](./lockfile-2026-04-30-evening.json), most recent indexer state at [`lockfile-2026-05-02-evening.json`](./lockfile-2026-05-02-evening.json).

---

## On-chain receipt — Base mainnet

First Treasurer swap, 2026-04-28:

- **Verdict attestation TX (primary anchor)**: [`0x19bb1d0eb990de5152c753e185cd44bca3bf7445abafa982132263a0e1763f22`](https://basescan.org/tx/0x19bb1d0eb990de5152c753e185cd44bca3bf7445abafa982132263a0e1763f22) — block 45,476,871, ed25519-signed canonical evidence hash from Frankfurt Judge + NYC Verifier, anchored on Base mainnet via Treasurer 0-value calldata-only TX (decode format documented in `logs/d10-quorum-attestation-tx.json`).
- **Treasurer swap TX (Uniswap anchor)**: [`0xc03b8350c982c805e5e2b4aa072fb69138e26c2364b7a70c3ef3b34079b49849`](https://basescan.org/tx/0xc03b8350c982c805e5e2b4aa072fb69138e26c2364b7a70c3ef3b34079b49849) — 1 USDC → WETH via Universal Router + Permit2, real wallet, real money, real settlement (Day 4 receipt).
- **Treasurer wallet**: `0xd779cE46…58C893` — EIP-7702 smart EOA (Pectra set-code delegate, production-grade account abstraction, not legacy EOA)
- Block **45,300,516**, chainId **8453**
- 1 USDC → WETH via Universal Router + Permit2 — the same path Treasurer drives programmatically
- Verified live via `eth_getTransactionByHash` against `mainnet.base.org`

This isn't a testnet screenshot. Real Base mainnet, real USDC, real wallet (`0xd779cE46567d21b9918F24f0640cA5Ad6058C893`), end-to-end before Treasurer code drives it.

---

## Pipeline

```
Scout ──► Judge ──► Verifier ──► Executor ──► Base attestation
                                     ▲
                                     │ x402 gas
                                  Treasurer
```

| Agent | Role | Status |
|-------|------|--------|
| Scout | Watches 14 Solana smart-money wallets, cross-refs EVM bridge graph | Helius WS + bridge-linker scaffold (commit `dbf4367`) |
| Judge | 10-feature classifier (6 Solana-native, 2 cross-chain, 2 token-structural) | Backtest target ≥70% precision on Solana-native subset |
| Verifier | Validates Judge verdicts against on-chain reality before attestation | **38 tests, CI green** (`agents/verifier/verifier.test.ts`) |
| Executor | Posts attestations to Base via KeeperHub MCP `call_workflow` | First receipt on-chain (see above) |
| Treasurer | Holds USDC float, pays per-call in x402, swaps via Uniswap Trading API (thin forwarder) | **7-test aspirational suite** describing target API — typed errors + Zod + TTL + FetchLike injection (`agents/treasurer/test/uniswap-client.test.ts`); current client is a forwarder, implementation post-hackathon |

---

## Multi-continent AXL mesh

Two physical hosts: **VPS Frankfurt** and **VPS New York**. Bidirectional AXL roundtrip verified Day 1, signed messages crossing both ways — commit [`777cc08`](https://github.com/smartflowproai-lang/quorum/commit/777cc08cd7fc09cefe52f91c9024d33e6b30d922) (`infra/axl-hello.sh`, `logs/d1-axl-mesh-live.log`).

Cross-geography routing is real. Same-host process-to-process is not what AXL is for.

---

## Quick start

```bash
git clone https://github.com/smartflowproai-lang/quorum.git
cd quorum
cp .env.example .env                 # fill in RPC URLs + wallet keys
docker compose up                    # local 5-agent stack
./infra/axl-hello.sh                 # cross-Atlantic AXL roundtrip smoke test
```

For the cross-host deploy (Frankfurt + NYC), see `infra/deploy-vps.sh`.

---

## Discipline notes

- **Retraction discipline**: I caught a numerator/denominator filter mismatch in the data-coverage figures and shipped the correction publicly (commit `550cf5e`, classified-subset 32.7% → 13.0%). Backfill has progressed monotonically to 20.21% as of 2026-05-02 10:45 UTC (most-recent state in `lockfile-2026-05-02-evening.json`; submission lock at `lockfile-2026-04-30-evening.json` superseded by 2 days of live backfill). Numbers in this repo are corrected when they're wrong; history is logged inline at smartflowproai.substack.com.
- **Start Fresh**: every agent in this repo was written 2026-04-24 → 2026-05-03 inside the OpenAgents build window. The three public datasets I lean on (x402 mapper, EVM wallet graph, Solana copy-bot archive) are pre-existing public infra — see [DATA-COVERAGE.md](./DATA-COVERAGE.md) for the honest breakdown.

---

## Read more

- [SUBMISSION.md](./SUBMISSION.md) — judge-facing writeup, partner integrations, what works and what doesn't
- [DATA-COVERAGE.md](./DATA-COVERAGE.md) — what each dataset covers and what it doesn't
- [FEEDBACK-UNISWAP.md](./FEEDBACK-UNISWAP.md) — 7 integration friction points hit while building Treasurer (partner-feedback bounty)
- ETHGlobal showcase: posted post-submission (link added 2026-05-03)

---

## License + credits

MIT — see [LICENSE](./LICENSE).

Built by **Tom Smart** ([@TomSmart_ai](https://x.com/TomSmart_ai)) for ETHGlobal OpenAgents 2026.

AI assistance via Claude Code (Anthropic) — scaffolding, code review, documentation. All final design and integration decisions are mine. Per-commit AI-assistance attribution in git history.
