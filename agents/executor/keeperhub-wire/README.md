# keeperhub-wire

Executor's KeeperHub MCP integration. Lands ed25519-signed verdicts as ERC-8004
attestations on Base via KH's scheduled-execution primitive, paying jobs by
delegating x402 invoices to Treasurer over the AXL mesh.

## Files

| File | Role |
|------|------|
| `types.ts`            | Zod-validated schemas + shared types (no behaviour) |
| `mcp-client.ts`       | JSON-RPC over HTTP MCP client; typed errors per failure class |
| `idempotency.ts`      | `(workflow_id, canonical_input)` → stable key + in-mem store |
| `workflow-cache.ts`   | 6h TTL workflow-id cache, single-shot invalidation on 404 |
| `webhook-verify.ts`   | HMAC-SHA256 with timing-safe compare + 5min replay window |
| `x402-payer.ts`       | Delegates x402 settlement to Treasurer over AXL |
| `executor-wire.ts`    | Orchestrator: resolve → idem-check → call_workflow → recover |
| `mock-kh-server.ts`   | In-process HTTP mock of KH MCP for tests + verify-mode |
| `verify-mode.ts`      | Driver: run N executions, write JSONL evidence log |
| `test/wire.test.ts`   | `node:test` integration suite against the mock |

## Failure-mode contract

The wire's surface is small on purpose. Every error class maps to exactly one
recovery action; nothing is implicit:

| Error                  | Recovery |
|------------------------|----------|
| `McpPaymentRequired`   | Delegate to Treasurer, retry under same idempotency key |
| `McpWorkflowNotFound`  | Invalidate cache entry, re-search once, retry once |
| `McpTransientError`    | Exponential backoff (or honour `Retry-After`), max 3 attempts |
| `McpInvalidInput`      | Surface immediately — caller's input is wrong, retry won't help |

## Idempotency contract

Per `FEEDBACK-KeeperHub.md` item 4, KH MCP doesn't yet honour
`Idempotency-Key` server-side. The wire enforces dedup itself: every
`call_workflow` invocation is keyed on
`sha256(workflow_id || \0 || canonicalJson(input))`. A retry after a missed
bundle slot or a transient network error short-circuits on the local store
and never lands a duplicate attestation.

Canonical JSON sorts keys recursively, so `{a:1,b:2}` and `{b:2,a:1}` produce
the same key. We send the derived key as the `Idempotency-Key` HTTP header
too — when KH ships server-side dedup we get it for free.

## 6h workflow-id cache

Per FEEDBACK item 1, KH workflow IDs aren't guaranteed stable across
republishes. The cache TTL is bounded at 6h (configurable) so a silent ID
shift never piles up unattested verdicts for more than that window. On a 404
during `call_workflow`, the cache invalidates the affected entry and the next
search refreshes it; the orchestrator retries the call once under the
freshly-resolved id (under the same idempotency key, so KH still sees one
logical job).

## Webhook verification

`verifyKhWebhook` does three things the docs example does not:

1. Constant-time compare via `timingSafeEqual` on raw byte buffers.
2. Replay-window enforcement: a 5-minute envelope around the
   `X-KH-Timestamp` header.
3. Strict zod parse of the payload — a malformed but signed body is still
   rejected.

Header aliases supported: `X-KH-Signature` / `X-KeeperHub-Signature`,
`X-KH-Timestamp` / `X-KeeperHub-Timestamp`. Signature value may be raw hex or
`sha256=<hex>` (Stripe-style).

## x402 payment flow

Executor never holds Treasurer's private key. On a 402, the orchestrator
packages the parsed challenge into an AXL envelope addressed to `treasurer`
and waits (15s default; FEEDBACK item 2) for a settlement reply correlated
by trace id. Treasurer's existing `X402Handler` does the swap-and-settle.

Treasurer EOA (single source of truth):
`0xd779cE46567d21b9918F24f0640cA5Ad6058C893`. Base mainnet only today.

For tests + verify-mode, the payer is injectable via the `ExecutorKeeperHubWire`
constructor — the mock harness substitutes an inline payer that flips the
mock's payment registry without crossing AXL.

## Running verify-mode

```sh
# Stub mode (default): in-process KH mock, no credentials needed
KH_VERIFY_COUNT=10 node --import tsx verify-mode.ts

# Live mode: hits real KH endpoint, real x402 settlements via Treasurer
KH_STUB=0 \
KH_MCP_ENDPOINT=https://mcp.keeperhub.example/v1 \
KH_MCP_TOKEN=<token> \
KH_WEBHOOK_SECRET=<secret> \
KH_VERIFY_COUNT=50 \
node --import tsx verify-mode.ts
```

Output: JSONL written to `KH_VERIFY_LOG` (default
`logs/d6-keeperhub-wire-verify.log`). One line per wire event plus a
`verify_iter_ok` / `verify_iter_err` entry per iteration plus
`verify_mode_start` and `verify_mode_end` anchors.

The mock + tests cover every code path the wire claims; live mode produces
the on-chain evidence count for the hackathon submission.

## Running tests

```sh
npm test
```

Uses `node:test` (built-in, zero extra deps). Covers happy path, idempotency
replay, idempotency key stability, 404 re-resolve, 5xx burn-down, and three
webhook verification cases.

## What's deliberately NOT here

- No SQLite — idempotency store is in-memory for the scaffold; folds into
  Treasurer's `payments.db` when the wire goes live.
- No retry on 4xx other than 404 — those are caller bugs, retry won't help.
- No server-side webhook dedup ledger — that lives in Executor's process,
  not in the wire layer.
- No multi-chain abstraction — KH is Base-only today (FEEDBACK item 6).

## Wire-up to live Executor

`agents/executor/index.ts` currently runs the AXL receive loop and stubs the
KH integration. To enable, replace the stub block with:

```ts
import { ExecutorKeeperHubWire } from './keeperhub-wire/executor-wire';
import { DEFAULT_CONFIG } from './keeperhub-wire/types';

const wire = new ExecutorKeeperHubWire({
  ...DEFAULT_CONFIG,
  mcpEndpoint: process.env.KH_MCP_ENDPOINT!,
  mcpAuthToken: process.env.KH_MCP_TOKEN,
  webhookSecret: process.env.KH_WEBHOOK_SECRET!,
});

// Inside the receive loop, on a verdict envelope:
const out = await wire.landAttestation({
  workflowQuery: 'quorum-attest-v1',
  input: verdictPayload,
});
```

The same wire object also serves Treasurer's webhook endpoint via
`verifyKhWebhook`.
