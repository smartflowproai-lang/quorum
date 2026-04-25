// uniswap-client.ts — Uniswap Trading API wrapper
//
// Research source: openagents-sdk-research-2026-04-22.md §3.4
//
// Uniswap Trading API base: https://trade-api.gateway.uniswap.org/v1
// Auth header: x-api-key: <UNISWAP_API_KEY>
//
// THIS MODULE IS THE HACKATHON DEPTH SIGNAL:
// ===========================================
// Uniswap prize criteria: "reliability, transparency, composability."
// This wrapper:
//   - Handles Permit2 signature flow (quote → sign permitData → swap)
//   - Executes on Base mainnet (chainId 8453) — NOT testnet theater
//   - Is called by Treasurer.rebalance() AND X402Handler.handleX402()
//   - Creates a composable primitive other QUORUM agents can call
//
// Key insight from research doc §3.10 (common pitfalls):
//   "Permit2 signature required for most quotes — the permitData in /quote
//    response must be signed, then passed to /swap."
// This is the most common failure point — we handle it explicitly here.
//
// TODO Day 4 — implementation steps per method (see individual TODOs below):
//   1. getQuote: POST /v1/quote with correct Base chain IDs and token addresses
//   2. signPermit2: sign permitData from quote using viem signTypedData
//   3. executeSwap: POST /v1/swap with signed permit, then broadcast via viem
//   4. Add retry logic (3 attempts, exponential backoff) for API failures

import type { Address, TxReceipt } from './index';

// ---------------------------------------------------------------------------
// Types — Uniswap Trading API shapes
// ---------------------------------------------------------------------------

/** Request to POST /v1/quote */
export interface QuoteRequest {
  type: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  /** In smallest token units (e.g. USDC has 6 decimals: "10000000" = 10 USDC) */
  amount: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  tokenIn: Address;
  tokenOut: Address;
  /** Wallet that will execute the swap */
  swapper: Address;
  /** 0–100, percentage with 2 decimal places. Default: 0.5 */
  slippageTolerance?: number;
  /** Default: BEST_PRICE */
  routingPreference?: 'BEST_PRICE' | 'FASTEST';
  /** Which pools to route through. Default: all. */
  protocols?: Array<'V2' | 'V3' | 'V4' | 'UNISWAPX_V2' | 'UNISWAPX_V3'>;
}

/** /v1/quote response (partial — only fields we use) */
export interface QuoteResponse {
  requestId: string;
  quote: {
    amountIn: string;
    amountOut: string;
    /** The full quote object, passed verbatim to /v1/swap */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  /** Permit2 typed data that must be signed before calling /v1/swap */
  permitData?: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    values: Record<string, unknown>;
  };
  routing: string;
}

/** /v1/swap request */
export interface SwapRequest {
  /** quote.quote from QuoteResponse — pass verbatim */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quote: any;
  /** Signed EIP-712 signature of permitData from QuoteResponse */
  permitSignature: `0x${string}`;
}

/** /v1/swap response (partial) */
export interface SwapResponse {
  /** Transaction calldata */
  data: `0x${string}`;
  /** Destination contract (Uniswap Universal Router) */
  to: Address;
  /** ETH value to send (for ETH-in swaps) */
  value?: string;
}

/** Combined Quote with permit signature — passed to executeSwap */
export interface SignedQuote {
  quoteResponse: QuoteResponse;
  permitSignature: `0x${string}`;
  /** Swapper wallet address (needed for tx broadcast) */
  swapper: Address;
}

// ---------------------------------------------------------------------------
// UniswapClient
// ---------------------------------------------------------------------------

const UNISWAP_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';

export class UniswapClient {
  private readonly apiKey: string;

  constructor() {
    const key = process.env.UNISWAP_API_KEY;
    if (!key) {
      // Non-fatal during scaffold — will throw at runtime when methods are called
      console.warn('[uniswap-client] UNISWAP_API_KEY not set — swap calls will fail');
    }
    this.apiKey = key ?? '';
  }

  // -------------------------------------------------------------------------
  // getQuote
  // -------------------------------------------------------------------------

  /**
   * Fetch a swap quote from Uniswap Trading API.
   *
   * Research: openagents-sdk-research-2026-04-22.md §3.4
   * Endpoint: POST https://trade-api.gateway.uniswap.org/v1/quote
   *
   * TODO Day 4 — implementation steps:
   *   1. Build QuoteRequest from params (Base chain = 8453, slippage default 0.5%).
   *   2. POST to UNISWAP_API_BASE/quote with x-api-key header.
   *   3. Parse QuoteResponse — validate amountOut is reasonable (> 0).
   *   4. Return QuoteResponse — caller must sign permitData before executeSwap.
   *
   * PITFALL (from research §3.10):
   *   "Base chain ID = 8453 (easy to fumble, especially vs Base Sepolia = 84532)"
   *   Always pass BASE_CHAIN_ID (8453), never 84532.
   *
   * @param tokenIn    ERC-20 address to sell
   * @param tokenOut   ERC-20 address to buy
   * @param amountIn   Amount to sell in smallest units (string to avoid BigInt issues)
   * @param chainId    Chain where swap executes — default 8453 (Base mainnet)
   */
  async getQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: string,
    chainId: number = 8453
  ): Promise<QuoteResponse> {
    const requestBody: QuoteRequest = {
      type: 'EXACT_INPUT',
      amount: amountIn,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      tokenIn,
      tokenOut,
      // TODO Day 4: replace with Treasurer wallet address from env
      swapper: (process.env.TREASURER_WALLET_ADDRESS ?? '0x0000000000000000000000000000000000000000') as Address,
      slippageTolerance: 0.5,
      routingPreference: 'BEST_PRICE',
      // Use V3 + V4 for Base — best liquidity. Avoid UniswapX (async, bad for demos).
      protocols: ['V3', 'V4'],
    };

    // TODO Day 4 — replace stub with real fetch:
    //
    // const res = await fetch(`${UNISWAP_API_BASE}/quote`, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'x-api-key': this.apiKey,
    //   },
    //   body: JSON.stringify(requestBody),
    // });
    //
    // if (!res.ok) {
    //   const text = await res.text().catch(() => '');
    //   throw new Error(`Uniswap /quote failed: ${res.status} ${text}`);
    // }
    //
    // return res.json() as Promise<QuoteResponse>;

    console.log('[uniswap-client] getQuote stub called', { tokenIn, tokenOut, amountIn, chainId });
    console.log('[uniswap-client] requestBody would be:', requestBody);

    // Stub — replace above comment block with real impl
    throw new Error('UniswapClient.getQuote: not implemented yet (TODO Day 4)');
  }

  // -------------------------------------------------------------------------
  // signPermit2
  // -------------------------------------------------------------------------

  /**
   * Signs the Permit2 typed data returned in QuoteResponse.permitData.
   *
   * PERMIT2 IS NON-OPTIONAL:
   * ========================
   * Research §3.10: "Permit2 signature required for most quotes — the
   * permitData in /quote response must be signed, then passed to /swap.
   * Not obvious, and any screw-up here = swap fails."
   *
   * Permit2 lets Uniswap's Universal Router pull tokens from the swapper
   * wallet in a single tx, without a separate approve() tx.
   *
   * TODO Day 4 — implementation steps:
   *   1. Parse permitData from QuoteResponse.
   *   2. Use viem's signTypedData:
   *      ```ts
   *      import { createWalletClient, http } from 'viem';
   *      import { privateKeyToAccount } from 'viem/accounts';
   *      import { base } from 'viem/chains';
   *
   *      const account = privateKeyToAccount(signerPrivateKey);
   *      const client = createWalletClient({ account, chain: base, transport: http() });
   *
   *      const sig = await client.signTypedData({
   *        domain: permitData.domain,
   *        types: permitData.types,
   *        primaryType: 'PermitSingle',   // or 'PermitTransferFrom' — check quote response
   *        message: permitData.values,
   *      });
   *      ```
   *   3. Return the hex signature.
   *
   * @param permitData   From QuoteResponse.permitData
   * @param signerPrivateKey  Treasurer wallet private key
   */
  async signPermit2(
    permitData: NonNullable<QuoteResponse['permitData']>,
    signerPrivateKey: `0x${string}`
  ): Promise<`0x${string}`> {
    // TODO Day 4: implement via viem signTypedData (see comment above)
    console.log('[uniswap-client] signPermit2 stub called', { domainName: permitData.domain['name'] });
    void signerPrivateKey; // suppress unused warning until implemented
    throw new Error('UniswapClient.signPermit2: not implemented yet (TODO Day 4)');
  }

  // -------------------------------------------------------------------------
  // executeSwap
  // -------------------------------------------------------------------------

  /**
   * Builds the swap transaction via /v1/swap and broadcasts it on-chain.
   *
   * TODO Day 4 — implementation steps:
   *   1. POST to UNISWAP_API_BASE/swap with {quote, permitSignature}.
   *   2. Parse SwapResponse (to, data, value).
   *   3. Create viem walletClient with signer.
   *   4. Broadcast: client.sendTransaction({ to, data, value: BigInt(value ?? 0) }).
   *   5. Wait for receipt: client.waitForTransactionReceipt({ hash }).
   *   6. Return TxReceipt.
   *
   * IMPORTANT: Use `routingPreference: 'BEST_PRICE'` + protocols `['V3','V4']`
   * in the quote request. Avoid UniswapX orders — they are async and off-chain,
   * so the tx won't land immediately (bad for live demos + judge verification).
   *
   * @param signedQuote  Quote + signed Permit2 (output of getQuote + signPermit2)
   * @param signerPrivateKey  Treasurer wallet private key
   */
  async executeSwap(
    signedQuote: SignedQuote,
    signerPrivateKey: `0x${string}`
  ): Promise<TxReceipt> {
    // TODO Day 4 — replace with real implementation:
    //
    // Step 1: POST /v1/swap
    // const swapRes = await fetch(`${UNISWAP_API_BASE}/swap`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
    //   body: JSON.stringify({ quote: signedQuote.quoteResponse.quote, permitSignature: signedQuote.permitSignature }),
    // });
    // const swapData: SwapResponse = await swapRes.json();
    //
    // Step 2: Broadcast via viem
    // const account = privateKeyToAccount(signerPrivateKey);
    // const client = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL) });
    // const hash = await client.sendTransaction({ to: swapData.to, data: swapData.data, value: BigInt(swapData.value ?? 0) });
    //
    // Step 3: Wait for receipt
    // const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
    // const receipt = await publicClient.waitForTransactionReceipt({ hash });
    // return { txHash: hash, status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, timestamp: new Date().toISOString() };

    console.log('[uniswap-client] executeSwap stub called', { swapper: signedQuote.swapper });
    void signerPrivateKey;
    throw new Error('UniswapClient.executeSwap: not implemented yet (TODO Day 4)');
  }
}
