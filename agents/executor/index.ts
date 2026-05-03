// EXECUTOR agent — thin AXL receive stub that forwards verdict events
// to the gas-request flow against Treasurer.
//
// The production KH MCP integration lives in agents/executor/keeperhub-wire/
// (1 live session converged ok=11/12 + paid x402 settlement landed on-chain
// — see SUBMISSION:82). The wire-and-attestation autonomous cadence is
// post-hackathon work: today's KH paid settlement is a supervised one-shot
// receipt, not an agent-driven loop.

import { axlSend, axlRecv } from "../../shared/axl-wrap";

const AGENT_ID = "executor";

// Application-layer routing for the shared-AXL-node race (see SUBMISSION:80
// deferred-cadence framing). Executor's domain is verdict consumption; other
// types get forwarded to the correct sibling best-effort.
const OWN_KINDS = new Set(["attestation", "verdict_request", "verdict"]);
const ROUTE_BY_TYPE: Record<string, string> = {
  balance_request: "treasurer",
  rebalance_request: "treasurer",
  x402_challenge: "treasurer",
  reprobe_request: "judge",
  reprobe_response: "verifier",
};

const MAX_PAYLOAD_BYTES = 64 * 1024;

async function handleEnvelope(envelope: { from: string; data: string; ts?: number }): Promise<void> {
  if (typeof envelope.data !== "string") {
    console.warn(`[${AGENT_ID}] dropping non-string envelope.data from ${envelope.from}`);
    return;
  }
  if (Buffer.byteLength(envelope.data, "utf8") > MAX_PAYLOAD_BYTES) {
    console.warn(`[${AGENT_ID}] dropping oversized envelope from ${envelope.from}`);
    return;
  }
  let parsed: { kind?: string; type?: string; [k: string]: unknown };
  try {
    parsed = JSON.parse(envelope.data) as typeof parsed;
  } catch {
    console.warn(`[${AGENT_ID}] dropping non-JSON envelope from ${envelope.from}`);
    return;
  }
  const k = parsed.kind ?? parsed.type;
  if (typeof k !== "string") {
    console.warn(`[${AGENT_ID}] dropping envelope without kind/type from ${envelope.from}`);
    return;
  }
  // Forward types that aren't ours to the correct sibling.
  if (!OWN_KINDS.has(k)) {
    const target = ROUTE_BY_TYPE[k];
    if (target && target !== AGENT_ID) {
      await axlSend(target, parsed).catch((e: Error) =>
        console.warn(`[${AGENT_ID}] forward ${k}→${target} failed:`, e.message)
      );
    }
    return;
  }
  console.log(`[${AGENT_ID}] ${k} received from ${envelope.from}`);
  // Stub forwarding: request 0.10 USDC gas from Treasurer per verdict event.
  // Real KH wire (paid settlement on-chain) lives in keeperhub-wire/.
  await axlSend("treasurer", { agent: AGENT_ID, request: "gas", amount_usdc: "0.10" })
    .catch((e: Error) => console.error(`[${AGENT_ID}] axlSend error:`, e.message));
}

async function main() {
  console.log(`[${AGENT_ID}] starting — awaiting judge verdicts (AXL drain loop)`);
  while (true) {
    const envelopes = await axlRecv().catch((e: Error) => {
      console.warn(`[${AGENT_ID}] axlRecv error (will retry):`, e.message);
      return [];
    });
    for (const envelope of envelopes) {
      await handleEnvelope(envelope).catch((e: Error) =>
        console.error(`[${AGENT_ID}] handleEnvelope error:`, e.message)
      );
    }
    if (envelopes.length === 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
