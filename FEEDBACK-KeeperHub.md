# KeeperHub Integration Feedback — from QUORUM

Builder: Tom Smart ([@TomSmart_ai](https://x.com/TomSmart_ai))
Project: QUORUM (ETHGlobal OpenAgents 2026)
Integration period: 2026-04-24 → 2026-05-03
Treasurer EOA: `0xd779cE46567d21b9918F24f0640cA5Ad6058C893`

This is the partner-feedback bounty submission ($500, 2 × $250) for the KeeperHub track. Each item is a real friction point I hit wiring Executor against KeeperHub's scheduled-execution primitive on Base, paying for jobs via x402 USDC funded by Treasurer. Format per item: **what I hit · impact on the build · what I'd change**.

The integration has two surfaces: the human-builder onboarding (docs, dashboard, agentcash setup) and the agent-runtime surface (MCP `search_workflows` / `call_workflow`, x402 invoicing, retry semantics). Items below mix both because both matter for autonomous-agent integrators.

---

## 1 — `search_workflows` MCP tool returns matches without a stable workflow-identifier guarantee

**What I hit.** When Executor calls `search_workflows` via the KeeperHub MCP server, the response is a ranked list of candidate workflows with descriptions and example invocations. The `id` field on each result is documented as the workflow handle, but the same logical workflow can appear under different IDs across registry refreshes (when the workflow author republishes a corrected version). For an autonomous agent that caches "the workflow I'm using to land Base attestations", a quiet ID rotation means the cached handle 404s on next call, and the agent has to re-search to recover.

**Impact.** Executor's first integration spike cached the workflow ID at boot and reused it on every verdict. After a workflow-author republish on the KH side, the cached ID stopped resolving. The agent's failure mode was the worst-case quiet one: `call_workflow` returned a clean error string, Executor logged it, retried with the same cached ID, retried again, then bailed — meanwhile verdicts were piling up unattested. Adding "re-search on first 404, cache for 6h max" was the fix, but it took a debugging session to realise the cache was the problem.

**Suggestion.** Either guarantee workflow IDs are stable across republishes (with a separate version tag agents can pin), or surface a `workflow_handle` field that maps stable to current ID. For agent integrators, the handle stability is what makes the cache pattern safe.

---

## 2 — agentcash wallet UX assumes a human at the dashboard

**What I hit.** The agentcash wallet onboarding (the recommended way for agents to fund x402 calls into KH) walks a builder through wallet creation, USDC top-up, and policy-setting via dashboard clicks. Most of those steps have an underlying API, but the docs lead with the dashboard flow. For an autonomous deployment script (`deploy-vps.sh nyc`) that needs to provision a fresh wallet, fund it, and set the spend-policy without a human in the loop, the docs leave the API path implicit.

**Impact.** I rebuilt the onboarding flow against the API by reading the dashboard's network tab. Worked, but two of the policy fields (`max_per_call_usdc`, `daily_envelope_usdc`) accept different units in the API vs the dashboard (one takes raw wei-style, the other takes decimal USDC), and I shipped a misconfigured wallet for a few hours until the first overrun blocked.

**Suggestion.** Add an "Agent integration" section to the agentcash docs, mirroring the dashboard flow with the canonical API calls and example payloads. Standardise the unit (decimal USDC everywhere or raw everywhere), or document the unit choice per field. The agent-integrator path is going to dominate volume — putting it first in the docs would prevent the entire class of "I trusted the dashboard tooltip" misconfigurations.

---

## 3 — x402 invoice metadata doesn't survive the retry loop

**What I hit.** When Executor calls `call_workflow` and KH returns a 402 with the x402 invoice, the invoice envelope carries job-context metadata (which workflow, which input hash, which retry attempt). After Treasurer pays the invoice and Executor retries the call, the original metadata is dropped — the second-call response is just the workflow result, with no echo back of the invoice fields the agent used to bind the payment to the job. For an agent that wants to write a single audit row "I paid invoice X to land verdict Y", the binding is implicit and reconstructed client-side.

**Impact.** Treasurer's `payments.db` row-shape needed an extra index across `(workflow_id, input_hash, x402_invoice_id, base_tx_hash)` to reconcile invoice → settlement → workflow result. Doable, but the reconciliation logic is more state-machine than I'd want for an audit trail.

**Suggestion.** Echo the x402 invoice ID and the workflow input hash on the successful workflow response. Or expose a `GET /v1/workflow/runs/{run_id}` that includes the invoice context. The "agent paid X to do Y" linkage is what makes the per-call payment model auditable for compliance-conscious integrators (which I expect to dominate after the first $10K/month KH-on-x402 customer shows up).

---

## 4 — Jito bundle landing path: status-polling cadence isn't documented

**What I hit.** Executor uses KH's Jito bundle scheduler for Base attestations because naive `sendTransaction` fails during memecoin pump events. The flow is: submit verdict → KH bundles → Jito lands → KH writes status. The docs cover submission well, but the recommended polling cadence for "did the bundle land?" isn't surfaced. I started with 1-second polls and got rate-limited within 30 minutes; backed off to 3-second polls and was fine; eventually moved to webhook subscription, which the docs do mention but don't position as the recommended pattern for high-frequency-attestation agents.

**Impact.** A wasted afternoon on rate-limit chase. The webhook flow (which is the right answer) is buried in a sub-page, not surfaced from the main `call_workflow` flow that an agent integrator naturally lands on first.

**Suggestion.** In the `call_workflow` docs, lead with "if you expect more than N completions per minute, switch to webhook subscriptions immediately; polling is for low-frequency or development use only". Document the polling rate-limit explicitly (per-minute and per-hour). The current implicit-rate-limit model means every new integrator finds it the same way.

---

## 5 — Workflow-author authentication-vs-consumer-payment split is implicit

**What I hit.** KH workflows are authored by one party (sometimes the platform, sometimes a third party) and consumed by another (Executor in my case). The `call_workflow` request needs the consumer's payment (x402 invoice) plus, for some workflows, a workflow-author API key for the underlying service the workflow wraps (e.g. a Helius RPC key, an Etherscan key). The docs don't make the auth split obvious — I assumed for a day that paying the x402 invoice was the only auth required, and got 401s on workflows that need pass-through auth.

**Impact.** Lost half a day debugging a 401 that turned out to be a missing pass-through auth field on the `call_workflow` request. The error string was generic ("workflow auth failed"), which didn't disambiguate "your x402 payment didn't land" from "the workflow needs an additional auth header you didn't send".

**Suggestion.** Disambiguate auth errors: `x402_payment_missing_or_invalid` vs `workflow_pass_through_auth_missing` vs `workflow_pass_through_auth_invalid`. In `search_workflows`, mark workflows that require pass-through auth and list which fields. For the consumer agent, knowing in advance that workflow-X needs a Helius key field is the difference between "I can call this" and "I trial-and-error my way to a working call".

---

## 6 — Spend-policy enforcement is per-call, not per-job

**What I hit.** agentcash spend policies enforce against per-call amounts. For QUORUM, a single logical "verdict job" can include the original `call_workflow` plus 2–3 retry calls if Jito misses the first bundle slot. The per-call envelope is right for the common case but doesn't compose into a per-job ceiling. An agent that wants to say "this verdict is worth at most $0.10 to land, including retries" has to track that envelope client-side.

**Impact.** Treasurer maintains a per-job ledger that's a layer above the agentcash policy. Two policies, two enforcement points, two failure modes. Works, but it's the kind of thing that slowly diverges in production unless the integration is careful.

**Suggestion.** Add a per-job envelope policy: "any sequence of `call_workflow` requests tagged with the same `job_id` is capped at $X total across retries". This composes naturally with the per-call ceiling and gives the agent a server-side enforcement point that matches its own budget model.

---

## 7 — Webhook signature verification example uses a different lib than the one the SDK ships

**What I hit.** The agentcash SDK ships with a webhook-signing helper (HMAC verification of the X-KH-Signature header). The docs example for verifying the webhook in your handler uses a different crypto lib (raw `crypto` Node module with manual constant-time compare) without referencing the SDK helper. I implemented manual verification first because that's what the docs showed; later realised the SDK had it built in.

**Impact.** Wrote 20 lines of HMAC-compare code I didn't need. Net cost: small. But it's the kind of inconsistency that signals "the docs and the SDK haven't been reconciled in a while", which makes integrators read both sceptically.

**Suggestion.** Update the webhook-handling docs to reference the SDK helper as the canonical path, and keep the manual-crypto example as a fallback for non-Node integrators. A single source of truth, with clear "use this if you're in Node, use this if you're not" branching.

---

## What worked well

- The `search_workflows` → `call_workflow` two-step is the right shape for agent integrators. It separates discovery from invocation, which lets Executor cache discovery results and only invoke on hot path.
- x402 invoicing on Base is the right rail for agent-paid execution. The 402 handshake feels native to the agent loop in a way that pre-funded escrow does not.
- Jito bundle landing latency on Base is consistently sub-2s for non-pump-event blocks. Predictable enough that I could tune Treasurer's reservation/release window without padding excessively.
- The agentcash dashboard's "spent this hour / spent today" widgets matched my client-side ledger to the cent over a 4-day comparison window. The accounting is real, not approximate.
- Documentation tone is honest about what's stable vs what's evolving — separate "preview" / "stable" tags on endpoints saved me from depending on something fragile by accident.

---

## Closing

KH is shipping the right primitive for the part of the agent stack everyone else is hand-rolling. The friction items above are integration-time, not architecture-time — they slow autonomous agents down but don't stop them. Most resolve with explicit documentation rather than API changes. Items 1, 3, and 5 are the ones I'd prioritize: they're the ones where an autonomous agent's failure mode is silent or ambiguous, and silent failure is the hardest class to debug at machine speed.

The combined Uniswap-Trading-API + KeeperHub-execution + x402-funded-by-Treasurer pattern is going to be a category, not a one-off. Both partners are shipping the right things — the items above are the polish that makes the category possible to build against without spelunking.

Happy to talk through any of these in more depth.

— Tom Smart, [smartflowproai.substack.com](https://smartflowproai.substack.com)
