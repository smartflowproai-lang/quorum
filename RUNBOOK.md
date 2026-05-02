# QUORUM RUNBOOK

Operational guide for the 5-process mesh (Frankfurt-A + NYC-B).

## Prereqs

- Two VPS hosts on Yggdrasil mesh (TLS port 9001, control port 9002)
- ed25519 keypair per role (Scout/Judge/Verifier/Executor/Treasurer)
- Base mainnet RPC access (alchemy.io / mainnet.base.org)
- Helius WS endpoint (Solana smart-money tracking)
- KeeperHub MCP API key (for Executor wire)
- Treasurer wallet funded with min 5 USDC + 0.001 ETH gas on Base

## Environment variables

See `.env.example`. Critical:

- `AXL_NODE_NAME`: scout-frankfurt | judge-frankfurt | executor-nyc | treasurer-nyc | verifier-nyc
- `HELIUS_WS_URL`: Solana smart-money tracking WebSocket
- `SMART_MONEY_WALLETS`: comma-separated list (14 wallets)
- `KH_MCP_URL`: app.keeperhub.com/mcp
- `TREASURER_USDC_WALLET_PATH`: path to keypair JSON
- `BASE_RPC_URL`: mainnet.base.org

## Deploy (cross-host)

```bash
./infra/deploy-vps.sh    # deploys to BOTH Frankfurt and NYC via SSH
```

## Smoke test

```bash
docker compose up        # local 5-agent stack
curl http://127.0.0.1:9002/topology    # AXL mesh state
```

Expected: peer ESTAB to NYC inbound, sequence advancing.

## Chaos test

```bash
./infra/chaos-axl-failover.sh
```

Documented in `CHAOS-TEST.md`.

## Verifier integrity check

```bash
cd agents/verifier && npm test
```

Expected: 38 unit tests green (schema, ed25519 signature, ERC-8004 roundtrip, replay-attack rejection).
