// SCOUT agent — Day 2: Helius WebSocket client + EVM bridge-linker scaffold
// Watches 14 smart-money Solana wallets via accountSubscribe
// Bridges to Base via EVM-side wallet resolution (Solana buyer → known Base rug-farmer = red flag)
// Sends candidate events to Judge via AXL mesh

import { axlSend } from '../../shared/axl-wrap';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types — exported for Judge agent consumption
// ---------------------------------------------------------------------------

export interface AccountChangeEvent {
  wallet: string;
  slot: number;
  lamports: number;
  owner: string;
  data: unknown;
  timestamp: number;
}

export interface BridgeLink {
  solanaBuyer: string;
  evmCorrelation?: string;
  riskFlag: boolean;
}

export interface ScoutCandidate {
  event: AccountChangeEvent;
  bridge?: BridgeLink;
  emittedAt: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENT_ID = 'scout';
const PEERS = (process.env.AXL_PEERS || 'judge').split(',');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// 14 smart-money wallet pubkeys — loaded from env (comma-separated) or defaults
// TODO populate with real tracked wallets from Helius dashboard
const SMART_MONEY_WALLETS: string[] = (process.env.SMART_MONEY_WALLETS || '')
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);

if (SMART_MONEY_WALLETS.length === 0) {
  // Fallback placeholder so the agent boots in dev without env
  SMART_MONEY_WALLETS.push('11111111111111111111111111111111'); // TODO replace
  console.warn(`[${AGENT_ID}] SMART_MONEY_WALLETS not set — using placeholder`);
}

// ---------------------------------------------------------------------------
// EVM bridge-linker scaffold
// ---------------------------------------------------------------------------

/**
 * Resolve a Solana pubkey to a potential EVM address via cross-chain correlation.
 * Day 3+: implement actual lookup (Wormhole address mapping, CEX deposit clustering,
 * shared-nonce heuristic, known bridge contract logs).
 */
export async function linkToEVM(solanaPubkey: string): Promise<BridgeLink> {
  // TODO Day 3: implement real cross-chain resolution
  // 1. Check known Wormhole / deBridge / Allbridge transfer logs
  // 2. CEX deposit address clustering (Helius enriched tx → known exchange wallets)
  // 3. Shared timing heuristic (Solana buy → Base sell within 5 min window)
  return {
    solanaBuyer: solanaPubkey,
    evmCorrelation: undefined,
    riskFlag: false,
  };
}

// ---------------------------------------------------------------------------
// Helius WebSocket client with reconnect + heartbeat
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let subscriptionIds: Map<number, string> = new Map(); // rpc id → wallet

function connect(): void {
  if (!HELIUS_API_KEY) {
    console.error(`[${AGENT_ID}] HELIUS_API_KEY not set — cannot connect`);
    return;
  }

  console.log(`[${AGENT_ID}] connecting to Helius WS (attempt ${reconnectAttempt})...`);
  ws = new WebSocket(HELIUS_WS_URL);

  ws.on('open', () => {
    console.log(`[${AGENT_ID}] WS connected — subscribing to ${SMART_MONEY_WALLETS.length} wallets`);
    reconnectAttempt = 0;
    subscribeAll();
    startHeartbeat();
  });

  ws.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'accountNotification') {
        handleAccountChange(msg.params);
      } else if (msg.result !== undefined && msg.id) {
        // Subscription confirmation
        const wallet = subscriptionIds.get(msg.id);
        if (wallet) {
          console.log(`[${AGENT_ID}] subscribed to ${wallet.slice(0, 8)}… (sub=${msg.result})`);
          subscriptionIds.delete(msg.id);
        }
      }
    } catch (e) {
      console.error(`[${AGENT_ID}] WS parse error:`, e);
    }
  });

  ws.on('close', (code: number) => {
    console.warn(`[${AGENT_ID}] WS closed (code=${code}) — scheduling reconnect`);
    cleanup();
    scheduleReconnect();
  });

  ws.on('error', (err: Error) => {
    console.error(`[${AGENT_ID}] WS error:`, err.message);
    // 'close' event will fire after this — reconnect handled there
  });
}

function subscribeAll(): void {
  SMART_MONEY_WALLETS.forEach((pubkey, i) => {
    const rpcId = i + 1;
    subscriptionIds.set(rpcId, pubkey);
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'accountSubscribe',
      params: [pubkey, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    });
    ws?.send(payload);
  });
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function cleanup(): void {
  stopHeartbeat();
  ws = null;
}

function scheduleReconnect(): void {
  const baseDelay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
  const jitter = Math.floor(Math.random() * 1000);
  const delay = baseDelay + jitter;
  reconnectAttempt++;
  console.log(`[${AGENT_ID}] reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  setTimeout(connect, delay);
}

// ---------------------------------------------------------------------------
// Event handler — Day 2: log only, Day 3: pipeline to Judge
// ---------------------------------------------------------------------------

async function handleAccountChange(params: any): Promise<void> {
  const { subscription, result } = params;
  const value = result?.value;
  if (!value) return;

  const event: AccountChangeEvent = {
    wallet: 'unknown', // TODO resolve subscription id → pubkey mapping
    slot: result.context?.slot ?? 0,
    lamports: value.lamports ?? 0,
    owner: value.owner ?? '',
    data: value.data,
    timestamp: Date.now(),
  };

  console.log(
    `[${AGENT_ID}] account change: slot=${event.slot} lamports=${event.lamports} owner=${event.owner.slice(0, 8)}…`
  );

  // Day 3: bridge-linker + emit to judge
  // const bridge = await linkToEVM(event.wallet);
  // const candidate: ScoutCandidate = { event, bridge, emittedAt: Date.now() };
  // for (const peer of PEERS) {
  //   await axlSend(peer, candidate).catch((e) => console.error('axlSend failed', e));
  // }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[${AGENT_ID}] starting — peers: ${PEERS.join(',')} wallets: ${SMART_MONEY_WALLETS.length}`);

  // Connect Helius WebSocket
  connect();

  // AXL heartbeat to mesh peers
  setInterval(async () => {
    const heartbeat = { agent: AGENT_ID, ts: Date.now(), status: 'alive' };
    for (const peer of PEERS) {
      await axlSend(peer, heartbeat).catch((e: Error) => console.error('axlSend failed', e));
    }
  }, 30_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
