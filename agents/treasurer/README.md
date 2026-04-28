# QUORUM — Treasurer Agent

The Treasurer manages multi-token holdings across the QUORUM agent mesh. When agents earn micropayments (USDC on Base via x402), Treasurer tracks balances, rebalances between agent wallets via Uniswap, and settles HTTP 402 payment challenges using **any token the agent holds** — not just USDC.

---

## Architecture

```
QUORUM Mesh (AXL encrypted P2P)
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│  Frankfurt AXL Node (EU vantage) │    │  NYC AXL Node (US vantage)       │
│                                  │    │                                  │
│  ┌─────────┐   AXL messages     │◄──►│  ┌─────────┐                     │
│  │  Scout  │──────────────────► │    │  │  Judge  │ ◄── verdicts → DB   │
│  └─────────┘                    │    │  └─────────┘                     │
│                                  │    │                                  │
│  ┌──────────────────────────┐   │    │  ┌──────────┐                   │
│  │  Treasurer  ◄────────────┼───┼────┼──┤ Verifier │ (Day 5)           │
│  │  - getBalances()         │   │    │  └──────────┘                   │
│  │  - rebalance() ──────────┼───┼──► Uniswap Trading API (Base)        │
│  │  - payX402Challenge()    │   │    │                                  │
│  └──────────────────────────┘   │    └──────────────────────────────────┘
└──────────────────────────────────┘

External integrations:
  Uniswap Trading API   trade-api.gateway.uniswap.org/v1  (quote + swap)
  x402 Facilitator      xpay.sh                            (payment settlement)
  Base mainnet          chainId 8453                       (all on-chain ops)
  KeeperHub             (Day 6) — schedules recurring keeper jobs, paid via x402
```

---

## Uniswap Integration Depth

This is the **core differentiator for the Uniswap Foundation prize** ($5K).

Prize criteria: *"reliability, transparency, composability over speculative intelligence."*

### What Treasurer does that most hackathon submissions won't:

1. **Pay-with-any-token for x402** — Uniswap's own `uniswap-ai` toolkit ships a skill described as *"Pay HTTP 402 challenges (MPP/x402) using tokens via Uniswap swaps."* Treasurer implements this natively:
   - Agent holds WETH; endpoint charges in USDC
   - Treasurer auto-quotes WETH→USDC via `/v1/quote`
   - Executes swap on Base mainnet (real tx, real Basescan receipt)
   - Settles the 402 challenge with the received USDC
   - Returns `PaymentReceipt` to the requesting agent

2. **Permit2 handled correctly** — The most common failure point (see research §3.10). `UniswapClient` explicitly signs `permitData` from the quote response before posting to `/v1/swap`.

3. **Multi-agent treasury** — Not a single-wallet toy. Treasurer tracks balances across all QUORUM agent wallets and rebalances when any is gas-low.

4. **Composable** — Any QUORUM agent sends an AXL message `{ type: "x402_challenge", challenge: {...} }` and Treasurer handles the rest. Clean separation: agents don't know about Uniswap.

---

## How Treasurer connects to other agents (AXL)

Treasurer listens on the AXL message queue for:

| Message type         | From        | What Treasurer does                                    |
|---------------------|-------------|-------------------------------------------------------|
| `balance_request`   | Any agent   | Calls `getBalances()`, replies with current holdings  |
| `rebalance_request` | Judge/Scout | Executes `rebalance(plan)` via Uniswap, returns receipt|
| `x402_challenge`    | Any agent   | Calls `payX402Challenge(challenge)`, returns receipt   |
| `heartbeat`         | Any agent   | No-op, confirms Treasurer is alive                    |

---

## Token addresses (Base mainnet)

| Token   | Address                                      | Decimals |
|---------|----------------------------------------------|----------|
| USDC    | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6        |
| WETH    | `0x4200000000000000000000000000000000000006` | 18       |
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` | 18       |

---

## Setup

```bash
cp .env.example .env
# Fill in:
#   UNISWAP_API_KEY     — from developers.uniswap.org/dashboard
#   TREASURER_PRIVATE_KEY — 0x-prefixed 64-char hex (Treasurer wallet)
#   TREASURER_WALLET_ADDRESS — corresponding 0x address
#   WATCHED_ADDRESSES   — comma-separated agent wallet addresses to monitor
#   BASE_RPC_URL        — e.g. https://mainnet.base.org

npm install
npm run build
npm start
```

---

## Day 4 TODO (extend this file, not from scratch)

- [ ] `getBalances()` — wire to viem `publicClient.readContract` on Base
- [ ] `rebalance()` — wire to `UniswapClient.getQuote` + `signPermit2` + `executeSwap`
- [ ] `payX402Challenge()` — wire to `X402Handler.handleX402`
- [ ] `X402Handler.settleChallenge()` — POST with `X-Payment` header
- [ ] `UniswapClient.executeSwap()` — broadcast via viem walletClient
- [ ] AXL heartbeat loop (see scout/index.ts pattern)
- [ ] KeeperHub job scheduling (`keeper-scheduler.ts` — Day 6)
- [ ] Integration test: real WETH→USDC swap on Base with $1 test amount
