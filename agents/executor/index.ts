// EXECUTOR agent — receives verdicts from Judge, posts attestations via KeeperHub MCP on Base
// Day-5 work: KeeperHub MCP wire, ERC-8004 attestation submission, retry logic

import { axlSend, axlReceive } from "../../shared/axl-wrap";

const AGENT_ID = "executor";

async function main() {
  console.log(`[${AGENT_ID}] starting — awaiting judge verdicts`);
  // TODO Day-5: KeeperHub MCP integration, attestation POST to Base via ERC-8004
  while (true) {
    const msg = await axlReceive(AGENT_ID).catch(() => null);
    if (!msg) { await new Promise((r) => setTimeout(r, 1000)); continue; }
    console.log(`[${AGENT_ID}] verdict received:`, msg);
    // stub: log + request gas from treasurer
    await axlSend("treasurer", { agent: AGENT_ID, request: "gas", amount_usdc: "0.10" }).catch((e) => console.error(e));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
