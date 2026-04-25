// TREASURER agent — Day 4 scaffold
//
// Role: autonomous treasury manager for the QUORUM multi-agent mesh.
// Tracks token balances across N agents, rebalances via Uniswap when needed,
// and pays HTTP 402 (x402/MPP) challenges using whatever token the agent holds.
//
// WHY THIS IS THE UNISWAP PRIZE WINNER:
// =======================================
// Uniswap Foundation prize criteria: "reliability, transparency, composability
// over speculative intelligence." The pay-with-any-token skill they ship in
// their uniswap-ai toolkit is described as:
//   "Pay HTTP 402 challenges (MPP/x402) using tokens via Uniswap swaps."
//
// QUORUM agents earn/hold a mix of USDC, WETH, VIRTUAL on Base. When an x402
// endpoint charges in USDC but Treasurer only holds WETH, it must:
//   1. Quote WETH->USDC on Uniswap Trading API
//   2. Execute the swap
//   3. Settle the x402 challenge with the received USDC
//   4. Retry the original request
// This is the exact flow Uniswap wants demonstrated -- no other hackathon team
// likely has real x402 traffic data (2.36M tx since 2026-04-12) backing it.
//
// Integration with other QUORUM agents (via AXL):
//   Scout   -> sends probe events to Judge   (Frankfurt AXL node)
//   Judge   -> emits verdicts, writes to DB  (NYC AXL node)
//   Treasurer -> receives balance-check / gas-request msgs from any agent
//   Verifier  -> (Day 5) validates Judge verdicts; may request re-probe funding
//
// TODO Day 4 (extend this file):
//   1. Wire getBalances() to real EVM provider (viem publicClient on Base)
//   2. Wire rebalance() to UniswapClient.getQuote + executeSwap
//   3. Wire payX402Challenge() to X402Handler.handleX402
//   4. Add AXL poll loop (see scout/index.ts for pattern)
//   5. Integrate KeeperHub job scheduling (agents/treasurer/keeper-scheduler.ts)

import { axlSend, axlRecv } from '../../shared/axl-wrap';
import type { AxlEnvelope } from '../../shared/axl-wrap';
import { UniswapClient } from './uniswap-client';
import { X402Handler } from './x402-handler';

// ---------------------------------------------------------------------------
// Shared constants (Base mainnet)
// ---------------------------------------------------------------------------

export const BASE_CHAIN_ID = 8453 as const;

// Known ERC-20 token addresses on Base mainnet
// Source: https://developers.uniswap.org/ + Basescan verified
export const TOKENS = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
  WETH: '0x4200000000000000000000000000000000000006' as const,
  VIRTUAL: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b' as const,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** EVM checksum address */
export type Address = `0x${string}`;

/** Single token holding for one on-chain address */
export interface TokenBalance {
  /** ERC-20 contract address */
  tokenAddress: Address;
  symbol: string;
  decimals: number;
  /** Raw balance in smallest unit (BigInt stored as string for JSON safety) */
  rawAmount: string;
  formattedAmount: string;
  usdValue?: number;
}

/** Plan for rebalancing funds between two QUORUM agent wallets */
export interface RebalancePlan {
  fromAddress: Address;
  toAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** Amount in tokenIn smallest units (as string) */
  amountIn: string;
  reason: string;
}

/**
 * HTTP 402 challenge received from an x402-paywalled endpoint.
 * Ref: https://docs.x402.org/guides/mcp-server-with-x402
 */
export interface X402Challenge {
  url: string;
  amount: string;
  tokenAddress: Address;
  chainId: number;
  payTo: Address;
  rawHeader?: string;
}

export interface TxReceipt {
  txHash: `0x${string}`;
  status: 'success' | 'reverted' | 'pending';
  blockNumber?: bigint;
  gasUsed?: bigint;
  timestamp: string;
}

export interface PaymentReceipt {
  swapTxHash?: `0x${string}`;
  settleTxHash: `0x${string}`;
  paidTokenAddress: Address;
  paidAmount: string;
  requestedTokenAddress: Address;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Treasurer class
// ---------------------------------------------------------------------------

const AGENT_ID = 'treasurer';

export class Treasurer {
  private uniswap: UniswapClient;
  private x402: X402Handler;

  constructor(private readonly signerPrivateKey: `0x${string}`) {
    this.uniswap = new UniswapClient();
    this.x402 = new X402Handler(this.uniswap, signerPrivateKey);
  }

  /**
   * Returns current token balances for all tracked agent wallets.
   *
   * TODO Day 4:
   *   1. Build viem publicClient on Base mainnet.
   *   2. For each WATCHED_ADDRESSES, call readContract balanceOf for each TOKENS entry.
   *   3. Format with viem formatUnits().
   */
  async getBalances(): Promise<Map<Address, TokenBalance[]>> {
    const result = new Map<Address, TokenBalance[]>();
    const watched = this.getWatchedAddresses();
    for (const addr of watched) {
      result.set(addr, []);
    }
    return result;
  }

  /**
   * Executes a rebalancing swap between two agent wallets.
   *
   * TODO Day 4:
   *   1. Validate plan (amountIn > 0, fromAddress has balance).
   *   2. Call this.uniswap.getQuote(tokenIn, tokenOut, amountIn, BASE_CHAIN_ID).
   *   3. Sign Permit2 from quote.permitData.
   *   4. Call this.uniswap.executeSwap(signedQuote, this.signerPrivateKey).
   */
  async rebalance(plan: RebalancePlan): Promise<TxReceipt[]> {
    console.log(`[${AGENT_ID}] rebalance: ${plan.fromAddress.slice(0, 8)} reason="${plan.reason}"`);
    const receipts: TxReceipt[] = [];
    // TODO: wire to UniswapClient
    return receipts;
  }

  /**
   * Pays an HTTP 402 challenge, swapping tokens via Uniswap if needed.
   *
   * UNISWAP PRIZE CORE FLOW (research §3.6):
   *   Agent holds WETH, endpoint charges USDC ->
   *   auto-quote WETH->USDC, swap, settle 402, return receipt.
   *
   * TODO Day 4: delegate to X402Handler.handleX402()
   */
  async payX402Challenge(
    challenge: X402Challenge,
    preferredToken?: Address
  ): Promise<PaymentReceipt> {
    console.log(`[${AGENT_ID}] payX402Challenge: url=${challenge.url}`);
    return this.x402.handleX402(challenge, preferredToken);
  }

  /**
   * Main AXL poll loop.
   *
   * TODO Day 4: add handlers for rebalance_request, balance_request, x402_challenge.
   * See scout/index.ts for poll loop pattern.
   */
  async startPollLoop(): Promise<void> {
    console.log(`[${AGENT_ID}] AXL poll loop started`);
    while (true) {
      const envelopes: AxlEnvelope[] = await axlRecv().catch((e: Error) => {
        console.error(`[${AGENT_ID}] axlRecv error:`, e.message);
        return [];
      });
      for (const envelope of envelopes) {
        await this.handleAxlMessage(envelope).catch((e: Error) =>
          console.error(`[${AGENT_ID}] handleAxlMessage error:`, e.message)
        );
      }
      await sleep(500);
    }
  }

  private async handleAxlMessage(envelope: AxlEnvelope): Promise<void> {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(envelope.data) as { type: string; [key: string]: unknown };
    } catch {
      console.warn(`[${AGENT_ID}] ignoring non-JSON from ${envelope.from}`);
      return;
    }

    switch (msg.type) {
      case 'balance_request': {
        const balances = await this.getBalances();
        await axlSend(envelope.from, { type: 'balance_reply', balances: Object.fromEntries(balances) });
        break;
      }
      case 'rebalance_request': {
        const plan = msg.plan as RebalancePlan;
        const receipts = await this.rebalance(plan);
        await axlSend(envelope.from, { type: 'rebalance_receipt', receipts });
        break;
      }
      case 'x402_challenge': {
        const challenge = msg.challenge as X402Challenge;
        const preferredToken = msg.preferredToken as Address | undefined;
        const receipt = await this.payX402Challenge(challenge, preferredToken);
        await axlSend(envelope.from, { type: 'payment_receipt', receipt });
        break;
      }
      case 'heartbeat':
        break;
      default:
        console.warn(`[${AGENT_ID}] unknown msg type: ${msg.type}`);
    }
  }

  private getWatchedAddresses(): Address[] {
    const raw = process.env.WATCHED_ADDRESSES ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is Address => /^0x[0-9a-fA-F]{40}$/.test(s));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const privateKey = process.env.TREASURER_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error(`[${AGENT_ID}] TREASURER_PRIVATE_KEY not set or invalid. Exiting.`);
    process.exit(1);
  }
  const treasurer = new Treasurer(privateKey as `0x${string}`);
  console.log(`[${AGENT_ID}] starting — chain=Base(${BASE_CHAIN_ID})`);
  await treasurer.startPollLoop();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
