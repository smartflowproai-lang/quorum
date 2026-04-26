# QUORUM — ETHGlobal OpenAgents submission

**Builder**: Tom Smart ([@TomSmart_ai](https://x.com/TomSmart_ai))
**Repo**: https://github.com/smartflowproai-lang/quorum
**Build window**: 2026-04-24 → 2026-05-03
**Partners I'm shipping for**: Gensyn AXL · KeeperHub · Uniswap Foundation

---

## What I built

Four agents, two continents, one encrypted mesh, one verdict per Solana memecoin candidate. Scout watches 14 curated Solana smart-money wallets in Frankfurt, Judge scores candidates against an 18-day archive of 58,432 copy-bot events, Executor lands attestations on Base via KeeperHub, Treasurer pays for every job with x402 and tops itself up via the Uniswap Trading API. Every agent has a separate ed25519 identity on the Gensyn AXL mesh and gets paid (or pays) on a per-message basis. No central broker, no shared wallet, no human in the gas loop.

The mesh is the point. Most "multi-agent" demos run four functions in one process and call it a system. QUORUM physically separates Scout/Judge in Frankfurt from Executor/Treasurer in NYC — when I take the NYC node down mid-verdict, Frankfurt keeps producing candidates, queues messages, and drains them on reconnect. The chaos test in `infra/chaos.sh` is the part I'd pin if a judge only had two minutes.

---

## How I used each partner

### Gensyn AXL — the spine

Every agent boots with a stable ed25519 keypair. Messages are typed (`candidate`, `verdict`, `attestation`, `gas_request`, `settlement`) and ULID-deduped at the receiver, so reconnect storms don't double-count. Frankfurt and NYC hosts peer over TLS port 9001 on Yggdrasil, signed at L7. I shipped a typed TypeScript wrapper around the AXL HTTP interface in `shared/axl-wrap.ts` — about 120 lines, MIT-licensed, reusable by any team. The bidirectional roundtrip evidence is in `d1-init` commit logs (2026-04-22, signed messages crossing the Atlantic both ways).

### KeeperHub — the lander

Executor never calls `sendTransaction` directly. Every attestation goes through KeeperHub's scheduled-tx primitive. During Base gas spikes — which happen exactly when memecoin pump events make verdicts most urgent — the scheduler retries with updated gas estimates while my Executor code stays put. The 402 → x402 token → retry cycle runs without operator approval. I'm running the integration continuously through the demo window and logging every friction point to `FEEDBACK-KeeperHub.md` for the $500 KH bounty.

### Uniswap Foundation — the float manager

Here's where the post-99.82%-retraction discipline kicks in. I'm not claiming Treasurer is moving meaningful volume yet. What I am claiming, with on-chain receipts:

- Treasurer holds a small USDC float on Base (mainnet, address `0xd779cE46567d21b9918F24f0640cA5Ad6058C893`)
- When the float drops below threshold, it calls the Uniswap Trading API for an `EXACT_INPUT` quote, signs Permit2, posts to `/v1/swap`, broadcasts on Base
- Every swap produces a Basescan receipt — pointer in `agents/treasurer/payments.db` once Day-6 wiring lands

The interesting positioning isn't the volume — it's the integration shape. Treasurer demonstrates pay-with-any-token end-to-end on real x402 traffic: an autonomous agent that converts whatever it has into whatever the next service wants, on demand, without a human signing anything. That maps directly onto the Uniswap Trading API's stated design intent.

Real x402 traffic context (public x402scan data, 2026-04-26 snapshot):
- ~22,000 x402 endpoints registered on the index
- ~2.36M Base x402 micropayments since the 2026-04-12 facilitator launch
- ~5,804 distinct EOAs paying or being paid through the rail

Pay-with-any-token sits in front of that traffic. Treasurer is one agent on the rail today — the goal isn't to be the only one, it's to be the reference shape for the next thousand.

`FEEDBACK-UNISWAP.md` documents the integration friction I hit (Permit2 primaryType ambiguity, Base chainId vs Sepolia confusion, EXACT_OUTPUT semantics for x402 use cases, undocumented protocol selection defaults, and more). Targeting the $250 partner-feedback bounty.

---

## What I learned

The hard part wasn't any one integration — it was the message-passing contracts between four agents that fail in different ways. Scout failing on a Helius reconnect can't freeze Judge. Judge taking 800ms can't stall Executor on the next verdict. Treasurer running dry can't lose Executor's gas request — it has to queue, drain on rebalance, and tell Executor exactly when to retry. Building this with AXL's queue-on-disconnect semantics forced explicit failure handling at every edge. That discipline is what separates a four-process toy from infrastructure.

The unfair edge isn't the architecture; it's the data. The Solana copy-bot archive and the EVM wallet graph predate the hackathon — they're public, pre-existing infrastructure I was already running. Time-series like that you cannot ship in ten days.

---

## What's next

The natural next surface is `quorum/submit-verdict` as an MCP tool — any external agent (ElizaOS, OpenClaw, CrewAI) calls into Executor, Treasurer pays the gas via x402 in whatever the caller funded them with, attestation lands on Base. That converts QUORUM from a closed pipeline into a shared on-chain primitive. Pay-with-any-token is what makes that commercially feasible — without it, every external agent would need its own Base USDC float and its own KeeperHub subscription. With it, they fund one channel and Treasurer takes care of the conversion math.

---

## Repository pointers

| Path | What's there |
|------|---------------|
| `agents/scout/`     | Frankfurt — Helius WS client, 14-wallet subscriber, EVM bridge-linker scaffold |
| `agents/judge/`     | Frankfurt — 10-feature scorer, verdict emitter |
| `agents/executor/`  | NYC — KeeperHub client + x402 paymaster |
| `agents/treasurer/` | NYC — Uniswap Trading API client, USDC float manager |
| `agents/verifier/`  | Frankfurt — validates Judge verdicts, issues attestations (5-layer audited, 38 tests) |
| `shared/axl-wrap.ts`| Typed TypeScript wrapper around the AXL HTTP interface |
| `infra/chaos.sh`    | Partition recovery test — kills NYC node, measures reconverge |
| `FEEDBACK-UNISWAP.md`   | Uniswap Trading API feedback (≥6 specific items) |
| `FEEDBACK-KeeperHub.md` | KeeperHub integration feedback |
| `DATA-COVERAGE.md`  | Honest breakdown of what data backs which claim |

---

## Start Fresh + AI attribution

All QUORUM agent code in this repo was written between 2026-04-24 and 2026-05-03 inside the OpenAgents build window. The three external data sources Scout/Judge consume (Helius copy-bot stream, EVM wallet graph, x402 endpoint index) are pre-existing public infrastructure I was already running before the window opened — see `DATA-COVERAGE.md` for the breakdown.

I used Claude Code (Anthropic) for scaffolding, code review, and documentation drafting. Architectural decisions, partner-track positioning, scoring feature selection, and final approval are mine. Per-commit AI-assistance attribution lives in commit messages.

---

## Live demo + dashboard

- Repo: https://github.com/smartflowproai-lang/quorum
- Methodology + write-ups: https://smartflowproai.substack.com
- Dashboard: https://quorum.smartflowproai.com (active from Day-5 deploy)
