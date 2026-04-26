// edge-cases.ts — Day 4 stretch: deadline guard, slippage tuning, gas cap.
//
// All helpers are pure (no I/O, no env reads except where explicitly noted)
// so they can be unit-tested without mocking RPC or fetch.
//
// Design notes:
//   - Slippage classification picks a sane default per pair shape (stable /
//     stable+blue-chip / volatile). Caller can always override.
//   - Deadline guard checks that a Uniswap quote is still fresh enough to
//     broadcast. Buffer protects against in-flight RPC + mempool delay.
//   - Gas cap stops a misconfigured RPC or congested block from burning
//     more than the operator budgeted.

import type { Address } from './index';

// ---------------------------------------------------------------------------
// Per-token slippage classification (Base mainnet)
// ---------------------------------------------------------------------------
//
// Stable: USD-pegged ERC-20s. Pair drift is dominated by depeg events,
// not price movement, so very tight slippage is correct (0.1%).
//
// Blue chip: WETH and liquid staking variants. Paired against a stable or
// each other, ~0.5% covers normal block-to-block movement on Base.
//
// Volatile: anything else (long-tail tokens, agent currencies like VIRTUAL).
// 1% is the floor that survives one or two block reorgs without aborting.
//
// NOTE on USDT: there is no canonical Tether USDT issued natively on Base
// mainnet at the time of writing. We deliberately omit it so that an
// unverified bridged variant is not silently treated as a stable.

const STABLE_TOKENS: ReadonlySet<string> = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (native, Circle)
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI (bridged)
]);

const BLUE_CHIP_TOKENS: ReadonlySet<string> = new Set([
  '0x4200000000000000000000000000000000000006', // WETH
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
]);

export type SlippageClass = 'stable' | 'lowVol' | 'volatile';

/** Classifies a swap pair to pick a sane default slippage tolerance. */
export function classifyPair(tokenIn: Address, tokenOut: Address): SlippageClass {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  const aStable = STABLE_TOKENS.has(a);
  const bStable = STABLE_TOKENS.has(b);
  if (aStable && bStable) return 'stable';
  const aBlue = BLUE_CHIP_TOKENS.has(a);
  const bBlue = BLUE_CHIP_TOKENS.has(b);
  if ((aStable || aBlue) && (bStable || bBlue)) return 'lowVol';
  return 'volatile';
}

/**
 * Default slippage tolerance (percent) for a pair.
 * Stable/stable: 0.1%, blue-chip+stable or blue-chip pair: 0.5%, anything
 * else: 1.0%. Caller may override via UniswapClient.getQuote slippageOverride.
 */
export function getSlippageForPair(tokenIn: Address, tokenOut: Address): number {
  switch (classifyPair(tokenIn, tokenOut)) {
    case 'stable':
      return 0.1;
    case 'lowVol':
      return 0.5;
    case 'volatile':
      return 1.0;
  }
}

// ---------------------------------------------------------------------------
// Deadline validation
// ---------------------------------------------------------------------------

/** Buffer in seconds — quote must be valid for at least this long after now. */
export const QUOTE_DEADLINE_BUFFER_SEC = 30;

/**
 * Validates a Uniswap quote deadline (Unix seconds) against the current time.
 *
 *   - If `deadline` is missing or non-numeric → returns null (caller decides).
 *     Trading API does not always populate this field; we do not want to
 *     fail-closed when the upstream simply omitted it.
 *   - If a finite numeric deadline is present (including `0` / negatives) →
 *     throws when remaining time is below QUOTE_DEADLINE_BUFFER_SEC,
 *     otherwise returns seconds remaining. We treat `0` as authoritative
 *     "expired", not as "skip" — that prevents an upstream from disabling
 *     the guard by sending zero.
 *
 * `now` is parameterized for tests.
 */
export function assertQuoteFresh(
  deadline: unknown,
  now: number = Math.floor(Date.now() / 1000)
): number | null {
  if (deadline === null || deadline === undefined) return null;
  let dl: number;
  if (typeof deadline === 'number') dl = deadline;
  else if (typeof deadline === 'bigint') dl = Number(deadline);
  else if (typeof deadline === 'string') {
    if (deadline.trim() === '') return null;
    dl = Number(deadline);
  } else {
    return null;
  }
  if (!Number.isFinite(dl)) return null;
  const remaining = dl - now;
  if (remaining < QUOTE_DEADLINE_BUFFER_SEC) {
    throw new Error(
      `Quote deadline expired or too close: ${remaining}s remaining (need >= ${QUOTE_DEADLINE_BUFFER_SEC}s)`
    );
  }
  return remaining;
}

/**
 * Safe nested-object accessor — returns the value at `key` if `obj` is a
 * plain object, otherwise undefined. Avoids the `as Record<string, unknown>`
 * cast lying about non-object values.
 */
function getProp(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key];
}

/**
 * Searches a Uniswap Trading API response for a swap deadline. The Trading
 * API has been observed to expose this field in two places depending on
 * route + version:
 *   - top-level `quote.deadline`
 *   - inside the Permit2 typed data: `permitData.values.deadline`
 *
 * Unit normalisation: a current Unix-seconds timestamp is ~1.7e9. A current
 * ms timestamp is ~1.7e12, μs ~1.7e15, ns ~1.7e18. We divide by 1000 in a
 * loop while the value is above 1e12, so any of these get reduced back to
 * seconds. If the resulting value is still implausibly far in the future
 * (more than 7 days from `nowSec`), we reject it — that catches a buggy
 * upstream that, say, multiplied seconds by 1000 twice.
 *
 * Returns null when nothing parseable is found — caller (assertQuoteFresh)
 * then skips the check rather than failing closed on missing data.
 */
const MAX_REASONABLE_DEADLINE_AHEAD_SEC = 7 * 24 * 60 * 60; // 7 days

export function extractQuoteDeadline(
  quoteResponse: unknown,
  nowSec: number = Math.floor(Date.now() / 1000)
): number | null {
  if (typeof quoteResponse !== 'object' || quoteResponse === null) return null;
  const candidates: unknown[] = [
    getProp(getProp(quoteResponse, 'quote'), 'deadline'),
    getProp(getProp(getProp(quoteResponse, 'permitData'), 'values'), 'deadline'),
  ];

  for (const v of candidates) {
    if (v === null || v === undefined) continue;
    let n: number;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'bigint') n = Number(v);
    else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
    else continue;
    if (!Number.isFinite(n) || n <= 0) continue;
    // Drop progressively more zeros while the magnitude says "not seconds".
    let safety = 0;
    while (n > 1e12 && safety < 6) {
      n = Math.floor(n / 1000);
      safety++;
    }
    // If after normalisation the deadline is unreasonably far in the future
    // (e.g. malformed upstream that pushed the value into the millennia),
    // bail rather than treating it as "always fresh".
    if (n - nowSec > MAX_REASONABLE_DEADLINE_AHEAD_SEC) continue;
    return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gas-cost guard
// ---------------------------------------------------------------------------

/** Default abort threshold: 0.001 ETH = 1e15 wei. */
export const DEFAULT_GAS_ABORT_WEI = 1_000_000_000_000_000n;

/**
 * Absolute upper bound on a single swap's gas limit. A typical Uniswap V3/V4
 * swap on Base lands well under 500k. Capping at 2M is generous but stops
 * a malicious /v1/swap response from echoing an absurd `gasLimit` that would
 * pass the cost check via a low gasPrice, only to cost more once the wallet
 * recomputes fees at broadcast time.
 */
export const ABSOLUTE_GAS_LIMIT_CEILING = 2_000_000n;

/**
 * Picks the gas limit to broadcast with: max of locally-estimated value and
 * any hint the API returned, capped at ABSOLUTE_GAS_LIMIT_CEILING. Throws if
 * even the local estimate is above the ceiling — that means something is
 * very wrong and we should not broadcast.
 */
export function selectGasLimit(
  localEstimate: bigint,
  apiHint: bigint | null,
  ceiling: bigint = ABSOLUTE_GAS_LIMIT_CEILING
): bigint {
  if (localEstimate <= 0n) throw new Error('Local gas estimate must be positive');
  if (localEstimate > ceiling) {
    throw new Error(
      `Local gas estimate ${localEstimate} exceeds absolute ceiling ${ceiling} — refusing to broadcast`
    );
  }
  const hint = apiHint && apiHint > 0n ? apiHint : 0n;
  const picked = hint > localEstimate ? hint : localEstimate;
  if (picked > ceiling) {
    // Hint pushed past the ceiling — clamp, but log so an operator can spot
    // a hostile or misconfigured gateway echoing absurd gas hints.
    console.warn(
      `[edge-cases] selectGasLimit: API hint ${hint} clamped down to ceiling ${ceiling}`
    );
    return ceiling;
  }
  return picked;
}

/**
 * Reads `GAS_ABORT_THRESHOLD_WEI` env var; falls back to DEFAULT_GAS_ABORT_WEI.
 * Non-positive or unparseable values fall back too (we do not want to silently
 * disable the guard).
 */
export function getGasAbortThresholdWei(): bigint {
  const raw = process.env.GAS_ABORT_THRESHOLD_WEI;
  if (!raw) return DEFAULT_GAS_ABORT_WEI;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : DEFAULT_GAS_ABORT_WEI;
  } catch {
    return DEFAULT_GAS_ABORT_WEI;
  }
}

/**
 * Computes total gas cost in wei (gasLimit * gasPrice) and throws if it
 * exceeds the abort threshold. Returns the computed cost on success so the
 * caller can log it.
 */
export function assertGasCostBelowThreshold(
  gasLimit: bigint,
  gasPrice: bigint,
  threshold: bigint = getGasAbortThresholdWei()
): bigint {
  if (gasLimit <= 0n) throw new Error('Gas limit must be positive');
  if (gasPrice <= 0n) throw new Error('Gas price must be positive');
  const cost = gasLimit * gasPrice;
  if (cost > threshold) {
    throw new Error(
      `Gas cost ${cost} wei exceeds abort threshold ${threshold} wei (override via GAS_ABORT_THRESHOLD_WEI)`
    );
  }
  return cost;
}
