// uniswap-client.ts — Uniswap Trading API wrapper (Day 4 implementation)
//
// Research source: openagents-sdk-research-2026-04-22.md §3.4
//
// Uniswap Trading API base: https://trade-api.gateway.uniswap.org/v1
// Auth header: x-api-key: <UNISWAP_API_KEY>
//
// Flow:
//   1. getQuote: POST /v1/quote → returns quote + permitData (Permit2 typed data)
//   2. signPermit2: viem signTypedData on permitData → returns hex signature
//   3. executeSwap: POST /v1/swap with signed permit → returns calldata → broadcast via viem
//
// Permit2 is non-optional — Universal Router pulls tokens via Permit2 signature
// in a single tx (no separate approve()).

import {
  createWalletClient,
  createPublicClient,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import type { Address, TxReceipt } from './index';

// ---------------------------------------------------------------------------
// Types — Uniswap Trading API shapes
// ---------------------------------------------------------------------------

export interface QuoteRequest {
  type: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  amount: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  tokenIn: Address;
  tokenOut: Address;
  swapper: Address;
  slippageTolerance?: number;
  routingPreference?: 'BEST_PRICE' | 'FASTEST';
  protocols?: Array<'V2' | 'V3' | 'V4' | 'UNISWAPX_V2' | 'UNISWAPX_V3'>;
}

export interface QuoteResponse {
  requestId: string;
  quote: {
    amountIn: string;
    amountOut: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  permitData?: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    values: Record<string, unknown>;
  };
  routing: string;
}

export interface SwapRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quote: any;
  permitSignature: Hex;
}

export interface SwapResponse {
  swap: {
    to: Address;
    data: Hex;
    value?: string;
    from?: Address;
    gasLimit?: string;
    chainId?: number;
  };
}

export interface SignedQuote {
  quoteResponse: QuoteResponse;
  permitSignature: Hex;
  swapper: Address;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UNISWAP_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// HTTP helper with retry + exponential backoff
// ---------------------------------------------------------------------------

async function httpRequestWithRetry(
  url: string,
  init: RequestInit,
  retries: number = MAX_RETRIES
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(t);
      // 5xx → retry; 4xx → no retry (caller error)
      if (res.status >= 500 && attempt < retries - 1) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === retries - 1) break;
      await sleep(2 ** attempt * 500);
    }
  }
  throw new Error(
    `HTTP request failed after ${retries} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// UniswapClient
// ---------------------------------------------------------------------------

export class UniswapClient {
  private readonly apiKey: string;
  private readonly rpcUrl: string;

  constructor() {
    const key = process.env.UNISWAP_API_KEY;
    if (!key) {
      console.warn('[uniswap-client] UNISWAP_API_KEY not set — swap calls will fail');
    }
    this.apiKey = key ?? '';
    this.rpcUrl = process.env.BASE_RPC_URL ?? 'https://base.publicnode.com';
  }

  // -------------------------------------------------------------------------
  // getQuote
  // -------------------------------------------------------------------------

  /**
   * Fetches a swap quote from Uniswap Trading API.
   *
   * Endpoint: POST https://trade-api.gateway.uniswap.org/v1/quote
   *
   * Returns QuoteResponse with optional permitData. Caller must call
   * signPermit2(quote.permitData, signerPrivateKey) before passing to executeSwap.
   *
   * Pitfall: Base chainId = 8453, NOT 84532 (that's Sepolia testnet).
   *
   * @throws Error on 4xx, network failure, or missing fields in response.
   */
  async getQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: string,
    chainId: number = 8453,
    swapperOverride?: Address
  ): Promise<QuoteResponse> {
    if (!this.apiKey) {
      throw new Error('UniswapClient.getQuote: UNISWAP_API_KEY env var is required');
    }

    const swapper = swapperOverride
      ?? (process.env.TREASURER_WALLET_ADDRESS as Address | undefined);
    if (!swapper || !/^0x[0-9a-fA-F]{40}$/.test(swapper)) {
      throw new Error(
        'UniswapClient.getQuote: TREASURER_WALLET_ADDRESS env var is required (or pass swapperOverride)'
      );
    }

    const requestBody: QuoteRequest = {
      type: 'EXACT_INPUT',
      amount: amountIn,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      tokenIn,
      tokenOut,
      swapper,
      slippageTolerance: 0.5,
      routingPreference: 'BEST_PRICE',
      // V3 + V4 only — UniswapX is async/off-chain, bad for live demos
      protocols: ['V3', 'V4'],
    };

    const res = await httpRequestWithRetry(`${UNISWAP_API_BASE}/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Uniswap /quote failed: ${res.status} ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as QuoteResponse;
    if (!json.quote || !json.quote.amountOut || BigInt(json.quote.amountOut) <= 0n) {
      throw new Error(
        `Uniswap /quote returned invalid quote (amountOut=${json.quote?.amountOut})`
      );
    }
    return json;
  }

  // -------------------------------------------------------------------------
  // signPermit2
  // -------------------------------------------------------------------------

  /**
   * Signs the Permit2 typed data returned in QuoteResponse.permitData.
   *
   * Permit2 lets Uniswap's Universal Router pull tokens from the swapper
   * wallet in a single tx, without a separate approve() tx.
   *
   * Pitfall: primaryType varies — could be 'PermitSingle', 'PermitTransferFrom',
   * or 'PermitBatchTransferFrom'. Auto-detect from types object keys.
   */
  async signPermit2(
    permitData: NonNullable<QuoteResponse['permitData']>,
    signerPrivateKey: Hex
  ): Promise<Hex> {
    const account = privateKeyToAccount(signerPrivateKey);
    const client = createWalletClient({
      account,
      chain: base,
      transport: http(this.rpcUrl),
    });

    // Auto-detect primaryType from types object — Trading API does not
    // explicitly mark which type is the entry point.
    const typeKeys = Object.keys(permitData.types);
    const candidates = [
      'PermitSingle',
      'PermitTransferFrom',
      'PermitBatchTransferFrom',
      'PermitBatch',
    ];
    const primaryType = candidates.find((c) => typeKeys.includes(c));
    if (!primaryType) {
      throw new Error(
        `signPermit2: cannot detect primaryType from types keys: ${typeKeys.join(', ')}`
      );
    }

    // viem signTypedData expects EIP-712 structure
    const sig = await client.signTypedData({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      domain: permitData.domain as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      types: permitData.types as any,
      primaryType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      message: permitData.values as any,
    });
    return sig;
  }

  // -------------------------------------------------------------------------
  // executeSwap
  // -------------------------------------------------------------------------

  /**
   * Builds the swap transaction via /v1/swap and broadcasts it on-chain.
   *
   * Steps:
   *   1. POST /v1/swap with {quote, permitSignature} → returns calldata.
   *   2. Build viem walletClient with signer.
   *   3. sendTransaction({ to, data, value }).
   *   4. waitForTransactionReceipt → return TxReceipt.
   */
  async executeSwap(
    signedQuote: SignedQuote,
    signerPrivateKey: Hex
  ): Promise<TxReceipt> {
    if (!this.apiKey) {
      throw new Error('UniswapClient.executeSwap: UNISWAP_API_KEY env var is required');
    }

    // Step 1: POST /v1/swap to get calldata
    const swapBody: SwapRequest = {
      quote: signedQuote.quoteResponse.quote,
      permitSignature: signedQuote.permitSignature,
    };

    const swapRes = await httpRequestWithRetry(`${UNISWAP_API_BASE}/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(swapBody),
    });

    if (!swapRes.ok) {
      const text = await swapRes.text().catch(() => '');
      throw new Error(
        `Uniswap /swap failed: ${swapRes.status} ${text.slice(0, 500)}`
      );
    }

    const swapData = (await swapRes.json()) as SwapResponse;
    if (!swapData.swap || !swapData.swap.to || !swapData.swap.data) {
      throw new Error(
        `Uniswap /swap returned invalid response (missing to/data): ${JSON.stringify(swapData).slice(0, 300)}`
      );
    }

    // Step 2 + 3: broadcast via viem
    const account = privateKeyToAccount(signerPrivateKey);
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(this.rpcUrl),
    });
    const publicClient = createPublicClient({
      chain: base,
      transport: http(this.rpcUrl),
    });

    const txHash = await walletClient.sendTransaction({
      to: swapData.swap.to,
      data: swapData.swap.data,
      value: BigInt(swapData.swap.value ?? '0'),
    });

    // Step 4: wait for receipt (default timeout ~30s for Base)
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });

    return {
      txHash,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      timestamp: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Convenience: full swap flow (getQuote → signPermit2 → executeSwap)
  // -------------------------------------------------------------------------

  /**
   * One-call swap: quote → sign → execute. Use for simple cases where
   * the caller doesn't need to inspect the quote before committing.
   */
  async swap(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: string,
    signerPrivateKey: Hex,
    chainId: number = 8453
  ): Promise<{ quote: QuoteResponse; receipt: TxReceipt }> {
    const swapper = privateKeyToAccount(signerPrivateKey).address as Address;
    const quote = await this.getQuote(tokenIn, tokenOut, amountIn, chainId, swapper);

    if (!quote.permitData) {
      throw new Error('UniswapClient.swap: quote response has no permitData (cannot sign)');
    }

    const permitSignature = await this.signPermit2(quote.permitData, signerPrivateKey);
    const signedQuote: SignedQuote = {
      quoteResponse: quote,
      permitSignature,
      swapper,
    };
    const receipt = await this.executeSwap(signedQuote, signerPrivateKey);
    return { quote, receipt };
  }
}
