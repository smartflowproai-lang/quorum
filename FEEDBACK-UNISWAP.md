# Uniswap Trading API — integration feedback from QUORUM

Builder: Tom Smart ([@TomSmart_ai](https://x.com/TomSmart_ai))
Project: QUORUM (ETHGlobal OpenAgents 2026)
Integration period: 2026-04-24 → 2026-05-03
Treasurer EOA: `0xd779cE46567d21b9918F24f0640cA5Ad6058C893`

This is the partner-feedback bounty submission ($250) for the Uniswap Foundation track. Each item is a real friction point I hit wiring Treasurer against the Trading API on Base mainnet for autonomous x402 float top-ups. Format per item: **what I hit · impact on the build · what I'd change**.

---

## 1 — Permit2 `primaryType` ambiguity in `/v1/quote` response

**What I hit.** The `permitData` returned by `/v1/quote` has `types` for both `PermitTransferFrom` and `PermitBatchTransferFrom`, plus `EIP712Domain`. The `primaryType` field tells you which one to sign — but the docs example shows the field present, the actual response sometimes omits it for single-asset swaps and falls back to "the first non-domain type alphabetically". I shipped a working signer twice (once thinking it was deterministic by position, once by `primaryType`) and only the second one verifies on-chain.

**Impact.** Two failed swaps on Base before I figured out which signing object was canonical. Treasurer's reservation/release pattern caught it (reserved float was released back, no funds stuck), but each round trip costs gas + RPC time. For an autonomous agent that pays per call, that's a real hit.

**Suggestion.** Make `primaryType` mandatory in the response schema. If the Trading API guarantees it, document that guarantee. If it doesn't, document the fallback rule explicitly with an example.

---

## 2 — Base mainnet vs Base Sepolia chainId confusion in error responses

**What I hit.** Sent a quote request with `chainId: 84532` (Sepolia) thinking I was hitting testnet — the API returned `200 OK` with a quote, then `/v1/swap` errored with `Unsupported chain` instead of a chain-binding error. I read the docs page that listed "Base" and assumed both testnet and mainnet were live; the actual support is mainnet only (8453). The 200 on `/v1/quote` for an unsupported chain is the surprising bit.

**Impact.** ~30 minutes of debugging where I thought my Permit2 signature was wrong (because `/v1/swap` rejected the same `chainId` that `/v1/quote` accepted). Real fix: send `chainId: 8453` and re-quote.

**Suggestion.** Either reject unsupported `chainId` at `/v1/quote` time with a clear `400 unsupported_chain` (preferred), or explicitly document which chains the quote endpoint accepts vs the swap endpoint. The current behavior — quoting on chains you can't swap on — is a footgun.

---

## 3 — `EXACT_OUTPUT` semantics for x402 use cases

**What I hit.** Treasurer's pattern is "I need exactly N USDC by end of this call to pay an x402 invoice — start from whatever I have." That's `EXACT_OUTPUT` semantically, but the Trading API's `EXACT_OUTPUT` quotes optimize for output, not for input certainty. With `EXACT_INPUT` I know exactly how much WETH leaves the wallet but not how much USDC I get; with `EXACT_OUTPUT` I know exactly how much USDC I get but the input amount can move with price impact, and the `permitData` is signed against `maxAmountIn`, which can be way above the realistic spend if slippage is generous.

**Impact.** For an agent that needs to commit to a specific x402 payment amount, the dance is: `quote EXACT_OUTPUT` → check `maxAmountIn` is within float headroom → sign Permit2 → swap → reconcile actual input from receipt. That's four steps where it should be one. And Permit2 signs the worst case, so you're effectively granting the universal router temporary authority over more than you'll spend.

**Suggestion.** Add a `tightenPermit2` boolean (or document a recommended pattern) where `permitData.amount` is set to a tighter envelope: e.g. `quotedAmountIn * (1 + slippageTolerance)` rather than `maxAmountIn`. For x402 use cases where the agent wants to limit blast radius if the swap fails, the tight envelope matters.

---

## 4 — Undocumented protocol selection defaults

**What I hit.** `/v1/quote` accepts a `protocols` array — V2, V3, V4, UniswapX. Omitting it returns a quote, but the docs don't say which protocols are considered by default. I assumed UniswapX would be opt-in (it requires off-chain order flow with different settlement semantics); turned out my default quotes were sometimes routing through UniswapX, which changed the on-chain tx shape Treasurer had to handle. Specifically, UniswapX orders settle via filler — Treasurer's "post tx, wait for receipt" loop didn't have the right logic for the order-with-no-immediate-tx case.

**Impact.** First few automated top-ups didn't broadcast on-chain at all because UniswapX route had been picked and Treasurer's post-quote logic assumed a same-tx settlement. I caught it in the AXL settlement reply timeout, not in the swap broadcast — meaning the agent failure mode was "no error, just silence". That's the worst kind of failure for an autonomous agent.

**Suggestion.** Document the default `protocols` set explicitly in `/v1/quote`. Add a per-protocol settlement-shape note (V2/V3/V4 = same-tx, UniswapX = off-chain order with filler). For agent integrations, recommend `protocols: ["V3", "V4"]` as the safe default, with UniswapX as an opt-in flag for callers that have implemented order tracking.

---

## 5 — Quote staleness window vs Permit2 deadline mismatch

**What I hit.** `/v1/quote` returns a quote with implicit freshness (it's a snapshot of pool state). `permitData.deadline` is set far in the future — typically minutes to hours. So you can sign Permit2 against a quote, sit on it for 30 seconds, broadcast, and the swap succeeds at a price that has drifted significantly from the quoted price. The slippage parameter limits the damage, but the docs don't surface "treat the quote as stale after N seconds" as the recommendation.

**Impact.** Treasurer's float top-up retry loop almost re-used a 90-second-old quote when the first broadcast failed (it didn't, because I added a manual TTL — but the retry logic could have).

**Suggestion.** Add a `quoteValidUntil` field to the quote response (recommended max age, not enforced). Document the recommended pattern: re-quote on every retry, not re-use. For autonomous agents that retry on RPC failure, the implicit-staleness model is dangerous — make freshness explicit.

---

## 6 — `/v1/swap` response missing canonical tx hash before broadcast

**What I hit.** `/v1/swap` returns a calldata blob and recommended gas. The agent (Treasurer) signs and broadcasts. The tx hash isn't known until `eth_sendRawTransaction` returns it, which means the Trading API → broadcast → settlement-receipt loop has three places where the swap can fail, and only the third returns a hash. For an autonomous agent that wants to log "I attempted swap X" before the broadcast result is known, there's no canonical handle.

**Impact.** Treasurer's `payments.db` schema needed a "pending swap" row that gets reconciled with the actual hash post-broadcast. Doable but adds a state machine I wouldn't have needed if the API returned a deterministic tx-hash-or-pre-hash that the agent could log up front.

**Suggestion.** Either include the calldata + signed nonce in a way that lets the agent compute the future tx hash before broadcast, or document the recommended "log pending intent → reconcile on receipt" pattern in the agent integration guide.

---

## 7 — Agent-integration docs gap for Permit2 nonce management

**What I hit.** The Permit2 nonce is part of `permitData` returned by the API. The docs cover the "user-clicks-swap" flow well — agent flow is implicit. For Treasurer, the question of "what happens if I sign a Permit2 with nonce N, broadcast fails, and I want to retry" wasn't covered. (Answer, after spelunking the Permit2 contract: nonces are bitmap-bound per (owner, word, position), so re-using N is fine if N hasn't been consumed yet — but the Trading API doesn't tell you that.)

**Impact.** I conservatively re-quoted on every retry to get a fresh nonce, when in some cases the same Permit2 was reusable. Wasteful but correct. An aggressive integrator could plausibly get the nonce semantics wrong and end up with a stuck signature.

**Suggestion.** Add a section to the Trading API docs titled "Agent integration: signing once, broadcasting many times" covering Permit2 nonce semantics, deadline reuse, and the recommended retry pattern. The "I'm an autonomous agent that retries" use case is going to be the dominant one in the next 18 months — the docs should lead it, not trail it.

---

## What worked well

- The single `x-api-key` auth model is right for agent integrators. Per-call request signing would have been a blocker.
- `/v1/quote` latency on Base was consistently under 600ms in my measurements over 10 days. Predictable enough to build retry budgets around.
- The `permitData` shape, once understood, is clean — EIP-712 standard, no Uniswap-specific surprises.
- The Trading API's separation of quote and swap (rather than one bundled call) is the right shape for autonomous agents that want to introspect the price before committing.

---

## Closing

The Trading API is the right primitive for the pay-with-any-token pattern. The friction items above are integration-time, not architecture-time — they slow autonomous agents down but don't stop them. Most resolve with explicit documentation rather than API changes. Items 1, 2, and 4 are the ones I'd prioritize: they're the ones where an autonomous agent's failure mode is silent, and silent failure is the hardest class to debug at machine speed.

Happy to talk through any of these in more depth.

— Tom Smart, [smartflowproai.substack.com](https://smartflowproai.substack.com)
