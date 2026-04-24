// PRE-KICKOFF DRAFT — generated 2026-04-24 by background runner, pending Tom review before copy to live repo
// SCOUT agent — watches Solana + EVM for new token launches, bridges, rug candidates
// Day-2 work: wire Helius websocket (Solana) + viem block listener (Base/EVM)
// Sends candidate events to Judge via AXL mesh (see ../../shared/axl-wrap.ts)

import { axlSend, axlReceive } from '../../shared/axl-wrap';

const AGENT_ID = 'scout';
const PEERS = (process.env.AXL_PEERS || 'judge').split(',');

async function main() {
  console.log('[' + AGENT_ID + '] starting — peers: ' + PEERS.join(','));
  // TODO Day-2: Helius websocket subscribe, EVM block poll, candidate emit
  setInterval(async () => {
    const heartbeat = { agent: AGENT_ID, ts: Date.now(), status: 'alive' };
    for (const peer of PEERS) {
      await axlSend(peer, heartbeat).catch((e) => console.error('axlSend failed', e));
    }
  }, 30000);
}

main().catch((e) => { console.error(e); process.exit(1); });
