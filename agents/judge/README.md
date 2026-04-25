# Judge Agent

Consumes smart-money wallet candidates forwarded by Scout over the AXL mesh,
applies a multi-feature risk model, and emits verdicts to the Executor agent.

## Architecture

```
Frankfurt VPS              NYC VPS
┌──────────────┐          ┌────────────────────────────────┐
│ Scout agent  │          │ AXL node B (localhost:9002)    │
│              │─ AXL ──▶│   ↓ delivers to Judge          │
│ publishTo    │          │                                │
│ Judge.ts     │          │ Judge agent (this process)     │
└──────────────┘          │   1. poll GET /recv (500 ms)   │
                          │   2. parseCandidateMessage     │
                          │   3. extractFeatures           │
                          │   4. computeVerdict            │
                          │   5. ack → Scout via AXL       │
                          │   6. forward → Executor        │
                          └────────────────────────────────┘
```

## Verdict model

| Score range | Verdict | Meaning |
|-------------|---------|---------|
| ≥ 0.7       | RUG     | High-confidence rug-farming signal — Executor should block |
| ≥ 0.4       | WATCH   | Moderate risk — flag for human review |
| < 0.4       | SAFE    | No significant risk signal |

**Day 3 weights** (heuristic — to be replaced with backtested coefficients Day 4):
- `isRisky` (known EVM rug deployer cross-chain): weight 0.6
- `hasEvmCorrelation` (mapped Solana → EVM address): weight 0.25
- `lamportsNorm` (large SOL accumulation): weight 0.15

## Required env vars

| Var | Default | Description |
|-----|---------|-------------|
| `AXL_HTTP_BASE` | `http://localhost:9002` | Co-located AXL node HTTP endpoint |
| `SCOUT_AXL_PEER` | `scout` | Peer ID of Scout's AXL node (for acks) |
| `EXECUTOR_AXL_PEER` | `executor` | Peer ID of Executor AXL node |
| `JUDGE_PORT` | `9100` | Health-check HTTP port |

## Health endpoint

```bash
curl http://localhost:9100/health
# { "status": "ok", "processed": 42, "inFlight": 0, "uptimeSeconds": 300 }
```

## Run

```bash
npm install
npm run build
npm start
```

## Day 4 TODO

- Load backtested logistic regression weights from `model-weights.json`
- Add feature: wallet age (days since first Solana tx)
- Add feature: burst score (number of subscriptions in last 60 s)
- Add feature: known-bridge fingerprint (Wormhole / deBridge / Allbridge)
