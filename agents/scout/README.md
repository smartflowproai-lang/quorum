# Scout Agent

Monitors 14 smart-money Solana wallets via Helius WebSocket `accountSubscribe`.
Detects new token launches and bridges findings to EVM (Base) for cross-chain
rug-farming pattern detection. Candidate events are forwarded to Judge via AXL mesh.

## Required env vars

- `HELIUS_API_KEY` — Solana RPC/WS key from helius.dev
- `SMART_MONEY_WALLETS` — comma-separated Solana pubkeys to watch (14 tracked wallets)
- `AXL_PEERS` — AXL mesh peer list (default: `judge`)

## Run

```bash
npm run build && npm start
```
