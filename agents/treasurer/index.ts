// PRE-KICKOFF DRAFT — generated 2026-04-24 by background runner, pending Tom review before copy to live repo
// TREASURER agent — autonomous gas + USDC float via x402 micropayments
// Day-6 work: x402 client wire, USDC balance monitor, per-request gas accounting

import { axlSend, axlReceive } from "../../shared/axl-wrap";

const AGENT_ID = "treasurer";
const PAY_TO = process.env.QUORUM_PAYTO || "0x0000000000000000000000000000000000000000";

async function main() {
  console.log(`[${AGENT_ID}] starting — payTo: ${PAY_TO}`);
  // TODO Day-6: x402 client setup, balance monitor, approve-on-request logic
  while (true) {
    const msg = await axlReceive(AGENT_ID).catch(() => null);
    if (!msg) { await new Promise((r) => setTimeout(r, 1000)); continue; }
    console.log(`[${AGENT_ID}] gas request:`, msg);
    // stub: auto-approve dev amounts
    await axlSend("executor", { agent: AGENT_ID, approved: true, tx_hash: "0xSTUB" }).catch((e) => console.error(e));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
