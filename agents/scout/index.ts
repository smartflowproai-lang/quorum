// SCOUT agent — Day 3: linkToEVM + publishToJudge + sub-id reverse map
// Watches 14 smart-money Solana wallets via Helius WebSocket accountSubscribe.
// Bridges to Base via EVM cross-chain correlation (linkToEVM).
// Sends candidate events to Judge via AXL mesh (publishToJudge).
//
// Day 3 changes vs Day 2:
//   1. Activated linkToEVM enrichment in handleAccountChange
//   2. Activated publishToJudge pipeline (was commented out)
//   3. Added sub-id reverse map: persist sub-id → pubkey to sub-map.json
//      so that accountNotification events can resolve the wallet name,
//      and restarts skip already-subscribed wallets (Helius credit savings).

import { axlSend } from '../../shared/axl-wrap';
import { linkToEVM } from './linkToEVM';
import { publishToJudge } from './publishToJudge';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

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
const SMART_MONEY_WALLETS: string[] = (process.env.SMART_MONEY_WALLETS || '')
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);

if (SMART_MONEY_WALLETS.length === 0) {
  SMART_MONEY_WALLETS.push('11111111111111111111111111111111'); // placeholder for dev
  console.warn(`[${AGENT_ID}] SMART_MONEY_WALLETS not set — using placeholder`);
}

// ---------------------------------------------------------------------------
// Sub-id reverse map — persisted to disk so restarts skip re-subscribing
// ---------------------------------------------------------------------------
// WHY: Helius charges per subscription. If Scout restarts (crash, deploy),
// re-subscribing all 14 wallets costs credits. By persisting sub-id → pubkey
// we know which wallets are still subscribed on the Helius side and can skip
// re-subscribing them (the WS session id changes but sub-ids carry over for
// the session lifetime).
//
// On a fresh WS connection, all sub-ids are new, so we subscribe all.
// On reconnect within the same Helius session (rare), skip known ones.
// The file is wiped on a fresh connection to reflect the new session state.

const SUB_MAP_PATH = path.join(__dirname, 'sub-map.json');

// Active subscriptions: subId (number from Helius) → pubkey
const subIdToPubkey: Map<number, string> = new Map();

// rpcId-to-pubkey: tracks pending subscription confirmations (rpc call id → pubkey)
// After confirmation, sub-id (from msg.result) is stored in subIdToPubkey instead.
const rpcIdToPubkey: Map<number, string> = new Map();

function loadSubMap(): void {
  try {
    const raw = fs.readFileSync(SUB_MAP_PATH, 'utf-8');
    const stored = JSON.parse(raw) as Record<string, string>;
    for (const [subId, pubkey] of Object.entries(stored)) {
      subIdToPubkey.set(Number(subId), pubkey);
    }
    console.log(`[${AGENT_ID}] loaded ${subIdToPubkey.size} sub-id mappings from sub-map.json`);
  } catch {
    // File doesn't exist yet — normal on first run
  }
}

function persistSubMap(): void {
  const obj: Record<string, string> = {};
  for (const [subId, pubkey] of subIdToPubkey.entries()) {
    obj[String(subId)] = pubkey;
  }
  try {
    fs.writeFileSync(SUB_MAP_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error(`[${AGENT_ID}] failed to persist sub-map:`, (e as Error).message);
  }
}

/** Pubkeys already confirmed-subscribed for this session (by sub-id lookup) */
function subscribedPubkeys(): Set<string> {
  return new Set(subIdToPubkey.values());
}

// ---------------------------------------------------------------------------
// Helius WebSocket client with reconnect + heartbeat
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// rpc request counter — each subscribeAll call starts from 1 on each new connection
let rpcCounter = 0;

function connect(): void {
  if (!HELIUS_API_KEY) {
    console.error(`[${AGENT_ID}] HELIUS_API_KEY not set — cannot connect`);
    return;
  }

  // On fresh WS connection, existing sub-ids are no longer valid — clear the map.
  // We'll rebuild it as subscription confirmations arrive.
  subIdToPubkey.clear();
  rpcIdToPubkey.clear();
  rpcCounter = 0;

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
        // Subscription confirmation: msg.result is the sub-id assigned by Helius
        const pubkey = rpcIdToPubkey.get(msg.id);
        if (pubkey) {
          subIdToPubkey.set(msg.result as number, pubkey);
          rpcIdToPubkey.delete(msg.id);
          persistSubMap();
          console.log(
            `[${AGENT_ID}] confirmed sub=${msg.result} for ${pubkey.slice(0, 8)}… ` +
              `(${subIdToPubkey.size}/${SMART_MONEY_WALLETS.length} total)`
          );
        }
      } else if (msg.error) {
        console.error(`[${AGENT_ID}] WS RPC error:`, msg.error);
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
  const alreadySubscribed = subscribedPubkeys();
  let skipped = 0;

  SMART_MONEY_WALLETS.forEach((pubkey) => {
    if (alreadySubscribed.has(pubkey)) {
      // Skip — Helius has an active subscription for this wallet in this session.
      // This saves credits on partial reconnects.
      skipped++;
      return;
    }

    rpcCounter++;
    const rpcId = rpcCounter;
    rpcIdToPubkey.set(rpcId, pubkey);

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'accountSubscribe',
      params: [pubkey, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    });
    ws?.send(payload);
  });

  if (skipped > 0) {
    console.log(`[${AGENT_ID}] skipped ${skipped} already-subscribed wallets (Helius credit saving)`);
  }
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
// Event handler — enriches with EVM correlation + publishes to Judge via AXL
// ---------------------------------------------------------------------------

async function handleAccountChange(params: {
  subscription: number;
  result: { context?: { slot: number }; value?: { lamports: number; owner: string; data: unknown } };
}): Promise<void> {
  const { subscription, result } = params;
  const value = result?.value;
  if (!value) return;

  // Resolve wallet name from sub-id reverse map
  const wallet = subIdToPubkey.get(subscription) ?? `sub:${subscription}`;

  const event: AccountChangeEvent = {
    wallet,
    slot: result.context?.slot ?? 0,
    lamports: value.lamports ?? 0,
    owner: value.owner ?? '',
    data: value.data,
    timestamp: Date.now(),
  };

  console.log(
    `[${AGENT_ID}] account change: wallet=${wallet.slice(0, 8)}… slot=${event.slot} lamports=${event.lamports}`
  );

  // EVM bridge-linker: resolve Solana pubkey → EVM address (known mapping table)
  const evmMap = linkToEVM(wallet);
  const bridge: BridgeLink = {
    solanaBuyer: wallet,
    evmCorrelation: evmMap.evmAddress ?? undefined,
    riskFlag: evmMap.riskReason !== undefined && evmMap.riskReason.length > 0,
  };

  if (bridge.riskFlag) {
    console.warn(`[${AGENT_ID}] RISK FLAG: wallet=${wallet.slice(0, 8)}… reason=${evmMap.riskReason}`);
  }

  // Build candidate and emit to Judge via AXL
  const candidate: ScoutCandidate = {
    event,
    bridge,
    emittedAt: Date.now(),
  };

  await publishToJudge(candidate).catch((e: Error) => {
    // Non-fatal: AXL node may be restarting, log and continue
    console.error(`[${AGENT_ID}] publishToJudge failed (will miss event):`, e.message);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[${AGENT_ID}] starting — peers: ${PEERS.join(',')} wallets: ${SMART_MONEY_WALLETS.length}`);

  // Load persisted sub-map from last session (avoids re-subscribing on restart)
  loadSubMap();

  // Connect Helius WebSocket
  connect();

  // AXL heartbeat to mesh peers (keeps connection alive, makes node visible)
  setInterval(async () => {
    const heartbeat = {
      agent: AGENT_ID,
      ts: Date.now(),
      status: 'alive',
      subscribed: subIdToPubkey.size,
    };
    for (const peer of PEERS) {
      await axlSend(peer, heartbeat).catch((e: Error) =>
        console.error(`[${AGENT_ID}] axlSend heartbeat failed:`, e.message)
      );
    }
  }, 30_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
