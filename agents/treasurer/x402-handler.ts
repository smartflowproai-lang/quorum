// x402-handler.ts — HTTP 402 challenge settler
//
// Handles the full "pay-with-any-token" flow when a QUORUM agent hits a
// paywalled x402 endpoint and can't pay in the required token.
//
// Research source: openagents-sdk-research-2026-04-22.md §3.6
// "The pay-with-any-token skill: Pay HTTP 402 challenges (MPP/x402)
//  using tokens via Uniswap swaps."
//
// x402 protocol: https://docs.x402.org/guides/mcp-server-with-x402
// Facilitator: xpay.sh (Tom's SmartFlow observatory uses this in production)
//
// FLOW DIAGRAM:
// =============
//   Agent request
//       ↓
//   HTTP 402 ← endpoint returns WWW-Authenticate: x402 ...
//       ↓
//   X402Handler.handleX402(challenge, preferredToken)
//       ↓
//   Does Treasurer hold challenge.tokenAddress?
//     YES → skip swap → settle directly
//     NO  → UniswapClient.getQuote(preferredToken, challenge.tokenAddress, ...)
//              → signPermit2 → executeSwap → receive challenge.tokenAddress
//              → settle payment
//       ↓
//   PaymentReceipt returned to caller
//   Caller retries original HTTP request with X-Payment header
//
// TODO Day 4 — implementation steps per method (see individual TODOs below)

import type { Address, X402Challenge, PaymentReceipt, TokenBalance } from './index';
import { UniswapClient } from './uniswap-client';

// ---------------------------------------------------------------------------
// X402Handler
// ---------------------------------------------------------------------------

export class X402Handler {
  constructor(
    private readonly uniswap: UniswapClient,
    private readonly signerPrivateKey: `0x${string}`
  ) {}

  // -------------------------------------------------------------------------
  // handleX402 — main entry point
  // -------------------------------------------------------------------------

  /**
   * Decides whether to pay directly or swap first, then settles the challenge.
   *
   * Called by Treasurer.payX402Challenge() — never call directly from agents.
   *
   * TODO Day 4 — implementation steps:
   *   1. Call checkBalance(challenge.tokenAddress) to see if we hold enough.
   *   2. If yes:
   *      a. Call settleChallenge(challenge, challenge.tokenAddress, challenge.amount).
   *      b. Return PaymentReceipt with swapTxHash = undefined.
   *   3. If no (or insufficient balance):
   *      a. Determine which token to swap FROM:
   *         - preferredToken if provided (and we hold it)
   *         - WETH if we hold enough WETH
   *         - USDC as last resort
   *      b. Call this.uniswap.getQuote(fromToken, challenge.tokenAddress, neededAmount).
   *      c. Sign Permit2 via this.uniswap.signPermit2(quote.permitData, this.signerPrivateKey).
   *      d. Execute swap: this.uniswap.executeSwap(signedQuote, this.signerPrivateKey).
   *      e. After swap lands, call settleChallenge().
   *      f. Return PaymentReceipt with swapTxHash from step d.
   *
   * @param challenge       Parsed 402 challenge
   * @param preferredToken  Token to use for swap-from (optional)
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
      `preferredToken=${preferredToken?.slice(0, 10) ?? 'auto'}…`
    );

    // TODO Day 4: check balance, conditionally swap, then settle
    // See implementation steps above.

    // Stub — types compile, throws at runtime
    void preferredToken;
    throw new Error('X402Handler.handleX402: not implemented yet (TODO Day 4)');
  }

  // -------------------------------------------------------------------------
  // checkBalance — internal helper
  // -------------------------------------------------------------------------

  /**
   * Checks if the Treasurer wallet holds at least `requiredAmount` of `tokenAddress`.
   *
   * TODO Day 4 — implementation steps:
   *   1. Call Treasurer.getBalances() (or better: inject a getBalances callback to avoid circular import).
   *   2. Find the TokenBalance entry matching tokenAddress.
   *   3. Compare rawAmount >= requiredAmount (use BigInt comparison, not Number — overflow risk).
   *   4. Return TokenBalance if sufficient, null if not.
   *
   * IMPORTANT: Use BigInt comparison, not Number.
   *   BAD:  parseInt(balance.rawAmount) >= parseInt(requiredAmount)  ← overflows for USDC amounts
   *   GOOD: BigInt(balance.rawAmount) >= BigInt(requiredAmount)
   *
   * @param tokenAddress   ERC-20 to check
   * @param requiredAmount Amount needed in smallest units (string)
   */
  async checkBalance(
    tokenAddress: Address,
    requiredAmount: string
  ): Promise<TokenBalance | null> {
    // TODO Day 4: implement via viem publicClient.readContract({ functionName: 'balanceOf' })
    console.log('[x402-handler] checkBalance stub', { tokenAddress, requiredAmount });
    return null;
  }

  // -------------------------------------------------------------------------
  // settleChallenge — posts the payment to the facilitator
  // -------------------------------------------------------------------------

  /**
   * Settles an x402 challenge by POSTing a signed payment proof to the paywall endpoint.
   *
   * x402 payment flow:
   *   Client → GET /endpoint → 402 { paymentRequired: { ... } }
   *   Client → signs & creates payment proof (EIP-712 or simple transfer)
   *   Client → GET /endpoint + X-Payment: <base64-encoded proof> → 200 OK
   *
   * TODO Day 4 — implementation steps:
   *   1. Use Coinbase x402 client library (@coinbase/x402-axios) if available, OR:
   *   2. Build proof manually:
   *      a. Create EIP-712 typed data for payment (see x402 spec).
   *      b. Sign with Treasurer's private key using viem's signTypedData.
   *      c. Encode as base64 string.
   *   3. POST to challenge.url with header:
   *      X-Payment: <encoded proof>
   *   4. Parse 200 response body — this is the actual API data the agent wanted.
   *   5. Return PaymentReceipt.
   *
   * Facilitator note: xpay.sh validates the payment proof before forwarding
   * the request to the underlying endpoint. Our observatory uses xpay.sh —
   * same facilitator Treasurer will use for QUORUM x402 payments.
   *
   * @param challenge      The 402 challenge to settle
   * @param paidToken      Which token was actually used (may differ from requested after swap)
   * @param paidAmount     Actual amount paid in smallest units
   * @param swapTxHash     If a swap was done, the swap tx hash (for audit trail)
   */
  async settleChallenge(
    challenge: X402Challenge,
    paidToken: Address,
    paidAmount: string,
    swapTxHash?: `0x${string}`
  ): Promise<PaymentReceipt> {
    // TODO Day 4: build proof + POST to challenge.url + X-Payment header
    console.log('[x402-handler] settleChallenge stub', {
      url: challenge.url,
      paidToken,
      paidAmount,
      swapTxHash,
    });

    // Stub
    throw new Error('X402Handler.settleChallenge: not implemented yet (TODO Day 4)');
  }
}
