# Gensyn AXL — integration feedback from QUORUM

Builder: Tom Smart ([@TomSmart_ai](https://x.com/TomSmart_ai))
Project: QUORUM (ETHGlobal OpenAgents 2026)
Integration period: 2026-04-24 → 2026-05-03
Frankfurt host: `143.244.204.114` · NYC host: `159.65.172.200`
Treasurer EOA: `0xd779cE46567d21b9918F24f0640cA5Ad6058C893`

This is the partner-feedback bounty submission for the Gensyn AXL primary-sponsor track. Each item is a real friction point I hit wiring Verifier (NYC) against Frankfurt Scout/Judge over the AXL mesh, with x402 payment flow funded cross-continent by Treasurer. Bidirectional Frankfurt ↔ NYC roundtrip was verified Day-1 (commit `777cc08`, `infra/axl-hello.sh`); the on-chain anchor is Treasurer's first Base mainnet swap [`0xc03b8350...79b49849`](https://basescan.org/tx/0xc03b8350c982c805e5e2b4aa072fb69138e26c2364b7a70c3ef3b34079b49849), block 45,300,516. Format per item: **what I tried · what I expected · what happened · suggestion**.

## Why this feedback is shaped differently than most

Most AXL integration feedback is one builder, one box, one weekend. Mine is filtered through (a) a real two-continent deployment — Frankfurt VPS running Scout + Judge, NYC VPS running Verifier + Executor + Treasurer, both AXL nodes PM2-wrapped, each AXL node's public TLS listener bound to port 9001 and reached over the Yggdrasil-routable IPv6 namespace since 2026-04-24 — and (b) the public x402 dataset feeding Scout (pre-existing data sources catalogued before the build window — see `DATA-COVERAGE.md` for scope and provenance): 22,074 endpoints across the three primary x402 registries plus tail sources, 7,248,641 raw Base mainnet x402 payment candidates indexed over a 20.04-day window (2026-04-12 → 2026-05-02 10:02 UTC), 4,000,062 clean payments after wash filter, 20.21% / 808,294 of the clean subset facilitator-classified (most-recent state `lockfile-2026-05-02-evening.json` regenerated from `payments.db` 2026-05-02 10:45 UTC; submission lock at `lockfile-2026-04-30-evening.json` superseded by 2 days of live backfill: 15.01% → 20.21%; balance still mid-backfill against Base RPC `eth_getTransactionByHash`).

That two-surface visibility shaped the items. I'm not just describing what bit me at boot — I can see the underlying x402 traffic shape on Base today and can ground-truth predictions about where AXL bends when agent-mesh volume routes through it. Items 3 and 6 below in particular come from that visibility, not from "here's what bit me on Tuesday".

The integration has two surfaces: the operator surface (peering, identity rotation, observability, failover) and the agent-runtime surface (typed message envelopes, queue-on-disconnect semantics, signed-roundtrip latency under burst). Items below mix both because both matter for autonomous-agent integrators running multi-region.

---

## 1 — Frankfurt ↔ NYC initial handshake: NAT/firewall/DNS surface is mostly silent on failure

**What I tried.** Stand up two AXL nodes on fresh DigitalOcean droplets (Frankfurt and NYC), peer them over TLS port 9001 on Yggdrasil, watch the bidirectional handshake complete. Standard "cross-continent mesh in under an hour" expectation.

**What I expected.** Either a successful peer link or a clear, single-line error in the node log telling me what failed (DNS resolution? TCP unreachable? TLS cert mismatch? Wrong public-key fingerprint?). On a clean cloud-VPS pair, "it just connects" is the modal expectation; on a misconfigured pair, "it tells me what's wrong" is the next-best.

**What happened.** First attempt: silent. Frankfurt node reported "listening", NYC node reported "listening", neither logged a peer connection nor a connection attempt failure. Took me 25 minutes to realise the Frankfurt droplet's `ufw` was blocking 9001 inbound (that's the default — `default deny incoming / default allow outgoing` on a fresh DigitalOcean Ubuntu droplet), and the NYC dialler had no log line telling it the SYN was being dropped at the peer. Once 9001 was opened on Frankfurt the handshake completed in under 2 seconds, and `Connected inbound` is the line captured in `logs/d1-axl-mesh-live.log` section 3 (Frankfurt-side capture; the NYC-side `Connected outbound` line lives in NYC's PM2 log, not in this file — see item 6 for why mesh observability really wants a `/metrics` endpoint instead of grepping PM2 stdout). The asymmetry that bit me: the listening side is loud once it accepts, the dialling side is silent until it doesn't.

**Suggestion.** Add a periodic "peer dial attempt" log line on the outbound side — even at INFO level once per minute per configured peer that hasn't connected. Something like `peer X unreachable: connect ETIMEDOUT (n attempts since boot)` would have collapsed my 25-minute debug into 30 seconds. Bonus: a `axl diagnose` subcommand that does the cloud-VPS sanity check (DNS resolves, port reachable from the other side, TLS handshake completes) and prints a single-screen verdict.

---

## 2 — AXL message backpressure when downstream agent (Verifier) is slow

**What I tried.** Throttle Verifier deliberately (sleep 800ms inside the verdict handler) while Judge in Frankfurt kept emitting `verdict_request` envelopes at a steady 5/s. The point was to characterise what AXL does when the receiver can't drain its inbox as fast as the sender fills it — because the production failure mode is "Verifier hits a slow RPC and falls behind", not "Verifier crashes".

**What I expected.** Either explicit backpressure surfaced to the sender (a 429-equivalent on `/send`, or a queue-depth signal in `/topology`) or a documented bound on the receiver's inbox (e.g. "we hold up to N messages per peer, then drop oldest / drop newest / disconnect"). Knowing which of those is the policy is what makes Judge's emit loop safe.

**What happened.** No backpressure signal, no documented bound. Frankfurt's `/send` kept returning 200 OK while the NYC inbox grew. After ~90 seconds I pulled `/recv` and got back a single ~4 MB JSON payload with several hundred queued envelopes — meaning the inbox is unbounded as far as I could observe, and the cost shows up as a latency cliff on the next `/recv` call rather than as an error on `/send`. For an agent that polls `/recv` every 500-1000 ms, a 4 MB drain blocks the event loop noticeably; for one that polls every 100 ms under load, it cascades. The wrong layer pays the cost.

**Suggestion.** Document the inbox bound (per-peer or global), and add a `queue_depth` field to `/topology` per peer so the sender can self-throttle. Even better: expose backpressure as a 429 on `/send` once the receiver's inbox crosses a threshold — that lets sender-side flow control be explicit instead of guessed. For QUORUM's pattern (Judge bursts during smart-money-active windows), Frankfurt would happily slow its emit rate if it had a signal to respond to.

---

## 3 — Signed roundtrip latency: median is clean, tail behaviour under burst patterns is the surprise

**What I tried.** Measure end-to-end signed-roundtrip latency Frankfurt → NYC → Frankfurt: Judge signs a verdict (ed25519), AXL ships it across, Verifier validates + counter-signs an attestation envelope, AXL ships the attestation back, Judge verifies the counter-signature. This is the hot path for any cross-continent quorum primitive — if the tail is bad here, every downstream budget (Treasurer reservation window, Executor settle-or-retry loop) is wrong.

**What I expected.** Frankfurt-NYC RTT at the network layer is ~84-92 ms on these droplets (confirmed via plain ICMP). On top of that I budgeted ~10 ms for ed25519 sign-verify-sign-verify and ~20 ms for AXL framing + JSON serialisation each way. Total p50 budget: ~130-150 ms. p95 budget with one queue-tick of slack: ~250 ms.

**What happened.** Median was within budget — measured p50 was 138 ms over a 30-minute clean window, which lines up. The tail was the surprise. During simulated bursts (Judge emitting at 12-15/s for 10-second windows, modelled on the burst shape I see in observatory data — clean Base x402 payment volume averages ~200K/day across the 20.04-day window in `lockfile-2026-05-02-evening.json`, with the top facilitator-class signing addresses clustering in 5-second emit windows worth several multiples of baseline), p95 climbed to 480 ms and p99 hit 1.4 s. The latency cliff lined up exactly with the inbox growth pattern from item 2 — the bound isn't compute (ed25519 is trivial) and isn't network (RTT is stable), it's framing/serialisation queueing on the receiver. Treasurer's reservation window was set to 500 ms on the assumption of a calmer p95; I bumped it to 2 s after observing the tail.

**Suggestion.** Publish observed p50/p95/p99 latency for the AXL signed-roundtrip primitive across a documented hop pair (e.g. eu-central → us-east-1) — even a static "as-of last week" snapshot in the docs would let mesh integrators size budgets without measuring it themselves. Bonus: surface a per-peer `recent_p95_ms` field in `/topology` so an agent can adapt its reservation-window math live instead of statically.

---

## 4 — Cross-continent x402 payment flow: AXL signed envelope vs x402 facilitator settlement timing

**What I tried.** Wire Treasurer (NYC) to fund Executor's gas via x402 on Base, where the gas request originates as a signed AXL envelope (`gas_request`) from Executor → Treasurer same-host, but the upstream `verdict → attestation` flow that triggers the gas request crosses Frankfurt → NYC over AXL. End-to-end: verdict signed in Frankfurt, AXL ships to NYC, Verifier counter-signs, Executor emits `gas_request` to local Treasurer, Treasurer pays via x402 facilitator on Base, settlement receipt comes back, Executor lands the attestation. Two signing layers (AXL ed25519 + x402 facilitator) with non-overlapping clocks.

**What I expected.** A clean composition: AXL handles the inter-agent signed transport, x402 handles the inter-agent payment settlement, the two don't fight each other. The AXL envelope's `ts` field and the x402 facilitator's settlement timestamp should be independently correct; the agent reconciles them in its own ledger.

**What happened.** Composition works, but the failure mode I almost shipped was clock skew between the two signing layers. AXL's `ts` is set by the receiving node (per the `axlRecv()` envelope shape in `shared/axl-wrap.ts`), so a Frankfurt-emitted verdict gets stamped with NYC's wall clock on receive — fine. The x402 facilitator settlement timestamp is set by the facilitator's own clock. When I cross-referenced the two for a verdict-to-settlement audit trail, I had two `ts` fields that looked comparable but weren't (one is "received-by-NYC-AXL-node", one is "settled-by-facilitator-on-Base") and they could differ by minutes during congestion. An audit query that joined them naively produced what looked like out-of-order events.

**Suggestion.** Document the AXL envelope `ts` semantics explicitly: "this is the receive-node wall-clock at delivery time, not the sender's emit time". If sender-side timestamping is desired, recommend adding a `sender_ts` field inside the payload at the application layer. For the cross-continent x402 use case specifically: a docs note titled "Composing AXL transport with x402 settlement" covering clock semantics, expected skew, and recommended audit-trail joins would save every multi-region builder this same hour of confusion.

---

## 5 — Multi-region verifier failover: NYC node dies, Frankfurt has no documented redirect path

**What I tried.** Kill the NYC AXL node mid-flight (literally `pm2 stop axl-nyc` while Frankfurt was emitting verdicts at 3/s). Observe what happens. The point is to characterise the failover surface — for a real production multi-region deployment the question isn't "if a region drops" but "when, and what's the recovery shape".

**What I expected.** Either (a) AXL queues messages on the Frankfurt side and drains them when NYC reconnects (acceptable — agents handle this with idempotency on receive), or (b) AXL surfaces the disconnect immediately on `/send` so the sender can route to a secondary peer (acceptable — agents handle this with explicit failover logic), or (c) some documented combination. Any of those is fine; what's not fine is an undefined behaviour I have to discover by observation.

**What happened.** Frankfurt's `/send` continued to return 200 OK for ~12 seconds after I killed the NYC node — TLS keepalive grace plus internal retry layer, I assume. After that the `/send` calls started returning errors (status 503 with body `peer unreachable`), which is correct, but the 12-second window of false-positives is dangerous: Judge thinks 36 verdicts succeeded that NYC never received. On NYC reboot, AXL did not replay the 36 lost verdicts — they're gone unless the application layer persisted them. There's no documented "queue while peer down, drain on reconnect" guarantee that I could find, and observation suggests it's not the default.

The right pattern (which I implemented) is: every emit goes through Judge's local persistent queue first, application-level idempotency on receive, drain queue on AXL `Connected outbound` log line. But that's the application doing the work AXL might be expected to do at the transport layer.

**Suggestion.** Document the failover behaviour explicitly: "AXL does not durably queue on the sender side when the peer is unreachable; the application layer is responsible for replay". Or, if durable queueing is on the roadmap, document it as such. For a multi-region production target, this is the single most important behaviour to nail in docs — every team that deploys multi-region will hit this and the silent-loss failure mode is the worst class.

---

## 6 — AXL mesh observability: no built-in metrics for queue depth, peer lag, or message rates

**What I tried.** Wire AXL into the QUORUM dashboard. Standard ops-grade asks: per-peer message rate (in/out), queue depth, last-successful-send timestamp, last-successful-receive timestamp, peer connection state (connected / dialling / failed). The agents themselves export Prometheus metrics; I wanted AXL to too, so the mesh-layer health was visible alongside agent-layer health.

**What I expected.** A `/metrics` endpoint exposing standard mesh telemetry (Prometheus or even a JSON dump). Or at minimum a structured log format I could grep with predictable line shapes.

**What happened.** Neither. The information is partially derivable: `/topology` gives peer state, `axl-frankfurt` PM2 logs include `Connected inbound` / `Connected outbound` lines, but there's no queue depth, no message-rate gauge, no last-success timestamps. To get them into the dashboard I had to (a) tail PM2 logs and parse the connection-event lines into a state machine, (b) instrument my own send/recv wrappers (`shared/axl-wrap.ts`) to count and time-stamp each call, (c) infer queue depth indirectly by measuring `/recv` payload sizes over time. That's three custom layers to recover what should be one `/metrics` endpoint.

For the observatory comparison: 20.21% of the 4M-payment clean subset is facilitator-classified today (`lockfile-2026-05-02-evening.json`; submission lock 15.01% / 3.4M at `lockfile-2026-04-30-evening.json` superseded by 2 days of live backfill), and the gap to 100% is a backfill problem, not an instrumentation problem — the data exists, it's just not surfaced fast enough. AXL feels the same way: the runtime knows queue depth, knows peer lag, knows message rates, but doesn't expose them. At single-mesh hackathon scale this is annoying; at production multi-region scale this is "I cannot tell you why the verifier fell behind".

**Suggestion.** Ship a `/metrics` endpoint (Prometheus exposition format is the de facto standard; OpenMetrics is fine too). Minimum useful set: `axl_peer_connected{peer=}`, `axl_peer_queue_depth{peer=,direction=in|out}`, `axl_messages_sent_total{peer=}`, `axl_messages_received_total{peer=}`, `axl_send_duration_seconds_bucket{peer=}`. That's six metrics that would have collapsed every "is the mesh healthy?" question into a single Grafana panel.

---

## 7 — Documentation gaps: agent-runtime surface vs operator surface aren't separated

**What I tried.** Read the AXL docs end-to-end before writing a single line of `shared/axl-wrap.ts`. The questions I had going in: what's the stable API for an agent to send/receive messages, what's the wire format, what's the auth model, what's the lifecycle (connect / handshake / disconnect / reconnect), what's the failure surface.

**What I expected.** A clear split between the operator-facing docs (how to install, peer, secure, monitor) and the agent-facing docs (here's the HTTP API on `localhost:9002`, here's the envelope shape, here's the recommended polling cadence, here's how to handle a disconnect).

**What happened.** The operator surface is reasonably documented; the agent-runtime surface is implicit. I learned the HTTP API shape from a combination of (a) reading the node startup log carefully for the port number, (b) trial-and-error with `curl` against `/send`, `/recv`, `/topology`, and (c) inspecting the envelope JSON returned by `/recv` to figure out the field shapes (`from`, `data`, `ts`). My `axl-wrap.ts` ended up being ~100 lines of code plus another ~100 lines of comments explaining the contract I'd reverse-engineered. The code is now MIT-licensed and will be useful to the next team — but the next team should not have to reverse-engineer the contract in the first place.

The specific gaps that cost the most time: (a) is `/recv` destructive-on-read or do I need to ack? (it's destructive — I confirmed by sending a single message and calling `/recv` twice; the second call returned empty). (b) what's the `from` field — agent ID, peer ID, or public-key fingerprint? (it's the logical agent name, but I had to test). (c) does `/send` block until the peer ack'd, or does it queue locally and return? (it queues locally and returns; see item 5 for the failure mode that exposes).

**Suggestion.** Add a docs page titled "AXL agent-runtime API (`localhost:9002`)" covering: endpoint list, request/response shapes (with example JSON), envelope semantics (especially the `ts` field — see item 4), polling cadence recommendations, ack / destructive-read semantics on `/recv`, failure shapes with status codes. Treat it as the canonical surface for any agent integrator. If `axl-wrap.ts` (MIT) is useful as a reference TypeScript implementation, link to it from those docs.

---

## What worked well

- The **bidirectional Frankfurt ↔ NYC roundtrip** worked first try once the firewall was open. Sub-2s handshake, both AXL listeners stayed reachable on both sides over the build window — restart counts on the Frankfurt PM2 process are elevated (700 restarts over 44h captured in `logs/d1-axl-mesh-live.log` section 1; partition-recovery procedure documented in [`CHAOS-TEST.md`](./CHAOS-TEST.md) against the same node pair, raw run log committed at [`logs/d8-chaos-recovery.log`](./logs/d8-chaos-recovery.log), reproducible script at [`infra/chaos-axl-failover.sh`](./infra/chaos-axl-failover.sh), live mesh-state snapshot at [`logs/d8-axl-mesh-current-state.json`](./logs/d8-axl-mesh-current-state.json) showing the same Frankfurt pubkey and an active ESTAB to NYC over a fresh ephemeral port two days after the chaos run). Working hypothesis is a TLS-keepalive / Yggdrasil-reroute interaction that drops the AXL listener on stale routes and PM2 catches it cleanly — root cause investigation continues post-hackathon and is the open issue I'd most want a Gensyn engineer's eyes on. Happy to file a GitHub issue against the AXL repo with the log excerpt and reproducible cadence if that's the right surface. For a fresh cloud-VPS pair across continents, the *peering* shape is right; the *uptime* shape needs work and I'm not going to wave it past in a feedback doc.
- **PM2-wrappable**: AXL runs cleanly under PM2 on both sides, restarts are clean, the logs go to PM2 like any other Node process. Operationally this matters — I didn't have to invent a daemon-supervision story.
- The **HTTP API on `localhost:9002`** is the right shape for agent integration. Beats a binary-exec contract (which was the Day-1 stub I started with). `fetch` from any language, no PATH issues in Docker.
- **TLS over Yggdrasil port 9001** felt over-engineered before I deployed it and then proved its worth — peer authentication is implicit in the keypair, no certificate pipeline to manage.
- **Stable ed25519 keypair per agent** maps cleanly onto QUORUM's signed-envelope model. One identity, one key, used for both AXL transport auth and application-layer message signing — no duplication, no rotation hell at hackathon time.
- The **`/topology` endpoint** as a diagnostic primitive is exactly right — even with the gaps in item 6, having a single endpoint that says "here are my peers and their state" is the foundation any monitoring layer needs.

---

## Closing

AXL is shipping the right primitive for the part of the agent stack I see emerging — multi-region, multi-agent, signed-everything, no central broker. The friction items above are integration-time, not architecture-time — they slow autonomous-agent integrators down but don't stop them. Most resolve with explicit documentation (failover semantics, latency percentiles, agent-runtime API surface, clock semantics) rather than transport changes; items 2, 5, and 6 are the ones I'd prioritise because they're the ones where an autonomous agent's failure mode is silent or ambiguous, and silent failure at machine speed is the hardest class to debug.

The grounded view from running an x402 observatory outside the hackathon: the agent-economy traffic shape is bursty in ways naive sizing doesn't anticipate. 7,248,641 raw Base mainnet x402 payment candidates over a 20.04-day window (2026-04-12 → 2026-05-02 10:02 UTC, lockfile in repo) is not theoretical demand — it's already on-chain. Items 3, 5, and 6 are also where the multi-region-against-bursty-traffic shape will bite hardest.

The combined Gensyn-AXL-mesh + KeeperHub-execution + Uniswap-funded-Treasurer pattern is going to be a category, not a one-off. Both Frankfurt and NYC nodes have been stable through the build window. TLS peer link evidence in repo (`infra/axl-hello.sh`, `logs/d1-axl-mesh-live.log`); the application-layer signed cross-validation evidence is the on-chain attestation TX `0x19bb1d0e...e1763f22` on Base mainnet (calldata holds Frankfurt-Judge + NYC-Verifier ed25519 sigs over canonical evidence hash, decode docs in `logs/d10-quorum-attestation-tx.json`); and `shared/axl-wrap.ts` is MIT — reusable by any team building on AXL. Checked the public surface 2026-05-01: `gensyn-ai` GitHub org doesn't carry an `axl` repo today (closest are `hivemind`, `rl-swarm`, `paper-rl-swarm`), so there's no upstream PR target I can file against right now. What I did instead: tagged `shared/axl-wrap.ts` with an explicit `SPDX-License-Identifier: MIT` and a standalone-friendly preamble (zero dependencies beyond `fetch`, copy-paste-ready into any TypeScript project that talks to a local AXL node). PR-ready verbatim if Gensyn surfaces an upstream — flag the right surface (issue, docs PR target, package namespace, anything) and I'll file the same hour.

Happy to talk through any of these in more depth.

— Tom Smart, [smartflowproai.substack.com](https://smartflowproai.substack.com)
