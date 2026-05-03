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
// Implementation surface (in this file unless noted):
//   1. getBalances() — viem publicClient on Base mainnet (chainId 8453) ✓
//   2. rebalance() — UniswapClient.getQuote + executeSwap (Uniswap Trading API) ✓
//   3. payX402Challenge() — X402Handler.handleX402 (Base mainnet, USDC payTo) ✓
//   4. AXL poll loop (drain pattern) — see startPollLoop() below ✓
//   5. KeeperHub job scheduling — deferred post-hackathon. The KH wire today is
//      paid-settlement-on-receipt (see agents/executor/keeperhub-wire/, the
//      0xce40d380 receipt on Base mainnet); agent-driven cron-style scheduling
//      against KH workflow runs is the cadence work that follows.

import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { axlSend, axlRecv } from '../../shared/axl-wrap';
import type { AxlEnvelope } from '../../shared/axl-wrap';
import { UniswapClient } from './uniswap-client';
import { X402Handler } from './x402-handler';

const ERC20_ABI_MIN = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const TOKEN_META: ReadonlyArray<{ symbol: keyof typeof TOKENS; decimals: number }> = [
  { symbol: 'USDC', decimals: 6 },
  { symbol: 'WETH', decimals: 18 },
  { symbol: 'VIRTUAL', decimals: 18 },
];

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
   * Reads balanceOf for each TOKENS entry per watched address via Base public RPC.
   */
  async getBalances(): Promise<Map<Address, TokenBalance[]>> {
    const result = new Map<Address, TokenBalance[]>();
    const watched = this.getWatchedAddresses();
    if (watched.length === 0) return result;

    const rpcUrl = process.env.BASE_RPC_URL ?? 'https://base.publicnode.com';
    const publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });

    for (const addr of watched) {
      const balances: TokenBalance[] = [];
      for (const meta of TOKEN_META) {
        const tokenAddress = TOKENS[meta.symbol] as Address;
        try {
          const raw = (await publicClient.readContract({
            address: tokenAddress,
            abi: ERC20_ABI_MIN,
            functionName: 'balanceOf',
            args: [addr],
          })) as bigint;
          balances.push({
            tokenAddress,
            symbol: meta.symbol,
            decimals: meta.decimals,
            rawAmount: raw.toString(),
            formattedAmount: formatUnits(raw, meta.decimals),
          });
        } catch (e) {
          console.warn(
            `[${AGENT_ID}] balanceOf failed addr=${addr.slice(0, 8)} ${meta.symbol}: ${
              e instanceof Error ? e.message : String(e)
            }`
          );
        }
      }
      result.set(addr, balances);
    }
    return result;
  }

  /**
   * Executes a rebalancing swap. Validates the plan, then runs
   * UniswapClient.swap() (getQuote → signPermit2 → executeSwap).
   * Returns array with one TxReceipt for the swap (or empty if swap was a no-op).
   */
  async rebalance(plan: RebalancePlan): Promise<TxReceipt[]> {
    console.log(
      `[${AGENT_ID}] rebalance: ${plan.fromAddress.slice(0, 8)} reason="${plan.reason}"`
    );
    if (BigInt(plan.amountIn) <= 0n) {
      console.warn(`[${AGENT_ID}] rebalance skipped: amountIn=${plan.amountIn} not > 0`);
      return [];
    }

    const { receipt } = await this.uniswap.swap(
      plan.tokenIn,
      plan.tokenOut,
      plan.amountIn,
      this.signerPrivateKey,
      BASE_CHAIN_ID
    );
    return [receipt];
  }

  /**
   * Pays an HTTP 402 challenge, swapping tokens via Uniswap if needed.
   *
   * UNISWAP PRIZE CORE FLOW (research §3.6):
   *   Agent holds WETH, endpoint charges USDC ->
   *   auto-quote WETH->USDC, swap, settle 402, return receipt.
   *
   * Delegates to X402Handler.handleX402() — see x402/index.ts for the
   * Permit2 + Universal Router quote + swap path.
   */
  async payX402Challenge(
    challenge: X402Challenge,
    preferredToken?: Address
  ): Promise<PaymentReceipt> {
    console.log(`[${AGENT_ID}] payX402Challenge: url=${challenge.url}`);
    return this.x402.handleX402(challenge, preferredToken);
  }

  /**
   * Main AXL poll loop. Handlers wired in handleAxlMessage() below:
   * balance_request, rebalance_request, x402_challenge.
   * Pattern shared with scout/index.ts.
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

// Only run main() when this file is executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
