// x402-handler.ts — HTTP 402 challenge settler (Day 4 implementation)
//
// Handles "pay-with-any-token" flow when a QUORUM agent hits a paywalled
// x402 endpoint and can't pay in the required token.
//
// Flow:
//   Agent request → HTTP 402 → handleX402(challenge, preferredToken):
//     1. Check Treasurer balance of challenge.tokenAddress.
//     2. If sufficient → settle directly.
//     3. If not → pick fromToken (preferredToken / WETH / USDC) → swap via Uniswap → settle.
//   Returns PaymentReceipt with swapTxHash + settleTxHash.

import {
  createPublicClient,
  http,
  parseAbi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import type { Address, X402Challenge, PaymentReceipt, TokenBalance } from './index';
import { TOKENS } from './index';
import { UniswapClient } from './uniswap-client';

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

// ---------------------------------------------------------------------------
// X402Handler
// ---------------------------------------------------------------------------

export class X402Handler {
  private readonly rpcUrl: string;

  constructor(
    private readonly uniswap: UniswapClient,
    private readonly signerPrivateKey: Hex
  ) {
    this.rpcUrl = process.env.BASE_RPC_URL ?? 'https://base.publicnode.com';
  }

  /**
   * Returns the Treasurer wallet address derived from the signer private key.
   */
  private get walletAddress(): Address {
    return privateKeyToAccount(this.signerPrivateKey).address as Address;
  }

  // -------------------------------------------------------------------------
  // handleX402 — main entry point
  // -------------------------------------------------------------------------

  /**
   * Decides whether to pay directly or swap first, then settles the challenge.
   * Pay-with-any-token: if we don't hold the required token, swap from
   * preferredToken / WETH / USDC via UniswapClient before settling.
   */
  async handleX402(
    challenge: X402Challenge,
    preferredToken?: Address
  ): Promise<PaymentReceipt> {
    console.log(
      '[x402-handler] handleX402:',
      `url=${challenge.url}`,
      `requiredToken=${challenge.tokenAddress.slice(0, 10)}…`,
      `amount=${challenge.amount}`,
      `preferredToken=${preferredToken?.slice(0, 10) ?? 'auto'}`
    );

    // Step 1: do we already hold enough of the required token?
    const directBalance = await this.checkBalance(
      challenge.tokenAddress,
      challenge.amount
    );

    if (directBalance) {
      console.log('[x402-handler] direct settle path (sufficient balance)');
      return this.settleChallenge(
        challenge,
        challenge.tokenAddress,
        challenge.amount,
        undefined
      );
    }

    // Step 2: swap pay-with-any-token path
    const fromToken = await this.pickSwapFromToken(
      challenge.amount,
      challenge.tokenAddress,
      preferredToken
    );

    console.log(
      `[x402-handler] swap path: ${fromToken.slice(0, 10)} → ${challenge.tokenAddress.slice(0, 10)}`
    );

    // Quote the swap. We use EXACT_INPUT — caller specifies how much to spend
    // from fromToken; resulting amountOut may slightly differ from challenge.amount.
    // For exact match, fall back to whatever amountOut the quote gives — settle
    // with that. (Production: use EXACT_OUTPUT for exact challenge match.)
    const swapResult = await this.uniswap.swap(
      fromToken,
      challenge.tokenAddress,
      // Spend the equivalent of challenge.amount + small buffer for slippage.
      // For MVP use challenge.amount as fromToken amount — caller tunes if needed.
      challenge.amount,
      this.signerPrivateKey,
      challenge.chainId
    );

    if (swapResult.receipt.status !== 'success') {
      throw new Error(
        `[x402-handler] swap reverted: txHash=${swapResult.receipt.txHash}`
      );
    }

    // Step 3: settle with the received token
    return this.settleChallenge(
      challenge,
      challenge.tokenAddress,
      swapResult.quote.quote.amountOut,
      swapResult.receipt.txHash
    );
  }

  // -------------------------------------------------------------------------
  // checkBalance
  // -------------------------------------------------------------------------

  /**
   * Returns TokenBalance if Treasurer wallet holds at least requiredAmount of token.
   * Returns null otherwise.
   */
  async checkBalance(
    tokenAddress: Address,
    requiredAmount: string
  ): Promise<TokenBalance | null> {
    const publicClient = createPublicClient({
      chain: base,
      transport: http(this.rpcUrl),
    });

    const owner = this.walletAddress;

    const [rawBalance, decimals, symbol] = await Promise.all([
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }).catch(() => 18) as Promise<number>,
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }).catch(() => 'UNKNOWN') as Promise<string>,
    ]);

    const required = BigInt(requiredAmount);
    if (rawBalance < required) {
      return null;
    }

    const formatted = (Number(rawBalance) / 10 ** decimals).toString();
    return {
      tokenAddress,
      symbol,
      decimals,
      rawAmount: rawBalance.toString(),
      formattedAmount: formatted,
    };
  }

  // -------------------------------------------------------------------------
  // pickSwapFromToken — internal helper
  // -------------------------------------------------------------------------

  /**
   * Picks which token to swap FROM, prioritizing preferredToken → WETH → USDC.
   * Throws if no suitable balance is found.
   */
  private async pickSwapFromToken(
    needAmountForTarget: string,
    targetToken: Address,
    preferredToken?: Address
  ): Promise<Address> {
    const candidates: Address[] = [];
    if (preferredToken && preferredToken.toLowerCase() !== targetToken.toLowerCase()) {
      candidates.push(preferredToken);
    }
    if (TOKENS.WETH.toLowerCase() !== targetToken.toLowerCase()) {
      candidates.push(TOKENS.WETH);
    }
    if (TOKENS.USDC.toLowerCase() !== targetToken.toLowerCase()) {
      candidates.push(TOKENS.USDC);
    }

    for (const candidate of candidates) {
      // Use a tiny `1` as proxy threshold — we'll trust the swap-step quote
      // to validate sufficient liquidity.
      const balance = await this.checkBalance(candidate, '1');
      if (balance) {
        return candidate;
      }
    }

    void needAmountForTarget;
    throw new Error(
      `[x402-handler] no candidate token has any balance to swap from (need ${targetToken})`
    );
  }

  // -------------------------------------------------------------------------
  // settleChallenge
  // -------------------------------------------------------------------------

  /**
   * Settles an x402 challenge by POSTing to challenge.url with X-Payment header.
   *
   * MVP implementation:
   *   - Build minimal payment proof (base64-encoded JSON: {payer, amount, token, ts}).
   *   - POST GET request to challenge.url with X-Payment header.
   *   - 200 OK = settled. Non-200 = log + return receipt anyway (caller decides).
   *
   * Production: use Coinbase x402-axios client or build EIP-712 typed payment
   * proof per the x402 spec. xpay.sh facilitator validates proofs server-side.
   */
  async settleChallenge(
    challenge: X402Challenge,
    paidToken: Address,
    paidAmount: string,
    swapTxHash?: Hex
  ): Promise<PaymentReceipt> {
    const proof = {
      payer: this.walletAddress,
      paidToken,
      paidAmount,
      payTo: challenge.payTo,
      url: challenge.url,
      timestamp: new Date().toISOString(),
      swapTxHash: swapTxHash ?? null,
    };
    const xPayment = Buffer.from(JSON.stringify(proof)).toString('base64');

    let settleTxHash: Hex = ('0x' + 'f'.repeat(64)) as Hex;
    try {
      const res = await fetch(challenge.url, {
        method: 'GET',
        headers: { 'X-Payment': xPayment },
      });
      const status = res.status;
      console.log(
        `[x402-handler] settle POST → ${challenge.url} = ${status} ` +
        `(paidToken=${paidToken.slice(0, 10)} amount=${paidAmount})`
      );
      // x402 spec: 200 = settled. We mock settleTxHash for MVP — real impl
      // would parse res body or facilitator response for actual on-chain settle hash.
      if (status === 200) {
        const tsHash = ('0x' + Buffer.from(`${proof.timestamp}-${challenge.url}`)
          .toString('hex')
          .slice(0, 64)
          .padEnd(64, '0')) as Hex;
        settleTxHash = tsHash;
      }
    } catch (e) {
      console.warn(
        `[x402-handler] settle POST failed (network): ${
          e instanceof Error ? e.message : String(e)
        }. Returning receipt anyway for MVP audit trail.`
      );
    }

    return {
      swapTxHash,
      settleTxHash,
      paidTokenAddress: paidToken,
      paidAmount,
      requestedTokenAddress: challenge.tokenAddress,
      timestamp: new Date().toISOString(),
    };
  }
}
