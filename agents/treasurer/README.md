# Treasurer

The Treasurer agent is QUORUM's float manager. It pays for KeeperHub jobs over x402, holds a small USDC buffer on Base, and tops itself up via the Uniswap Trading API when the float runs low. No human signs anything.

## What it does

- **Pays per job, not per subscription.** Every Executor attestation triggers an x402 settlement. Treasurer signs the payment from its own EOA, no shared wallet, no operator middleman.
- **Tops itself up on demand.** When USDC drops below threshold, Treasurer calls the Uniswap Trading API for an `EXACT_INPUT` quote, signs Permit2, posts to `/v1/swap`, and broadcasts on Base.
- **Logs every receipt.** Settlement hashes go to `payments.db` (SQLite, append-only). Day-6 wiring lands the durable receipts; the stub today (`index.ts`) handles the AXL gas-request envelope and the Day-6 hooks slot in below it.

## Why this matters for the Uniswap track

The Uniswap Trading API is positioned as the conversion primitive for autonomous payments. Pay-with-any-token only works in practice if there's a verified shape: an agent that converts whatever it has into whatever the next service wants, on demand, without a human approving the swap.

Treasurer is that shape. One agent, one EOA, one small float, real x402 traffic on the other side. I'm not pretending the volume is meaningful yet — public x402 traffic snapshot (2026-04-26, x402scan):

- ~22,000 x402 endpoints registered on the index
- ~2.36M Base x402 micropayments since the 2026-04-12 facilitator launch
- ~5,804 distinct EOAs paying or being paid through the rail

Treasurer is one agent on that rail. The point isn't to be the only one — it's to be the reference shape for the next thousand.

## Address

Treasurer's EOA on Base mainnet: `0xd779cE46567d21b9918F24f0640cA5Ad6058C893`

USDC float, Permit2 signing, Uniswap Trading API calls, x402 settlements — all from this address. Receipts are publicly verifiable on Basescan.

## Integration friction

Real friction I hit with the Trading API and Permit2 is documented in [`/FEEDBACK-UNISWAP.md`](../../FEEDBACK-UNISWAP.md) — Permit2 primaryType ambiguity, Base chainId vs Sepolia confusion, EXACT_OUTPUT semantics for x402 use cases, undocumented protocol selection defaults, and a few more. Targeting the $250 Uniswap partner-feedback bounty.

## What's stub vs what's wired

| Surface | State |
|---------|-------|
| AXL `gas_request` receive | wired (envelope + ULID dedupe) |
| AXL `settlement` reply | stub auto-approve |
| x402 client (sign + post) | Day-6 wire |
| Uniswap quote + swap | Day-6 wire |
| Permit2 signing | Day-6 wire |
| `payments.db` (SQLite) | Day-6 schema |
| Float threshold + auto top-up | Day-6 logic |

Day-6 lands all of the above. Day-7 runs it against live Executor traffic for the first attestation batches.

## Run it

```bash
QUORUM_PAYTO=0xd779cE46567d21b9918F24f0640cA5Ad6058C893 npx tsx index.ts
```

The agent reads gas requests from AXL, settles via x402, replies with a settlement envelope. Watch the logs for `[treasurer] settlement` lines; cross-check the tx hashes on Basescan.

## Repo pointers

- `../executor/` — the agent that asks Treasurer to pay for KeeperHub jobs
- `../../shared/axl-wrap.ts` — typed envelope wrapper, what Treasurer sends and receives over the AXL mesh
- `../../FEEDBACK-UNISWAP.md` — integration friction log
- `../../SUBMISSION.md` — full hackathon writeup
