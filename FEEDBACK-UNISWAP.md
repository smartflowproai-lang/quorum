# Uniswap Trading API — integration feedback from QUORUM

Builder: Tom Smart ([@TomSmart_ai](https://x.com/TomSmart_ai))
Project: QUORUM (ETHGlobal OpenAgents 2026)
Integration period: 2026-04-24 → 2026-05-03
Treasurer EOA: `0xd779cE46567d21b9918F24f0640cA5Ad6058C893`

This is the partner-feedback bounty submission ($250) for the Uniswap Foundation track. Each item is a real friction point I hit wiring Treasurer against the Trading API on Base mainnet for autonomous x402 float top-ups. Format per item: **what I hit · impact on the build · what I'd change**.

---

## 1 — Permit2 `primaryType` ambiguity in `/v1/quote` response

**What I hit.** The `permitData` returned by `/v1/quote` has `types` for both `PermitTransferFrom` and `PermitBatchTransferFrom`, plus `EIP712Domain`. The `primaryType` field tells you which one to sign — but the docs don't *guarantee* it's always populated. In our quote fixtures (`agents/treasurer/test/fixtures/quote-weth-usdc.json`) `primaryType` is always present, and our schema test asserts it as required, but the docs reference doesn't mandate it. We hardcoded a candidate list (`['PermitSingle', 'PermitTransferFrom', 'PermitBatchTransferFrom', 'PermitBatch']` in `agents/treasurer/uniswap-client.ts:244-257`) defensively in case a future response omits it.

**Impact.** An early signing iteration failed locally before broadcast because the wrong types object was being hashed against the wrong primary type — caught in pre-broadcast verification, no on-chain failure. But "we got lucky because we caught it client-side" is not a contract; another integrator in the same shape may not catch it before they hit `/v1/swap`.

**Suggestion.** Mandate `primaryType` in the response schema. If the Trading API guarantees it across all single-asset and batch shapes, document that guarantee — that lets us drop the candidate-list heuristic.

---

## 2 — Base mainnet vs Base Sepolia chainId mismatch between docs and client behaviour

**What I hit.** Wired Treasurer for `chainId: 84532` (Base Sepolia) thinking testnet was live — the docs page listed "Base" without separating testnet from mainnet. Our own client (`agents/treasurer/uniswap-client.ts`) ended up throwing `UnsupportedChainError` for 84532 (`agents/treasurer/test/uniswap-client.test.ts:70-80` covers that), which is what saved us — but the test was added *after* I'd burned the time figuring out the support matrix the hard way. I don't have a clean transcript of the upstream `/v1/quote` behaviour against 84532 saved (no `requestId` captured at the time), so I can't say definitively whether the API rejected at `/quote` or at `/swap` — but the time cost was the docs gap.

**Impact.** ~30 minutes of debugging where I thought my Permit2 signature was wrong because the chain support matrix wasn't clear from the docs alone. Real fix: send `chainId: 8453` and re-quote; add `UnsupportedChainError` client-side so the next integrator doesn't repeat it.

**Suggestion.** Document the supported-chain matrix per endpoint (`/quote` vs `/swap` vs others) in one table on the docs landing page. If a chain is accepted at `/quote` but not at `/swap`, call that out explicitly — quoting on a chain you can't swap on is a footgun. If the canonical behaviour is to reject unsupported chains at `/quote` time with `400 unsupported_chain`, document the response shape so client-side guards can match it.

---

## 3 — `EXACT_OUTPUT` semantics for x402 use cases (design note — not yet shipped)

**What I hit.** This is a design note, not a friction point I shipped through. Treasurer's natural pattern is "I need exactly N USDC by end of this call to pay an x402 invoice — start from whatever I have." That's `EXACT_OUTPUT` semantically. But what we shipped today is `EXACT_INPUT` only (`agents/treasurer/uniswap-client.ts:183` hardcodes `type: 'EXACT_INPUT'`; `agents/treasurer/x402-handler.ts:104` flags `EXACT_OUTPUT` as the production target in a code comment). The reasoning was: get a clean swap path on-chain end-to-end first, then swap-in `EXACT_OUTPUT` once the broadcast and reconciliation paths are stable. So the "friction" is forward-looking — when we move to `EXACT_OUTPUT`, the dance gets longer.

**Impact (forward).** With `EXACT_INPUT` I know exactly how much WETH leaves the wallet but not how much USDC I get. With `EXACT_OUTPUT` I'd know exactly how much USDC I get but the input amount moves with price impact, and `permitData` is signed against `maxAmountIn` — which can be way above the realistic spend if slippage is generous. The four-step dance becomes: `quote EXACT_OUTPUT` → check `maxAmountIn` is within float headroom → sign Permit2 → swap → reconcile actual input from receipt. Permit2 signs the worst case, so the agent is effectively granting the universal router temporary authority over more than it'll spend.

**Suggestion.** Add a `tightenPermit2` boolean (or document a recommended pattern) where `permitData.amount` is set to a tighter envelope: e.g. `quotedAmountIn * (1 + slippageTolerance)` rather than `maxAmountIn`. For x402 use cases where the agent wants to limit blast radius if the swap fails, the tight envelope matters. Happy to send a concrete repro once we've shipped the `EXACT_OUTPUT` path.

---

## 4 — Undocumented protocol selection defaults

**What I hit.** `/v1/quote` accepts a `protocols` array — V2, V3, V4, UniswapX. Omitting it returns a quote, but the docs don't say which protocols are considered by default. Reading the API reference I expected UniswapX would be opt-in (it requires off-chain order flow with filler-based settlement, which is genuinely different from a same-tx swap), but the docs don't actually state that — so we shipped with `protocols: ['V3', 'V4']` hardcoded defensively (`agents/treasurer/uniswap-client.ts:192-193`, comment: "V3 + V4 only — UniswapX is async/off-chain, bad for live demos"). Every treasurer commit since the first one (`f45ba71`) has had this hardcode; we never let the default ride.

**Impact.** Direct impact was zero (we never hit a UniswapX route because we never let the default ride), but the design cost was real: we had to read the SDK source to convince ourselves what the default actually was, and we couldn't. For an agent integrator, "I don't know which protocols my caller is opting into when they pass nothing" is the exact ambiguity that drives defensive hardcodes across every integrator's codebase.

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

**Suggestion.** Document the recommended "log pending intent → reconcile on receipt" pattern in the agent integration guide. (We considered "include calldata + signed nonce so the agent can derive a tx hash pre-broadcast" but the canonical Ethereum tx hash is `keccak256(rlp(signed_tx))` — it depends on the wallet's nonce, gas params, and the agent's signature, all of which sit on the agent side, not the Trading API side. Conflating Permit2's typed-data nonce with the Ethereum account nonce isn't the right ask. The intent-log → reconcile pattern is the right one.)

---

## 7 — Agent-integration docs gap for Permit2 nonce management

**What I hit.** Permit2 has two distinct nonce schemes — sequential (AllowanceTransfer) and unordered/bitmap (SignatureTransfer). The Trading API docs don't specify which scheme `permitData.nonce` uses for `/v1/quote` responses. For an autonomous retrier, that matters: with SignatureTransfer (bitmap-bound), re-submitting a signed permit on transient RPC failure is safe as long as the bitmap word/position hasn't been consumed; with AllowanceTransfer (sequential), the same retry can corrupt the nonce sequence. Today our `swap()` path (`agents/treasurer/uniswap-client.ts:363-385`) re-quotes from scratch on every retry — `permitData.nonce` isn't read by the code at all — so we don't depend on the answer; but an aggressive integrator who tries to reuse a signed permit needs to know which scheme they're standing on.

**Impact.** Today: zero. We re-quote, so we burn an extra round-trip on every retry but never risk a stuck signature. Tomorrow: an aggressive integrator who skips the re-quote to save the round-trip can get the nonce semantics wrong and end up with a stuck signature.

**Suggestion.** Document which Permit2 nonce scheme `/v1/quote` returns. Add a section to the Trading API docs titled "Agent integration: signing once, broadcasting many times" covering nonce semantics, deadline reuse, and the recommended retry pattern. The "I'm an autonomous agent that retries on RPC failure" use case is going to be the dominant one in the next 18 months — documenting which scheme is in use lets agent integrators decide whether to skip the re-quote round-trip safely.

---

## What worked well

- The single `x-api-key` auth model is right for agent integrators. Per-call request signing would have been a blocker.
- `/v1/quote` latency on Base was consistently under 600ms across the build window so far. Predictable enough to build retry budgets around — I'll publish percentiles once the chaos rig captures a longer continuous-operation sample post-hackathon.
- The `permitData` shape, once understood, is clean — EIP-712 standard, no Uniswap-specific surprises.
- The Trading API's separation of quote and swap (rather than one bundled call) is the right shape for autonomous agents that want to introspect the price before committing.

---

## Closing

Items 1, 2, and 4 are the silent-failure ones — happy to share request IDs, fixture diffs, or tx hashes if useful.

— Tom Smart, [smartflowproai.substack.com](https://smartflowproai.substack.com)
