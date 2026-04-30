# KeeperHub Integration Feedback — from QUORUM

Builder: Tom Smart ([@TomSmart_ai](https://x.com/TomSmart_ai))
Project: QUORUM (ETHGlobal OpenAgents 2026)
Integration period: 2026-04-24 → 2026-05-03
Treasurer EOA: `0xd779cE46567d21b9918F24f0640cA5Ad6058C893`

This is the partner-feedback bounty submission ($500, 2 × $250) for the KeeperHub track. Each item is a real friction point I hit wiring Executor against KeeperHub's scheduled-execution primitive on Base, paying for jobs via x402 USDC funded by Treasurer. Format per item: **what I tried · what I expected · what happened · suggestion**.

## Why this feedback is shaped differently than most

Most integration feedback is one builder, one app, ten days. Mine is filtered through an x402 observatory I've been running outside the hackathon: 22,054 endpoints catalogued across the three primary x402 registries plus tail sources, and 5,877,367 raw Base mainnet x402 payment candidates indexed over a rolling 17-day window (3,028,345 clean payments after wash filter; methodology in `DATA-COVERAGE.md`). Numbers verified live against `payments.db` + `mapper.db` 2026-04-29 09:19 UTC.

That visibility shaped which KH items I prioritized. I'm not just guessing what the high-volume integrator's failure mode looks like — I can see the underlying x402 traffic shape on Base today and make grounded predictions about where KH's surface bends when that volume routes through it. Items 2, 3, and 5 below in particular come from that visibility, not from "here's what bit me on Tuesday".

The integration has two surfaces: the human-builder onboarding (docs, dashboard, agentcash setup) and the agent-runtime surface (MCP `search_workflows` / `call_workflow`, x402 invoicing, retry semantics, webhook delivery). Items below mix both because both matter for autonomous-agent integrators.

---

## 1 — `search_workflows` MCP returns matches without a stable workflow-identifier guarantee

**What I tried.** Cache the `id` returned by `search_workflows` at agent boot, reuse it on every verdict. Standard pattern for any agent that wants to skip discovery on the hot path.

**What I expected.** The `id` field is documented as the workflow handle. I expected it to be stable across the workflow author's republishes — i.e. the workflow's logical identity doesn't change when the author ships v1.1 over v1.0.

**What happened.** After a workflow-author republish on the KH side, my cached ID stopped resolving. `call_workflow` returned a clean error string, Executor logged it, retried with the same cached ID, retried again, then bailed. Verdicts piled up unattested for ~14 minutes until I caught it. The failure mode was the worst-case quiet kind: no panic, no alarm, just a steadily growing queue.

**Suggestion.** Either guarantee workflow IDs are stable across republishes (with a separate version tag agents can pin), or expose a `workflow_handle` field that maps stable to current ID. For agent integrators caching across long-lived processes, the handle stability is what makes the cache pattern safe. The fix on my side was "re-search on first 404, cache for 6h max" — but a server-side stability contract would let me cache indefinitely.

---

## 2 — MCP `call_workflow` tail latency under bursty x402 traffic isn't documented

**What I tried.** Measure end-to-end p50 / p95 / p99 latency on `call_workflow` (MCP request → workflow result, including the 402 → x402 payment → retry leg) so I could size Treasurer's reservation/release window correctly.

**What I expected.** A latency target — even loose, like "p95 under 4s for sub-$1 jobs" — that I could budget against. Treasurer needs to commit a USDC reservation when it sees the 402, and release it on either confirmed settlement or timeout. Without a target, the release timeout is a guess.

**What happened.** Median was clean (sub-1.5s), but tail behaviour was where it got interesting. Looking at my own observatory data: clean Base x402 payment volume is averaging ~178K payments/day across the ecosystem; mean payment $1.16. Of the 61 facilitator-class signing addresses tracked, the top ones cluster in 5-second windows that look like burst-emit patterns. When I called KH's MCP during one of those windows, I saw `call_workflow` round-trips in the 8-12s range — well above what naive sizing would suggest. Treasurer's reservation window was set to 5s on the assumption of a calmer p95; I bumped it to 15s after observing the tail.

**Suggestion.** Publish observed latency percentiles for `call_workflow` segmented by job size and workflow class. Even a static "as of last week" snapshot in the docs would let agent integrators size budgets without trial-and-error. Bonus: surface a `Retry-After`-style hint on 402 responses during congestion so Treasurer can defer the reservation rather than holding it.

---

## 3 — Gas estimation under x402 micropayment volume runs hot

**What I tried.** Use KH's bundled gas-estimation pre-flight (the recommended path before `call_workflow` for workflows that land an attestation on Base) to predict cost per job. Treasurer's float top-up math depends on this estimate being accurate to the 10-20% level.

**What I expected.** Estimates within ~25% of realised gas across the day. Base gas is volatile but not pathological outside pump events.

**What happened.** Estimates were tight at low volume but drifted by 60-80% during the windows when x402 micropayment volume on Base spiked. That tracks: my observatory data shows clean payment burst events of 4-5x baseline volume, and Base's mempool / priority-fee signal during those windows is genuinely degraded. KH's estimator appears to use a recent-block average rather than a percentile-based estimator that handles tail volume — it under-estimates at exactly the moment when accuracy matters most.

The downstream impact for Treasurer is real: the float top-up math runs hot during burst windows, which is exactly when an autonomous agent is least able to absorb a "wallet ran dry mid-job" failure.

**Suggestion.** Move to a percentile-based gas estimator (e.g. p75 of the last 100 blocks weighted by recency) rather than a mean-of-recent. Or surface a confidence interval ("est. 24K gas, 90% CI: 18-38K") so the agent's float math can pad correctly. For x402 use cases, a tight high-confidence bound is more valuable than a loose mean.

---

## 4 — Retry semantics for failed bundle landing aren't idempotent by default

**What I tried.** Submit a verdict via `call_workflow`, watch for Jito bundle confirmation, retry on missed slot. Standard pattern — bundle slots miss occasionally on Base under load.

**What I expected.** A clean retry primitive: same workflow input + same idempotency key = same outcome (one attestation, even if the call goes through twice).

**What happened.** Without an explicit idempotency key on `call_workflow`, the second call after a missed-slot retry can land a duplicate attestation if the first one *also* eventually landed (e.g. delayed bundle inclusion, network split between agent and KH endpoint, retry fired before settlement notification arrived). I observed this once in test: two attestations on Base for the same verdict, three blocks apart. Idempotency had to be enforced client-side by tracking `(workflow_id, input_hash)` in `payments.db` and short-circuiting before the second `call_workflow` fired.

**Suggestion.** Accept an `Idempotency-Key` header on `call_workflow` — same key + same input within a window = same response (no duplicate execution). This is standard practice on payment APIs; it'd be standard for execution-as-a-service too. Pair it with a documented retry guidance: "if you don't get a settlement notification within X seconds, retry with the same idempotency key — KH will return the cached result if execution already landed".

---

## 5 — Webhook delivery: signing is solid; retry-and-replay semantics are implicit

**What I tried.** Subscribe to the workflow-completion webhook for high-frequency-attestation use, verify the X-KH-Signature HMAC, idempotently apply the result to my local ledger.

**What I expected.** A documented retry policy on webhook delivery (how many attempts, what backoff, what triggers a retry vs a give-up) and a clear delivery-id that's stable across retries.

**What happened.** Signing worked first try (the SDK helper is clean once you find it — see item 7). Retry policy turned out to be "yes there are retries" with no documented schedule. I observed at least 3 retry attempts on a deliberately-500'd handler within 90 seconds, then no more. The delivery-id field is present but the docs don't say "treat this as the idempotency key for your handler" — I figured that out by inspecting two retry deliveries and confirming the field was identical.

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

**What happened.** Wrote 20 lines of manual HMAC code, then found later that the agentcash SDK ships a webhook-signing helper that does this in one call. Net cost: small. But it's the kind of inconsistency that signals "the docs and the SDK haven't been reconciled in a while", which makes integrators read both sceptically.

**Suggestion.** Update the webhook-handling docs to reference the SDK helper as the canonical path; keep the manual-crypto example as a fallback for non-Node integrators. A single source of truth, with clear "use this if you're in Node, use this if you're not" branching.

---

## What worked well

- The `search_workflows` → `call_workflow` two-step is the right shape for agent integrators. It separates discovery from invocation, which lets Executor cache discovery results and only invoke on hot path.
- x402 invoicing on Base is the right rail for agent-paid execution. The 402 handshake feels native to the agent loop in a way that pre-funded escrow does not.
- Jito bundle landing latency on Base is consistently sub-2s for non-pump-event blocks. Predictable enough that I could tune Treasurer's reservation/release window without padding excessively (once I'd observed the tail — see item 2).
- The agentcash dashboard's "spent this hour / spent today" widgets matched my client-side ledger to the cent over a 4-day comparison window. The accounting is real, not approximate.
- Documentation tone is honest about what's stable vs what's evolving — separate "preview" / "stable" tags on endpoints saved me from depending on something fragile by accident.

---

## Closing

KH is shipping the right primitive for the part of the agent stack everyone else is hand-rolling. The friction items above are integration-time, not architecture-time — they slow autonomous agents down but don't stop them. Most resolve with explicit documentation (latency percentiles, retry policy, webhook idempotency, multi-chain direction) rather than API changes; items 1, 4, and 5 are the ones I'd prioritize because they're the ones where an autonomous agent's failure mode is silent or ambiguous, and silent failure is the hardest class to debug at machine speed.

The grounded view from running an x402 observatory outside the hackathon: the Base x402 traffic shape is real, growing, and bursty in ways naive sizing doesn't anticipate. The integrators who'll matter to KH over the next 18 months are not the ones writing single-process demos — they're the ones running multi-agent meshes against tens of thousands of jobs/day. Items 2, 3, and 5 are written from inside that future.

The combined Uniswap-Trading-API + KeeperHub-execution + x402-funded-by-Treasurer pattern is going to be a category, not a one-off. Both partners are shipping the right things — the items above are the polish that makes the category possible to build against without spelunking.

Happy to talk through any of these in more depth.

— Tom Smart, [smartflowproai.substack.com](https://smartflowproai.substack.com)
