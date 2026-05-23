# QUORUM

A 5-agent governance / consensus mesh that pays per call in x402, posts signed verdicts to Base mainnet, and runs across two physical hosts.

MIT · `quorum.smartflowproai.com` · built by Tom Smart

[![CI](https://github.com/smartflowproai-lang/quorum/actions/workflows/ci.yml/badge.svg)](https://github.com/smartflowproai-lang/quorum/actions)

<!-- LIVE-STATS:START -->
**Live:** 1 streaming-receipts cycle · 0.9985 USDC paid through · 28 days uptime · 12.41% wash-classified share on last-14d traffic · last attestation [`0x19bb1d0e…`](https://basescan.org/tx/0x19bb1d0eb990de5152c753e185cd44bca3bf7445abafa982132263a0e1763f22) · _refreshed 2026-05-23T04:00:01Z_ — see [`public/live-stats.json`](public/live-stats.json)
<!-- LIVE-STATS:END -->

---

## Status

Built during ETHGlobal Open Agents (April–May 2026). Submitted, demoed at Finale 2026-05-06 — did not place. Open-sourcing the codebase here so the bits that work are reusable.

What this repo is: a working reference for wiring 5 cooperating agents across two VPSes, paying each other through x402, calling KeeperHub MCP, and anchoring evidence on Base. What it is not: a polished product. Edges are rough; some pieces are scaffolds with tests against an aspirational API. Caveats called out inline below.

---

## What's in the box

```
Scout ──► Judge ──► Verifier ──► Executor ──► Base attestation
                                     ▲
                                     │ x402 gas
                                  Treasurer
```

| Agent     | Role                                                                                              | What's real                                                              |
|-----------|---------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| Scout     | Watches Solana smart-money wallets, cross-refs EVM bridge graph                                   | Helius WS client + bridge-linker scaffold; 8 tests                       |
| Judge     | 10-feature classifier (6 Solana-native, 2 cross-chain, 2 token-structural)                        | Backtest harness; precision targets documented in `DATA-COVERAGE.md`     |
| Verifier  | Validates Judge verdicts against on-chain reality before attestation                              | 44 passing tests (schema, ed25519, ERC-8004 roundtrip, replay rejection) |
| Executor  | Posts attestations to Base via KeeperHub MCP `call_workflow`                                      | Live MCP session converged ok=11/12; settlement TX on-chain              |
| Treasurer | Holds USDC float, pays per-call in x402, swaps via Uniswap (thin client)                         | 1 supervised swap on-chain; 7-test aspirational suite for the client     |

CI runs `npm test --if-present` per agent. 80 tests across 4 agents.

---

## On-chain receipts (Base mainnet, chainId 8453)

All three from Treasurer wallet `0xd779cE46…58C893` — EIP-7702 set-code delegate (`eth_getCode` returns the `0xef0100…` prefix, captured in `logs/d10-eth-getcode-treasurer.json`).

1. **Verdict attestation** — [`0x19bb1d0e…`](https://basescan.org/tx/0x19bb1d0eb990de5152c753e185cd44bca3bf7445abafa982132263a0e1763f22) (block 45,476,871). Calldata-only TX holding canonical evidence hash signed independently by Judge ed25519 + Verifier ed25519. Both pubkeys + sigs embedded; verifiable via `agents/treasurer/scripts/decode-attestation-tx.mjs`. Per-host long-lived keys now provisioned by `infra/deploy-vps.sh` (`agents/judge/keys/host-frankfurt.{pub,sec}` on Frankfurt, `agents/verifier/keys/host-nyc.{pub,sec}` on NYC); dry-run sample via `agents/treasurer/scripts/sample-attestation-long-lived.mjs` builds the QUORUMV1 calldata + verifies both signatures inline without spending gas.
2. **KH x402 settlement** — [`0xce40d380…`](https://basescan.org/tx/0xce40d3804a8b057813193b34839e63c6da0e994bd6a794e81382209e416d4409) (block 45,478,048). 0.10 USDC = 100,000 atomic per `challenge.accepts[0]` from KH MCP. Treasurer → KH `payTo` `0xf591c99c…3709544`. Spec-conformant `x402v2 scheme=exact` payment leg landed.
3. **Treasurer swap** — [`0xc03b8350…`](https://basescan.org/tx/0xc03b8350c982c805e5e2b4aa072fb69138e26c2364b7a70c3ef3b34079b49849) (block 45,300,516). 1 USDC → WETH via Permit2 + Universal Router, routed through the EIP-7702 delegate. Manual supervised receipt; programmatic loop deferred for wallet-isolation reasons.

---

## Cross-continent mesh

Two physical hosts: VPS Frankfurt (Scout + Judge) and VPS New York (Verifier + Executor + Treasurer). Bidirectional AXL roundtrip verified Day 1 (commit [`777cc08`](https://github.com/smartflowproai-lang/quorum/commit/777cc08cd7fc09cefe52f91c9024d33e6b30d922), see `infra/axl-hello.sh` + `logs/d1-axl-mesh-live.log`). Chaos test artifact in `infra/chaos-axl-failover.sh` + `logs/d8-chaos-recovery.log`.

Same-host process-to-process is not what AXL is for. If you only have one box, the mesh layer is overkill — see the single-agent path below.

---

## Five ways to use it

### 1. Local 5-agent stack (Docker)

The fastest way to see it run. Spins up all five agents on one host (no AXL mesh — that's path 5).

```bash
git clone https://github.com/smartflowproai-lang/quorum.git
cd quorum
cp .env.example .env       # fill in RPC URLs + wallet keys
docker compose up
```

`docker-compose.yml` wires the agents together over a local bridge network. Logs stream to stdout; receipts land in `logs/`.

### 2. Run a single agent (npm)

If you want to embed one piece — say, just the Verifier — into your own stack.

```bash
cd agents/verifier
npm install
npm run build
npm test                   # 44 tests (verifier; counts vary per agent)
npm start                  # reads config from ../../.env
```

Same shape for `agents/scout`, `agents/judge`, `agents/executor`, `agents/treasurer`. Each has its own `package.json` and is independently runnable.

### 3. KeeperHub MCP integration

The Executor uses KeeperHub's MCP server to post attestations and pay for calls in x402. The wire client is in `agents/executor/keeperhub-wire/`. To replay a live MCP session against `app.keeperhub.com`:

```bash
cd agents/executor
npm install
node keeperhub-wire/dist/cli.js \
  --endpoint https://app.keeperhub.com/mcp \
  --workflow pack-0-10-demo
```

Logs in `logs/d6-keeperhub-wire-verify.log` (Sepolia testnet) and `logs/d8-kh-x402-challenge-response.json` (Base mainnet paid challenge). Field mapping note: KH uses `asset`/`network`; QUORUM's `X402Challenge` type uses `tokenAddress`/`chainId`. Normalized in the wire client.

### 4. x402 client (Treasurer)

If you only want the x402 payment leg — pay 0.10 USDC against a KH challenge, get back the response — use the Treasurer client directly:

```bash
cd agents/treasurer
npm install
node scripts/pay-x402-challenge.mjs <challenge-json-path>
```

Settlement TX format documented in `logs/d10-kh-paid-settlement-tx.json`. The client is a thin forwarder over `viem`; the 7-test suite in `test/uniswap-client.test.ts` describes the typed-error / Zod / TTL shape the swap path enforces. The programmatic top-up loop now runs weekly (1 USDC → WETH on Base, Mon 09:00 UTC) via `agents/treasurer/scripts/swap-usdc-weth.mjs` — see [`infra/programmatic-swap-weekly.sh`](infra/programmatic-swap-weekly.sh) and the per-week receipts in `logs/d12-programmatic-swap-week{1..4}.json`.

### 5. Cross-host AXL mesh (self-host)

The setup the receipts above were captured on. Two VPSes (Frankfurt + NYC), AXL between them, agents pinned to roles per host.

```bash
# on each host
./infra/deploy-vps.sh <role>     # role ∈ {scout,judge,verifier,executor,treasurer}

# from either host, smoke-test the mesh
./infra/axl-hello.sh
```

`deploy-vps.sh` provisions Docker, installs the agent for the given role, and brings up the AXL endpoint. Mesh state in `logs/d8-axl-mesh-current-state.json`. Expect to spend time on firewall + AXL keypair distribution; the script handles the agent layer, not your VPS auth.

---

## Verifying a verdict on-chain

Anyone can decode an attestation TX and check both ed25519 signatures:

```bash
npm i viem
node agents/treasurer/scripts/decode-attestation-tx.mjs 0x19bb1d0eb990de5152c753e185cd44bca3bf7445abafa982132263a0e1763f22
```

Output format in `logs/d10-quorum-attestation-tx.json`. No QUORUM-side state required — reads directly from any RPC.

---

## What's rough

Calling out the gaps so you don't trip over them.

- ~~**Per-host signing keys deferred.**~~ Long-lived per-host ed25519 keypairs now live at `agents/judge/keys/host-frankfurt.{pub,sec}` (Frankfurt) and `agents/verifier/keys/host-nyc.{pub,sec}` (NYC). `infra/deploy-vps.sh` provisions them idempotently — first run generates, subsequent runs reuse so the on-chain identity is stable across attestations. Shared loader at `shared/host-keys.ts` runs an ed25519-only + keypair self-check at load time; sign-verify roundtrip covered by 2 dedicated tests in `agents/verifier/verifier.test.ts`. Secret halves are gitignored and chmod 600; pubkeys are committable.
- ~~**Treasurer swap loop deferred.**~~ Programmatic loop runs unattended on cron — `/etc/cron.d/quorum-weekly-swap` fires `infra/programmatic-swap-weekly.sh` every Monday 09:00 UTC, swapping 1 USDC → WETH via the Uniswap Trading API (Universal Router + Permit2). First fire scheduled 2026-05-18 09:00 UTC; validation target is 4 consecutive weekly swaps (week-N receipts land in `logs/d12-programmatic-swap-weekN.json`). Initial dry-run on 2026-05-11 confirmed budget (ETH=0.0022, USDC=53.01) and writes the same JSON shape live runs emit; see `logs/d12-programmatic-swap-week1.json`.
- ~~**Judge classifier is backtest-target precision, not measured-on-live precision.**~~ Live-measured on rolling 14-day x402 window (2026-04-27 → 2026-05-11, 6,274,320 payments, 2,683,070 labeled). Facilitator-mediation classifier: precision **1.0000** / recall **1.0000** full-whitelist (self-consistency over 2.68 M live txs); precision 1.0000 / recall **0.7941** hardcoded-only holdout (5 Coinbase CDP addresses) — the 7 pattern-inferred facilitators contribute 20.58 % of mediated traffic. Wash classifier: 12.41 % wash-flagged, rule-share R3_dust 48.82 % / R4_loop 25.71 % / R2_burst 25.21 % / R1_self 0.25 %. Numbers and methodology in `DATA-COVERAGE.md` §5; wash-classifier ground-truth precision gated on schema split (`wash_flag IS NULL` currently conflates clean with unprocessed — disclosed honestly, not hand-waved).
- **Indexer coverage is partial.** Classified-subset rate was 13.0% at submission, 20.21% two days later (lockfiles in repo). Same `wash_flag IS NULL` denominator throughout. Public retraction of an earlier wrong number (32.7% → 13.0%) is in commit `550cf5e`.
- **KH MCP debugging is finicky.** First 5 sessions ran ok=0/12 before auth + host resolution were sorted. The wire client documents the path; expect to spend time on auth.

---

## Read more

- [DATA-COVERAGE.md](./DATA-COVERAGE.md) — dataset boundaries
- [CHAOS-TEST.md](./CHAOS-TEST.md) — failover test harness
- [archive/hackathon/SUBMISSION.md](./archive/hackathon/SUBMISSION.md) — full hackathon writeup, partner integrations
- [archive/hackathon/](./archive/hackathon/) — sponsor feedback files (Uniswap / KeeperHub / Gensyn) and judge intro

---

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgments

Built solo by Tom Smart ([@TomSmart_ai](https://x.com/TomSmart_ai)) during ETHGlobal Open Agents 2026. Claude Code (Anthropic) used as a coding assistant for scaffolding, review, and documentation; architecture, integration debugging, on-chain decisions, and shipping calls are mine.
