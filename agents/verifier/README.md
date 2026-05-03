# QUORUM Verifier

Sits between Judge and Executor on the AXL mesh. Validates Judge verdicts
against on-chain reality, then issues an attestation when the verdict checks
out — or fires back a `reprobe_request` when it doesn't.

## Files

| File              | Purpose |
|-------------------|---------|
| `types.ts`        | Shared types + zod schemas (boundary defense) |
| `validator.ts`    | Verdict validator. Schema re-assert + chain-bound on-chain probe |
| `attestation.ts`  | Attestation issuance. Allow-listed JSONL log, append mutex, fsync, persistent live-submit cap |
| `index.ts`        | Main loop. Size cap, freshness, sig, dedupe (input-only), token-bucket rate limit, handler |
| `verifier.test.ts`| node:test suite (42 tests) |

## Run

```bash
npm install
npm run typecheck
npm test
npm start  # boots the AXL poll loop
```

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `VERIFIER_POLL_INTERVAL_MS`     | 1000  | AXL receive poll spacing |
| `AXL_ATTEST_TARGET`             | executor | peer that gets `attestation` |
| `AXL_REPROBE_TARGET`            | judge | peer that gets `reprobe_request` |
| `QUORUM_REQUIRE_AXL_SHAPE`      | (unset) | when `true`, every inbound envelope must pass `axlVerifyShape` (structural check only — not cryptographic signature; long-lived per-host signing keys deferred post-hackathon). Old name `QUORUM_REQUIRE_AXL_SIG` accepted with deprecation warning. |
| `VERIFIER_FRESHNESS_MS`         | 60000 | reject msgs whose `ts` falls outside ±this window |
| `VERIFIER_PEER_RATE`            | 60    | per-peer token-bucket capacity (per minute) |
| `VERIFIER_ATTEST_LOG`           | `~/.quorum/verifier-attestations.jsonl` | JSONL log path |
| `VERIFIER_ATTEST_DIR`           | `~/.quorum` | parent dir if log path not set |
| `VERIFIER_LIVE_ATTEST`          | `false` | when `true`, attempt on-chain submit (currently stubbed) |
| `VERIFIER_LIVE_ATTEST_DAILY_CAP`| 0     | hard daily cap on live submits; 0 disables |

## Integration note

The verifier expects inbound payloads to carry an envelope:

```ts
{ kind: 'verdict_request', verdict: JudgeVerdict }
{ kind: 'reprobe_request', verdict: JudgeVerdict, reason?: string }
```

The current Judge stub emits a flat `{ agent, verdict, source }` payload
straight to the executor. Wiring Judge → Verifier requires a small Judge-side
update to wrap output in the envelope above. Tracked separately.

## ERC-8004 status

The brief calls for an ERC-8004 attestation on Base mainnet. The on-chain
submit path is stubbed (gated by `VERIFIER_LIVE_ATTEST=true` AND a non-zero
`VERIFIER_LIVE_ATTEST_DAILY_CAP`, and the counter is persisted to disk so
crashloops don't reset it). Until the registry contract is wired and the EIP-712
signer is added, attestations land in JSONL — deterministic, replayable, no gas
burn.

## Audit posture

This module passed five audit layers (self, three independent hostile
reviewers, architectural fit). Final verdict: 0 HIGH, 0 MED.

Hardening covers:
- prototype pollution (zod `.strict()` + discriminated union)
- replay (freshness window + input-keyed dedupe LRU)
- amplification (token-bucket rate limit, bounded peer set)
- attestation fraud (chain-bound probe, token-log presence check)
- secret leakage (generic probe error string, never raw RPC `err.message`)
- log path traversal + symlink TOCTOU (allow-list + `O_NOFOLLOW`)
- JSONL torn writes (append mutex + `fsync`)
- gas-burn footgun (env-only `liveSubmit`, persistent daily counter, reservation/release pattern)
