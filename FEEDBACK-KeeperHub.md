# KeeperHub Integration Feedback — from QUORUM

Builder: Tom Smart ([@TomSmart_ai](https://x.com/TomSmart_ai))
Project: QUORUM (ETHGlobal OpenAgents 2026)
Integration period: 2026-04-24 → 2026-05-03
Treasurer EOA: `0xd779cE46567d21b9918F24f0640cA5Ad6058C893`

This is the partner-feedback bounty submission ($500, 2 × $250) for the KeeperHub track. Each item is a real friction point I hit wiring Executor against KeeperHub's scheduled-execution primitive on Base, paying for jobs via x402 USDC funded by Treasurer. Format per item: **what I tried · what I expected · what happened · suggestion**.

## Why this feedback is shaped differently than most

Most integration feedback is one builder, one app, ten days. Mine is filtered through an x402 observatory I've been running outside the hackathon: 22,054 endpoints catalogued across the three primary x402 registries plus tail sources, and 6,448,184 raw Base mainnet x402 payment candidates indexed over an 18.4-day window (2026-04-12 → 2026-04-30 18:02 UTC), 3,409,612 clean payments after wash filter, 15.01% / 511,716 of the clean subset facilitator-classified — methodology in `DATA-COVERAGE.md`, lock numbers in `lockfile-2026-04-30-evening.json` regenerated from `payments.db` 2026-04-30 16:10 UTC. Backfill progressed monotonically since the 29.04 public correction (13.0% → 15.01%); deltas are backfill progress, not query bugs.

That visibility shaped which KH items I prioritized. I'm not just guessing what the high-volume integrator's failure mode looks like — I can see the underlying x402 traffic shape on Base today and make grounded predictions about where KH's surface bends when that volume routes through it. Items 2, 3, and 5 below in particular come from that visibility, not from "here's what bit me on Tuesday".

The integration has two surfaces: the human-builder onboarding (docs, dashboard, agentcash setup) and the agent-runtime surface (MCP `search_workflows` / `call_workflow`, x402 invoicing, retry semantics, webhook delivery). Items below mix both because both matter for autonomous-agent integrators.

---

## 1 — `search_workflows` MCP returns matches without a stable workflow-identifier guarantee

**What I tried.** Cache the `id` returned by `search_workflows` at agent boot, reuse it on every verdict. Boot-time cache + hot-path lookup is the obvious shape for any long-lived agent process that doesn't want to re-discover on every call.

**What I expected.** The `id` field is documented as the workflow handle. I expected it to be stable across the workflow author's republishes — i.e. the workflow's logical identity doesn't change when the author ships v1.1 over v1.0.

**What happened.** Without a stable handle contract, a republish silently invalidates every cached ID in every long-lived agent process. The fail mode is queue build-up, not error escalation: `call_workflow` returns a clean error, the agent retries with the same cached ID, retries again, then bails. There is no panic, no alarm — just unattested verdicts piling up until something downstream (a settlement deadline, an operator dashboard) forces the question. This is exactly the silent-failure shape autonomous agents handle worst, and the keeperhub-wire client guards against it client-side via `(workflow_id, input_hash)` keying — see `keeperhub-wire/idempotency.ts:1-40` — but the underlying contract gap is on the KH side.

**Suggestion.** Either guarantee workflow IDs are stable across republishes (with a separate version tag agents can pin), or expose a `workflow_handle` field that maps stable to current ID. For agent integrators caching across long-lived processes, the handle stability is what makes the cache pattern safe. The fix on my side was "re-search on first 404, cache for 6h max" — but a server-side stability contract would let me cache indefinitely.

---

## 2 — MCP `call_workflow` tail latency under bursty x402 traffic isn't documented

**What I tried.** Measure end-to-end p50 / p95 / p99 latency on `call_workflow` (MCP request → workflow result, including the 402 → x402 payment → retry leg) so I could size Treasurer's reservation/release window correctly.

**What I expected.** A latency target — even loose, like "p95 under 4s for sub-$1 jobs" — that I could budget against. Treasurer needs to commit a USDC reservation when it sees the 402, and release it on either confirmed settlement or timeout. Without a target, the release timeout is a guess.

**What I now have.** Live-mode evidence against `app.keeperhub.com` MCP endpoint is in `logs/d6-keeperhub-wire-verify.log` (96 KB, real KH not mock): 11 live `call_workflow` executions on 2026-05-01 against `app.keeperhub.com` MCP (sessions 7-8 of the verify run series), retry-attempts distribution honest breakdown: clean settles in sessions where wire converged, transient Cloudflare 522s correctly surfaced as `McpTransientError` and re-played idempotently in early sessions. Final consecutive-run summary `ok=11/total=12` against the read-only `zwarm-test-sepolia-balance-check` workflow (price=0 so the loop doesn't burn x402 USDC per iteration). Plus 62 stub iterations (sessions 1-2 against local harness) validate client-side idempotency replay/retry shape independently — see `keeperhub-wire/idempotency.ts`. Latency is bimodal: clean settles complete in 1-3 s; the retry-path settles in 8-12 s including transient backoff. That's enough shape to size Treasurer's reservation window — but published p50/p95/p99 from KH would still let me drop my own measurement infrastructure. What I *can* say from observatory data: clean Base x402 payment volume averages ~185K payments/day across the 18.4-day window; mean payment $1.14; the top facilitator-class signing addresses cluster in 5-second windows that look like burst-emit patterns. Those bursts mechanically hit the Base mempool and priority-fee signal, not KH's MCP loop directly — but if KH's workflow runner submits transactions during those windows, the realised cost and tail latency for downstream `call_workflow` callers will track those bursts. The right ask isn't a measured correlation I haven't run; it's published percentiles from KH so I don't have to guess at the budget for Treasurer's reservation window.

**Suggestion.** Publish observed latency percentiles for `call_workflow` segmented by job size and workflow class. Even a static "as of last week" snapshot in the docs would let agent integrators size budgets without trial-and-error. Bonus: surface a `Retry-After`-style hint on 402 responses during congestion so Treasurer can defer the reservation rather than holding it.

---

## 3 — Gas estimation under x402 micropayment volume runs hot

**What I tried.** Use KH's bundled gas-estimation pre-flight (the recommended path before `call_workflow` for workflows that land an attestation on Base) to predict cost per job. Treasurer's float top-up math depends on this estimate being accurate to the 10-20% level.

**What I expected.** Estimates within ~25% of realised gas across the day. Base gas is volatile but not pathological outside pump events.

**What happened.** The 11 live `call_workflow` runs above were against a price=0 read-only workflow (sepolia balance check), so realised-vs-estimated gas drift wasn't on the critical path — Treasurer's float math doesn't activate when the call is free. The bundled-estimator integration against a paid Base-mainnet attestation workflow is deferred post-hackathon for the same reason: the build-window critical path was wiring search → call → idempotent retry, not gas-estimator drift. Honest framing: this is a forward concern with a mechanically-grounded prediction, not a shipped measurement — and the honest evidence I do have is the 11 live executions, the 62 stub iterations validating idempotency, and the retry distribution shape, both real. Mechanically I expect a recent-block-mean estimator to under-estimate during the bursty windows my observatory shows (clean payment burst events of several multiples of baseline volume; Base's mempool / priority-fee signal during those windows is genuinely degraded), exactly when an autonomous agent is least able to absorb a "wallet ran dry mid-job" failure.

**Suggestion.** Move to a percentile-based gas estimator (e.g. p75 of the last 100 blocks weighted by recency) rather than a mean-of-recent. Or surface a confidence interval ("est. 24K gas, 90% CI: 18-38K") so the agent's float math can pad correctly. For x402 use cases, a tight high-confidence bound is more valuable than a loose mean.

---

## 4 — Retry semantics for failed tx landing aren't idempotent by default

**What I tried.** Submit a verdict via `call_workflow`, monitor for tx inclusion, retry on dropped tx (mempool eviction, replacement-with-higher-fee, or the agent's own retry firing before the inclusion notification arrives). Base is an EVM L2 with blocks — the failure shape here is dropped/replaced tx, not Solana-style missed slots.

**What I expected.** A clean retry primitive: same workflow input + same idempotency key = same outcome (one attestation, even if the call goes through twice).

**What happened.** Without an explicit idempotency key on `call_workflow`, a second call after a dropped-tx retry can land a duplicate attestation if the first call *also* eventually settled (delayed inclusion, network split between agent and KH endpoint, retry fired before settlement notification arrived). This is the canonical idempotency failure mode for any execution-as-a-service over a probabilistic settlement layer, and it's why the keeperhub-wire client enforces `(workflow_id, input_hash)` keying client-side before flipping the wire live — `keeperhub-wire/idempotency.ts:1-40`. The client-side guard works, but it's compensating for a server-side contract gap that every integrator will reinvent.

**Suggestion.** Accept an `Idempotency-Key` header on `call_workflow` — same key + same input within a window = same response (no duplicate execution). This is standard practice on payment APIs; it'd be standard for execution-as-a-service too. Pair it with a documented retry guidance: "if you don't get a settlement notification within X seconds, retry with the same idempotency key — KH will return the cached result if execution already landed".

---

## 5 — Webhook delivery: signing is solid; retry-and-replay semantics are implicit

**What I tried.** Subscribe to the workflow-completion webhook for high-frequency-attestation use, verify the `X-KeeperHub-Signature` (or `X-KH-Signature` per the docs example — the wire accepts both via a small alias set; see `keeperhub-wire/webhook-verify.ts:1-30`) HMAC, idempotently apply the result to my local ledger.

**What I expected.** A documented retry policy on webhook delivery (how many attempts, what backoff, what triggers a retry vs a give-up) and a clear delivery-id that's stable across retries.

**What happened.** Signing was straightforward once I'd written my own HMAC verifier (see item 7 — the wire re-implements rather than depending on the SDK because the rest of the network layer is dep-free, not because the SDK is broken). Retry policy turned out to be "yes there are retries" with no documented schedule. I observed at least 3 retry attempts on a deliberately-500'd handler within 90 seconds, then no more. The delivery-id field is present but the docs don't say "treat this as the idempotency key for your handler" — I figured that out by inspecting two retry deliveries and confirming the field was identical.

The cross-check I'd want as an integrator: my observatory tracks ~3M clean Base x402 payments and I can see the volume profile that KH webhooks would inherit if even 5% of that traffic routed through KH for execution. At that scale, "implicit retry semantics" becomes "every integrator builds a slightly different handler, drift accumulates, ledgers diverge". The cost of not documenting this now compounds quickly.

**Suggestion.** Document the retry schedule explicitly (e.g. "we retry at 0s / 30s / 5min / 30min / 2h, then give up"). Position the delivery-id field as the canonical idempotency key for handlers. Add a single docs paragraph titled "Building an idempotent webhook handler" that shows the right pattern — most integrators will copy it verbatim, which is exactly what you want.

---

## 6 — Multi-chain roadmap is invisible to the integrator

**What I tried.** Build Executor against Base mainnet today. Plan for the case where x402 traffic diversifies (Solana facilitators, Optimism, Arbitrum) and Executor wants to land attestations wherever the verdict applies.

**What I expected.** Some signal in the docs or roadmap — "Base today, X chain Q3, Y chain after that". Even a directional statement would let me design Executor's chain-abstraction layer to match.

**What happened.** Couldn't find a public roadmap statement on multi-chain. Inferred from the codebase / API surface that Base is the singular target today, which is fine for me — but the agent-economy thesis I'm building against is multi-chain by year-end. My observatory already shows non-Base x402-style activity worth tracking (Solana facilitator candidates, EVM L2 patterns); if KH stays Base-only while the surrounding ecosystem fragments, the value of the KH integration narrows even if the product itself stays excellent.

**Suggestion.** Publish a directional multi-chain note. Doesn't have to be a commitment — even "we're watching Solana x402 emergence; the architecture is chain-agnostic; concrete chains TBD" is enough for an integrator to plan for. The alternative is integrators silently de-prioritising KH because they don't know whether to design around it as a Base primitive or a general one.

---

## 7 — Webhook signature verification example uses a different lib than the one the SDK ships

**What I tried.** Implement webhook verification on Executor's handler. Followed the docs example — manual `crypto`-module HMAC compare with constant-time semantics.

**What I expected.** The docs example to be either the canonical path or clearly labelled as the "manual / non-Node" fallback.

**What happened.** Wrote 20 lines of manual HMAC code, then found later that the agentcash SDK ships a webhook-signing helper that does this in one call. The wire still re-implements via Node `crypto` because the rest of the network layer is dep-free and we wanted to keep it that way (`keeperhub-wire/webhook-verify.ts:4-7`) — that's a deliberate choice, not a docs bug. The footgun is for integrators who land on the manual example first, copy 20 lines of HMAC, and only later discover the SDK helper exists.

**Suggestion.** Update the webhook-handling docs to reference the SDK helper as the canonical path; keep the manual-crypto example as a fallback for non-Node integrators or for callers (like ours) that prefer dep-free network code. A single source of truth, with clear "use this if you're in Node, use this if you're not, and here's why you might still re-implement" branching.

---

## 8 — x402 challenge shape captured live: KH MCP returns spec-compliant 402 but the MCP tool itself doesn't auto-pay

**What I tried.** Run a paid workflow (`pack-0-10-demo`, $0.10 USDC on Base mainnet) directly via `tools/call call_workflow` against `app.keeperhub.com/mcp` to validate the end-to-end paid path against my live KH wire — not the read-only `zwarm-test` workflow that backs the 11 live + 62 stub executions above.

**What happened.** The MCP `tools/call` returned `isError: true` with the canonical x402-version-2 challenge embedded in `result.content[0].text`. Captured live snapshot: [`logs/d8-kh-x402-challenge-response.json`](./logs/d8-kh-x402-challenge-response.json) (2026-05-01T21:20Z). Challenge shape:

```
network: eip155:8453 (Base mainnet)
asset:   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (USDC)
amount:  100000 atomic ($0.10 USDC)
payTo:   0xf591c99cf53073db7b96cfb003cbcabdd3709544
maxTimeoutSeconds: 300
scheme:  exact
extensions.bazaar.discoverable: true
```

The KH-side error message was the useful surprise: it explicitly listed three retry paths — `@keeperhub/wallet` paymentSigner, `mcp__agentcash__fetch`, or the marketplace UI. None of them are the MCP `tools/call` itself. The MCP server returns the challenge but does not bridge the payer.

**Why this matters for the integration shape.** QUORUM's [`agents/executor/keeperhub-wire/x402-payer.ts`](./agents/executor/keeperhub-wire/x402-payer.ts) was written against the public x402 spec before this real challenge was captured. The `X402Challenge` type in [`agents/executor/keeperhub-wire/types.ts`](./agents/executor/keeperhub-wire/types.ts) mirrors the captured shape one-for-one (scheme/network/asset/amount/payTo/maxTimeoutSeconds). Executor's design intent — never hold Treasurer's signer key, package the 402 as an AXL message to the treasurer agent, wait for `settle_tx_hash` reply with timeout — anticipates exactly this MCP-doesn't-auto-pay reality. Spec match validated against live API, not assumed from docs.

**Suggestion.** Two things:

1. **Document the paid-MCP path explicitly.** A docs page titled "Paying for KH workflows over MCP" covering: (a) the 402 challenge JSON shape exposed on `result.content[0].text`, (b) the three retry paths surfaced in the error message, (c) the expected `executionId` + `settled` shape returned after a successful payment. Today an integrator has to send a paid call and read the error to learn this. The information is good — make it discoverable before the call.

2. **Surface the choice cleanly in the MCP response.** Instead of `isError: true` for the 402 case, return a structured `requires_payment` envelope so MCP clients can distinguish "billing intent" from "actual error". Today the wire treats every `isError: true` as fatal until the caller parses the embedded JSON for `x402Version`. A typed signal would let multi-agent stacks like QUORUM route 402s to a payer agent without inspecting prose.

## What worked well

- The `search_workflows` → `call_workflow` two-step is the right shape for agent integrators. It separates discovery from invocation, which lets Executor cache discovery results and only invoke on hot path.
- x402 invoicing on Base is the right rail for agent-paid execution. The 402 handshake feels native to the agent loop in a way that pre-funded escrow does not.
- The agentcash dashboard's "spent this hour / spent today" widgets are the right shape for agent ops. I plan to validate dashboard reconciliation against my client-side ledger to-the-cent over a 4-day comparison window once Treasurer is in continuous operation post-hackathon — that's the gap I'm most curious to close.
- Documentation tone is honest about what's stable vs what's evolving — separate "preview" / "stable" tags on endpoints saved me from depending on something fragile by accident.

---

## Closing

KH is shipping the right primitive for the part of the agent stack everyone else is hand-rolling. The friction items above are integration-time, not architecture-time — they slow autonomous agents down but don't stop them. Most resolve with explicit documentation (latency percentiles, retry policy, webhook idempotency, multi-chain direction) rather than API changes; items 1, 4, and 5 are the ones I'd prioritize because they're the ones where an autonomous agent's failure mode is silent or ambiguous, and silent failure is the hardest class to debug at machine speed.

The grounded view from running an x402 observatory outside the hackathon: the Base x402 traffic shape is real, growing, and bursty in ways naive sizing doesn't anticipate. The integrators who'll matter to KH over the next 18 months are not the ones writing single-process demos — they're the ones running multi-agent meshes against tens of thousands of jobs/day. Items 2, 3, and 5 are written from inside that future.

The combined Uniswap-Trading-API + KeeperHub-execution + x402-funded-by-Treasurer pattern is going to be a category, not a one-off. Both partners are shipping the right things — the items above are the polish that makes the category possible to build against without spelunking.

Happy to talk through any of these in more depth.

— Tom Smart, [smartflowproai.substack.com](https://smartflowproai.substack.com)
