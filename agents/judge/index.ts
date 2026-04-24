// PRE-KICKOFF DRAFT — generated 2026-04-24 by background runner, pending Tom review before copy to live repo
// JUDGE agent — receives candidates from Scout, runs 10-feature extractor + backtested model
// Day-3 work: feature extraction (funder concentration, activity burstiness, LP age, etc)
// Emits verdict (SAFE | WATCH | RUG) to Executor via AXL mesh

import { axlSend, axlReceive } from "../../shared/axl-wrap";

const AGENT_ID = "judge";

async function main() {
  console.log(`[${AGENT_ID}] starting — awaiting scout candidates`);
  // TODO Day-3: 10-feature extractor, backtest model load, verdict emission
  while (true) {
    const msg = await axlReceive(AGENT_ID).catch(() => null);
    if (!msg) { await new Promise((r) => setTimeout(r, 1000)); continue; }
    console.log(`[${AGENT_ID}] received:`, msg);
    // stub: echo verdict
    await axlSend("executor", { agent: AGENT_ID, verdict: "WATCH", source: msg }).catch((e) => console.error(e));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
