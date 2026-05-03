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

async function main() {
  console.log(`[${AGENT_ID}] starting — awaiting judge verdicts (AXL drain loop)`);
  while (true) {
    // Drain all envelopes per poll — axlRecv() clears the queue, so single-shot
    // takes only one envelope and loses any others arriving in the same window.
    const envelopes = await axlRecv().catch((e: Error) => {
      console.warn(`[${AGENT_ID}] axlRecv error (will retry):`, e.message);
      return [];
    });
    for (const envelope of envelopes) {
      console.log(`[${AGENT_ID}] verdict received from ${envelope.from}`);
      // Stub forwarding: request 0.10 USDC gas from Treasurer per verdict.
      // Real KH wire (paid settlement on-chain) lives in keeperhub-wire/.
      await axlSend("treasurer", { agent: AGENT_ID, request: "gas", amount_usdc: "0.10" })
        .catch((e: Error) => console.error(`[${AGENT_ID}] axlSend error:`, e.message));
    }
    if (envelopes.length === 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
