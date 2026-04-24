# QUORUM SCOPE.md — Binding Document for Hackathon 24.04-26.04

## Version 1.0 — 2026-04-19
## Status: BINDING (decided Decision 4 — master synthesis)

---

This document replaces the 10-day v2 blueprint (`winning-project-v2-audited.md`) for the 3-day hackathon window 24.04-26.04. It is the single source of truth on scope. Anyone opening this file during build weekend — answer to "can we add X?" is NO unless X is already listed below. Solo builder, 72 hours of wall clock, one submission: polish on two components beats half-done five.

The hostile review (`night-queue-2026-04-18/track-04-quorum-stress-test/outputs/result.md`) rated v2 at **6.5/10 as written**. The two most severe critiques — scope insanity for solo builder, and KeeperHub integration architected on unverified sponsor docs — are the reason for the 5→2 cut. This SCOPE document bakes in the mitigations.

---

## Components (EXACTLY 2)

### Component 1 — Frankfurt-NYC x402 Mesh (Gensyn track)

**What it is.** Two physically separate AXL nodes (Frankfurt VPS stable IP `143.244.204.114`, NYC VPS `159.65.172.200`) running a live encrypted Yggdrasil mesh. Each node hosts one agent process. Agents exchange signed x402-payment events across the mesh and reach a two-of-two agreement before posting an attestation to Base. This is the smallest architecture that honestly uses the word *quorum* (two independent nodes agreeing), and it is Gensyn's canonical "separate AXL nodes, not just in-process" criterion met in the literal sense.

**Gensyn requirement match** (cited verbatim from partner criteria memory):

- *"Must use AXL for inter-agent or inter-node communication (no centralised message broker replacing what AXL provides)"* → our delivery: Agent-A on Frankfurt and Agent-B on NYC talk **exclusively** over AXL `/send` and `/recv`. No Redis, no HTTP fallback between them, no centralised queue.
- *"Must demonstrate communication across separate AXL nodes, not just in-process"* → our delivery: two physical hosts, two continents, independent ed25519 identities, encrypted Yggdrasil tunnel. The README includes a `traceroute` screenshot proving the packets physically leave Frankfurt and arrive in NYC.
- *"Project must be built during the hackathon"* → our delivery: all agent code written 24.04-26.04. AXL binary (built 18.04) is used as an upstream dependency, the same way every other team uses `go install gensyn-ai/axl@latest`. Binary compilation ≠ project build; Gensyn docs themselves distinguish these.

**Deliverables** (committed):

1. Public repo `github.com/smartflowproai-lang/quorum` with a monorepo `/agent-a`, `/agent-b`, `/shared`, `/infra`.
2. Working Frankfurt↔NYC mesh: two binaries that, when started, discover each other via bootstrap peers and exchange a signed hello within 10 seconds.
3. A **partition recovery test** (`infra/chaos.sh`) that `pkill`s Agent-B, waits 15s, restarts it, and prints the rejoin timestamp. Reviewer can run this locally against our hosts on a dev key.
4. README with architecture diagram (mermaid) + two-host deploy runbook + `traceroute` proof + partition test walkthrough.
5. `axl-wrap.ts` — a ~120 LOC TypeScript wrapper around the AXL HTTP interface at `localhost:9002`. MIT-licensed, reusable by other teams.

**Non-deliverables** (out of scope — do not add):

- NO third node. Two-of-two consensus is enough; a third node is a Day-4 job, not a Day-2 job.
- NO Solana data, NO copy-bot archive, NO EVM wallet graph. The 58K/231K datasets from v2 blueprint are **not used** in this hackathon submission. Data provenance concerns (weak point #4 in hostile review) are avoided by not claiming them at all.
- NO classifier, NO logistic regression, NO backtest. The scoring layer from v2 Days 3-4 is cut.
- NO 0G storage. Cut.
- NO ERC-8004 registration. Cut.
- NO World Chain dual-write. Cut.

**Technical stack:**

- AXL Go binary (built and tested on Frankfurt per `project_axl_frankfurt_node_ready.md`)
- Frankfurt VPS: `143.244.204.114` (reserved IP, per `reference_vps_reserved_ip.md`), public listener
- NYC VPS: `159.65.172.200` (per `project_nyc_vps_dual_purpose.md`), peering node
- Base USDC x402 test transactions through the public Coinbase facilitator
- Node runtime: TypeScript via `tsx`, one binary per agent
- Bootstrap peers: hard-coded in `node-config.json`, committed to repo

**Acceptance criteria** (demo-able live by Day 3 17:00):

- [ ] `curl http://143.244.204.114:9002/topology` returns 2 peers
- [ ] Agent-A sends an x402 signal, Agent-B countersigns and returns the receipt within 3 seconds median
- [ ] `pkill agent-b` followed by `systemctl start agent-b` results in re-sync in < 30 seconds
- [ ] Single attestation transaction landed on Base visible via basescan, with both agents' signatures verifiable on-chain

### Component 2 — Quality Attestation Layer (KeeperHub track)

**What it is.** A minimal Solidity contract on Base that stores agent-signed attestations (`(agent_pubkey, payload_hash, timestamp, signature)`) and an Executor client that posts to it through KeeperHub's scheduled-tx primitive. The Executor runs on the NYC agent (Agent-B from Component 1) and pays KeeperHub's gas via x402 per call. This is the canonical "agents paying KeeperHub in x402" pattern that Area 2 of KeeperHub's criteria explicitly describes. The contract is deliberately trivial — the judging value is in the **reliable execution path**, not in what the payload means.

**KeeperHub requirement match** (cited from `project_openagents_partner_criteria_detailed.md`):

- *"Area 2 — Best Integration — Payments: integrate KeeperHub with x402 or MPP. Agents paying for services, settling tx, routing payment flows → KeeperHub execution"* → our delivery: every Component-1 consensus result triggers one KeeperHub-scheduled transaction, funded by an x402 payment token that Agent-B generates autonomously from a $20 USDC Base float. No human-in-the-loop.
- *"Does it work?"* → our delivery: live demo with ≥5 txs landed via KeeperHub, each paired with its x402 payment receipt.
- *"Mergeable quality"* → our delivery: KH client is ~150 LOC of TypeScript, typed, with unit tests on the signature-building path.

**Deliverables:**

1. `contracts/QuorumAttestation.sol` (~40 LOC Solidity) deployed to Base; contract address in README.
2. `executor/kh-client.ts` — KeeperHub client posting via the scheduled-tx endpoint.
3. `executor/x402-payer.ts` — x402 payment token generator, calls the public Coinbase facilitator.
4. `FEEDBACK-KH.md` — dev log of every friction point encountered (docs gaps, SDK quirks, rate limits). Targets the $250 feedback bounty guaranteed floor.
5. README section "Why KeeperHub here and not naive sendTransaction" explaining the scheduled-retry semantics.

**Non-deliverables:**

- NO MCP server exposing `quorum/submit-verdict` — cut. Write-only integration.
- NO Jito-bundle-specific reasoning. Jito is Solana infra; our contract is on Base. The v2 blueprint conflated these (hostile review Weak Point #3).
- NO framework plugin (ElizaOS/OpenClaw/CrewAI). Cut.
- NO dual-chain dual-write. Base only.
- NO World ID integration. Cut.

**Technical stack:**

- Foundry for contract deploy, `forge create --rpc-url base-mainnet`
- Base USDC (~$20 float on Treasurer wallet) for x402 payments
- Coinbase x402 public facilitator
- KeeperHub API — **canonical URL to be verified Day 1 morning** from OpenAgents portal or sponsor Discord (hostile review mitigation #3)
- ed25519 key per agent, signatures stored in contract for independent verification

**Acceptance criteria** (demo-able live by Day 3 17:00):

- [ ] `QuorumAttestation.sol` deployed to Base, contract verified on basescan
- [ ] ≥5 real transactions landed via KeeperHub scheduled path, all signatures valid
- [ ] ≥5 x402 payment receipts archived in repo (`executor/receipts/`)
- [ ] `FEEDBACK-KH.md` contains ≥5 specific, actionable friction points
- [ ] Reviewer can run `npm run post-verdict -- --payload "test"` locally and see the full round-trip (signature → x402 payment → KH schedule → Base confirmation)

---

## Timeline 24.04-26.04 (3 days, hour-by-hour CEST)

### Day 1 — Friday 24.04

- **18:00** — Kickoff. Tomasz confirms hackathon has started (portal opens). Submit team registration.
- **18:15** — Sanity check both VPSs (`ssh 143.244.204.114` + `ssh 159.65.172.200`), AXL binary running on both, `curl /topology` green.
- **18:30** — `gh repo create smartflowproai-lang/quorum --public`, push scaffold (README stub, monorepo directories, `node-config.json` templates, LICENSE=MIT).
- **19:00-22:00** — Component 1 hello-world. `axl-wrap.ts` + stub agents. Goal: Frankfurt↔NYC signed-message roundtrip with timestamp echo. First commit: `d1-init: axl hello-world frankfurt<->nyc roundtrip`.
- **22:00** — KeeperHub URL hunt: check OpenAgents portal Prizes tab + sponsor Discord pinned messages. Capture canonical URL, API key endpoint, docs landing page to `keeperhub-notes.md`. **Hard blocker gate**: if KH canonical URL cannot be established by 24:00, trigger Component-2 fallback (see "Contingency" below).

### Day 2 — Saturday 25.04

- **09:00-12:00** — Component 1 consensus logic. Agent-A generates a payload, sends to Agent-B, Agent-B countersigns, Agent-A verifies. Both signatures stored locally. Commits: `d2-mesh: two-of-two consensus`, `d2-mesh: partition recovery test`.
- **12:00-13:00** — Lunch/context switch. No code.
- **13:00-14:00** — Partition recovery test (`infra/chaos.sh`). `pkill` + restart + rejoin. Verify state re-sync. Commit: `d2-chaos: partition recovery green`.
- **14:00-18:00** — Component 2 integration. Deploy `QuorumAttestation.sol` to Base. Wire `kh-client.ts` against verified KH docs. First KH-scheduled tx landed. Commits: `d2-exec: attestation contract deployed`, `d2-exec: first kh-scheduled tx on base`.
- **18:00-22:00** — Component 2 x402 payment path. `x402-payer.ts` generates payment token, attaches to KH call, receipt flows back. Goal: 3 end-to-end txs with x402 payment proofs. Commits: `d2-treasurer: x402 autopay live`.

### Day 3 — Sunday 26.04

- **09:00-12:00** — Integration test both components end-to-end. Agent-A proposes → Agent-B countersigns → Executor posts via KH + x402. Goal: 5 consecutive successful round-trips. Commits: `d3-e2e: five-tx clean run`.
- **12:00-15:00** — Demo video recording. **Captions-only format** per hostile review Weak Point #6 (no live voiceover, ETHGlobal bans AI voiceover, English-technical-speech is a weakness). Full-screen terminal + architecture diagram + basescan + typewriter captions + music bed. Target 2:00-3:00 total length. Single-take per segment, ScreenStudio export, YouTube unlisted.
- **15:00-16:00** — `FEEDBACK-KH.md` finalised — ≥5 friction items, each with repro steps.
- **16:00-17:00** — README polish. Architecture diagram SVG. Basescan TX links. `traceroute` screenshot. Partner write-ups (Gensyn ~200 words + KeeperHub ~200 words).
- **17:00** — Submit to ETHGlobal portal. Submission screenshots filed to `infra/submission-receipts/`.
- **17:30** — Short Tom Smart X post: project live, link to repo. No hype, no thread, no "thank you sponsors" puffery.

---

## Binding decisions (zero scope creep)

1. **NO additional components beyond 2.** If on Day 2 at 18:00 both components are working and "there's time", the hours go to polish, demo rehearsal, FEEDBACK-KH.md, and README — not to addons. The hostile review's #1 severity risk is scope creep; this rule is the vaccine.
2. **NO live English voiceover.** Captions-only format, per Weak Point #6. Decision final.
3. **NO claims of "3 months time-series", "231K wallets", or "58K events".** None of that data is in the submission. Honest framing: "built during 72-hour hackathon window, two agents, two continents, two signatures per attestation."
4. **NO KeeperHub work started** until canonical URL + docs are verified Day 1 evening. Per hostile review Weak Point #3. If docs aren't verifiable by midnight Friday, execute contingency below.
5. **Data provenance attestation.** Pre-kickoff (21.04 evening), Tomasz posts a SHA-256 of the repo's initial commit hash via @TomSmart_ai tweet plus a gist copy, so Start Fresh compliance is independently timestamped. This is a one-tweet action, but it closes Weak Point #4 cleanly.
6. **"We" vs "I" discipline.** Submission is authored as "I" — solo builder, one name. No "we built", no Ken mention, no PQS mention. OPSEC per `feedback_pqs_stealth_no_public_thesis.md`.

## Contingency — if Component 2 blocks (KeeperHub docs unavailable, URL dead, auth gate)

If KeeperHub cannot be integrated by end-of-day Friday 24.04 due to docs/auth/onboarding blockers:

- **Do not force-fit.** The hostile review's Weak Point #3 warns that architecting KH on wrong assumptions ends the submission.
- **Fallback**: double down on Component 1. Add a "Component 1b" sub-deliverable that stays under Gensyn: **x402 payment attestation directly on Base** (skip KeeperHub layer, post via raw `cast send`). The partnership angle becomes "AXL-native agent payments, no facilitator dependencies" — still a Gensyn story, still x402, zero KH dependency. $250 KH feedback bounty is forfeited but main Gensyn prize odds are preserved.
- **Decision owner**: Tomasz, by 24.04 23:59. No later.

## Success criteria (Day 3 17:00 checklist)

- [ ] Repo public at `github.com/smartflowproai-lang/quorum`, ≥12 commits across 3 days
- [ ] README explains 2 components clearly, architecture diagram rendered, partner write-ups included
- [ ] Demo video 2-3 min captions-only, unlisted YouTube, linked from README
- [ ] Live demo-able: a judge can run `axl-cli connect 143.244.204.114:9002` from their laptop and see the topology
- [ ] Gensyn criteria: **minimum 2 of 3 Qualification Requirements met** (AXL inter-node + separate physical nodes + built during hackathon — all three should be trivially met)
- [ ] KeeperHub criteria: **minimum 1 of 2 met** (Area 2 Payments integration with live txs, OR fallback `FEEDBACK-KH.md` submitted against documented friction during attempted integration)
- [ ] ETHGlobal submission confirmed, screenshot archived

## Partner prize ranking (realistic)

| Prize | Probability | Requires |
|---|---|---|
| Gensyn 3rd ($1,000) | 55% | Component 1 demo working, partition test green |
| KH Feedback bounty ($250) | 70% | `FEEDBACK-KH.md` with ≥5 items — lands even under contingency fallback |
| Gensyn 2nd ($1,500) | 25% | Component 1 working + README/docs stronger than median OpenAgents submission |
| KH Main Prize ranked ($500-$1,500) | 15% | Component 2 fully working + judges see the x402-agent-pays pattern explicitly |
| Gensyn 1st ($2,500) | 8% | Both components shipping + Frankfurt↔NYC partition recovery demo lands memorably |

**Expected value midpoint: ~$1,750.** Floor $250 (feedback only), ceiling ~$4,250. These are the same numbers as memory `project_openagents_partner_criteria_detailed.md` — nothing inflated for SCOPE's sake.

## Owner

Tomasz (Tom Smart) — sole team member, decides at each go/no-go point, writes the submission under pseudonym.
Claude — implements, drafts, reviews, deploys, handles VPS, writes commits, writes README prose, runs chaos tests autonomously.

---

Anyone reading this document between 24.04 and 26.04 — if you want to add component #3, the answer is **NO**. Reason: solo builder, 72 hours, one submission, one demo video. Two components polished beats five half-done. The hostile review was explicit on this, and the review was right.

**Signed**: Tom Smart (Tomasz), 2026-04-19
