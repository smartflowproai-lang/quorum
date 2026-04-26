// edge-cases.test.ts — Day 4 stretch: pure-function tests for slippage,
// deadline guard, gas cap. No RPC, no fetch, no env mocking beyond what we
// set/restore inline.
//
// Run: npx ts-node edge-cases.test.ts

import {
  classifyPair,
  getSlippageForPair,
  assertQuoteFresh,
  extractQuoteDeadline,
  QUOTE_DEADLINE_BUFFER_SEC,
  DEFAULT_GAS_ABORT_WEI,
  ABSOLUTE_GAS_LIMIT_CEILING,
  getGasAbortThresholdWei,
  assertGasCostBelowThreshold,
  selectGasLimit,
} from './edge-cases';
import { TOKENS, type Address } from './index';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}:`, (e as Error).message);
    failed++;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(a: T, b: T, msg?: string): void {
  if (a !== b) throw new Error(`${msg ?? 'assertEqual'}: expected ${String(b)}, got ${String(a)}`);
}

function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
  try {
    fn();
  } catch (e) {
    if (!match.test((e as Error).message)) {
      throw new Error(`${msg}: error did not match ${match} — got: ${(e as Error).message}`);
    }
    return;
  }
  throw new Error(`${msg}: expected throw, none happened`);
}

const DAI_BASE = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb' as Address;
const VIRTUAL_LOWER = TOKENS.VIRTUAL.toLowerCase() as Address;
// Deliberately mis-cased USDC to verify case insensitivity at the boundary.
const USDC_MIXED = '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' as Address;

console.log('\n=== Edge Cases — Slippage / Deadline / Gas Tests ===\n');

// ---------------------------------------------------------------------------
// Group 1: Slippage classification
// ---------------------------------------------------------------------------

console.log('Group 1: Slippage classification');

test('USDC <-> DAI classified as stable, slippage = 0.1%', () => {
  assertEqual(classifyPair(TOKENS.USDC, DAI_BASE), 'stable');
  assertEqual(getSlippageForPair(TOKENS.USDC, DAI_BASE), 0.1);
});

test('USDC <-> WETH classified as lowVol, slippage = 0.5%', () => {
  assertEqual(classifyPair(TOKENS.USDC, TOKENS.WETH), 'lowVol');
  assertEqual(getSlippageForPair(TOKENS.USDC, TOKENS.WETH), 0.5);
});

test('USDC <-> VIRTUAL classified as volatile, slippage = 1.0%', () => {
  assertEqual(classifyPair(TOKENS.USDC, TOKENS.VIRTUAL), 'volatile');
  assertEqual(getSlippageForPair(TOKENS.USDC, TOKENS.VIRTUAL), 1.0);
});

test('WETH <-> VIRTUAL classified as volatile, slippage = 1.0%', () => {
  assertEqual(classifyPair(TOKENS.WETH, TOKENS.VIRTUAL), 'volatile');
  assertEqual(getSlippageForPair(TOKENS.WETH, TOKENS.VIRTUAL), 1.0);
});

test('Classification is case-insensitive (lowercase tokenOut)', () => {
  assertEqual(classifyPair(TOKENS.USDC, VIRTUAL_LOWER), 'volatile');
});

test('Classification is case-insensitive at the input boundary', () => {
  // USDC in deliberately mis-cased form should still classify as stable
  // when paired with a stable.
  assertEqual(classifyPair(USDC_MIXED, DAI_BASE), 'stable');
});

test('Classification is symmetric (swap order does not change result)', () => {
  assertEqual(
    classifyPair(TOKENS.WETH, TOKENS.USDC),
    classifyPair(TOKENS.USDC, TOKENS.WETH),
    'lowVol pair should be symmetric'
  );
});

// ---------------------------------------------------------------------------
// Group 2: Deadline validation
// ---------------------------------------------------------------------------

console.log('\nGroup 2: Deadline validation');

test('Missing deadline returns null (not an error)', () => {
  assertEqual(assertQuoteFresh(undefined), null);
  assertEqual(assertQuoteFresh(null), null);
  assertEqual(assertQuoteFresh(''), null);
});

test('Non-numeric deadline returns null', () => {
  assertEqual(assertQuoteFresh({ foo: 1 }), null);
  assertEqual(assertQuoteFresh('not-a-number'), null);
});

test('Deadline far in the future returns positive remaining seconds', () => {
  const now = 1_700_000_000;
  const dl = now + 600;
  const remaining = assertQuoteFresh(dl, now);
  assertEqual(remaining, 600);
});

test('Deadline accepted when given as numeric string', () => {
  const now = 1_700_000_000;
  const remaining = assertQuoteFresh(String(now + 120), now);
  assertEqual(remaining, 120);
});

test('Deadline accepted as bigint', () => {
  const now = 1_700_000_000;
  const remaining = assertQuoteFresh(BigInt(now + 90), now);
  assertEqual(remaining, 90);
});

test('Deadline within buffer window throws', () => {
  const now = 1_700_000_000;
  // 10s remaining < 30s buffer → must throw
  assertThrows(
    () => assertQuoteFresh(now + 10, now),
    /Quote deadline expired or too close: 10s remaining/,
    'should throw inside buffer window'
  );
});

test('Deadline of 0 is treated as expired (does not silently skip)', () => {
  const now = 1_700_000_000;
  assertThrows(
    () => assertQuoteFresh(0, now),
    /-\d+s remaining/,
    'deadline=0 should throw with negative remaining'
  );
});

test('Already-expired deadline throws with negative remaining', () => {
  const now = 1_700_000_000;
  assertThrows(
    () => assertQuoteFresh(now - 5, now),
    /-\d+s remaining/,
    'expired deadline'
  );
});

test('Buffer constant matches public contract', () => {
  // Sanity: caller code (uniswap-client.ts) relies on the buffer being >= 30s.
  assert(QUOTE_DEADLINE_BUFFER_SEC >= 30, 'buffer must be >= 30s');
});

// ---------------------------------------------------------------------------
// Group 2b: extractQuoteDeadline — locate the field across response shapes
// ---------------------------------------------------------------------------

console.log('\nGroup 2b: extractQuoteDeadline');

test('extractQuoteDeadline returns null on non-object input', () => {
  assertEqual(extractQuoteDeadline(null), null);
  assertEqual(extractQuoteDeadline('foo'), null);
  assertEqual(extractQuoteDeadline(42), null);
});

test('extractQuoteDeadline reads quote.deadline as seconds', () => {
  const r = { quote: { deadline: 1_700_000_500 } };
  assertEqual(extractQuoteDeadline(r), 1_700_000_500);
});

test('extractQuoteDeadline reads permitData.values.deadline as fallback', () => {
  const r = {
    quote: { amountOut: '1' },
    permitData: { values: { deadline: '1700000777' } },
  };
  assertEqual(extractQuoteDeadline(r), 1_700_000_777);
});

test('extractQuoteDeadline normalises ms to seconds when value > 1e12', () => {
  const r = { quote: { deadline: 1_700_000_500_000 } };
  // Pin nowSec so the result does not depend on system clock when the
  // sanity-window check runs.
  assertEqual(extractQuoteDeadline(r, 1_700_000_000), 1_700_000_500);
});

test('extractQuoteDeadline normalises microseconds back to seconds', () => {
  // 1.7e15 μs / 1000 = 1.7e12 ms / 1000 = 1.7e9 s — must keep dividing.
  const r = { quote: { deadline: 1_700_000_500_000_000 } };
  assertEqual(extractQuoteDeadline(r, 1_700_000_000), 1_700_000_500);
});

test('extractQuoteDeadline rejects implausibly far-future values after normalising', () => {
  // 1e18 (ns-ish) won't normalise into the 7-day window → returns null
  // rather than letting "year 5e10" silently pass the freshness check.
  const r = { quote: { deadline: 1_000_000_000_000_000_000 } };
  assertEqual(extractQuoteDeadline(r, 1_700_000_000), null);
});

test('extractQuoteDeadline survives malformed quote/permitData (non-objects)', () => {
  // Hostile or buggy upstream sends `quote: "string"` or `permitData: 42`.
  // Should not crash; returns null.
  const r1 = { quote: 'oops', permitData: 42 };
  assertEqual(extractQuoteDeadline(r1, 1_700_000_000), null);
  const r2 = { quote: null, permitData: { values: 'oops' } };
  assertEqual(extractQuoteDeadline(r2, 1_700_000_000), null);
});

test('extractQuoteDeadline prefers quote.deadline over permitData when both present', () => {
  const r = {
    quote: { deadline: 1_700_000_001 },
    permitData: { values: { deadline: 1_700_000_999 } },
  };
  assertEqual(extractQuoteDeadline(r), 1_700_000_001);
});

test('extractQuoteDeadline returns null when both fields missing', () => {
  const r = { quote: {}, permitData: { values: {} } };
  assertEqual(extractQuoteDeadline(r), null);
});

// ---------------------------------------------------------------------------
// Group 3: Gas cap
// ---------------------------------------------------------------------------

console.log('\nGroup 3: Gas cap');

test('Default threshold is 0.001 ETH (1e15 wei)', () => {
  assertEqual(DEFAULT_GAS_ABORT_WEI, 1_000_000_000_000_000n);
});

test('Absolute gas-limit ceiling is 2,000,000', () => {
  assertEqual(ABSOLUTE_GAS_LIMIT_CEILING, 2_000_000n);
});

test('getGasAbortThresholdWei returns default when env unset', () => {
  const saved = process.env.GAS_ABORT_THRESHOLD_WEI;
  delete process.env.GAS_ABORT_THRESHOLD_WEI;
  try {
    assertEqual(getGasAbortThresholdWei(), DEFAULT_GAS_ABORT_WEI);
  } finally {
    if (saved !== undefined) process.env.GAS_ABORT_THRESHOLD_WEI = saved;
  }
});

test('getGasAbortThresholdWei honors valid env override', () => {
  const saved = process.env.GAS_ABORT_THRESHOLD_WEI;
  process.env.GAS_ABORT_THRESHOLD_WEI = '500000000000000'; // 0.0005 ETH
  try {
    assertEqual(getGasAbortThresholdWei(), 500_000_000_000_000n);
  } finally {
    if (saved !== undefined) process.env.GAS_ABORT_THRESHOLD_WEI = saved;
    else delete process.env.GAS_ABORT_THRESHOLD_WEI;
  }
});

test('getGasAbortThresholdWei falls back on garbage env value', () => {
  const saved = process.env.GAS_ABORT_THRESHOLD_WEI;
  process.env.GAS_ABORT_THRESHOLD_WEI = 'not-a-number';
  try {
    assertEqual(getGasAbortThresholdWei(), DEFAULT_GAS_ABORT_WEI);
  } finally {
    if (saved !== undefined) process.env.GAS_ABORT_THRESHOLD_WEI = saved;
    else delete process.env.GAS_ABORT_THRESHOLD_WEI;
  }
});

test('getGasAbortThresholdWei falls back on zero/negative env value', () => {
  const saved = process.env.GAS_ABORT_THRESHOLD_WEI;
  process.env.GAS_ABORT_THRESHOLD_WEI = '0';
  try {
    assertEqual(getGasAbortThresholdWei(), DEFAULT_GAS_ABORT_WEI);
  } finally {
    if (saved !== undefined) process.env.GAS_ABORT_THRESHOLD_WEI = saved;
    else delete process.env.GAS_ABORT_THRESHOLD_WEI;
  }
});

test('assertGasCostBelowThreshold passes for typical Base swap (~0.00005 ETH)', () => {
  // 200k gas @ 0.25 gwei = 5e13 wei = 0.00005 ETH — typical Base swap cost.
  const cost = assertGasCostBelowThreshold(200_000n, 250_000_000n, DEFAULT_GAS_ABORT_WEI);
  assertEqual(cost, 50_000_000_000_000n);
});

test('assertGasCostBelowThreshold throws when cost exceeds threshold', () => {
  // 1M gas @ 5 gwei = 5e15 wei = 0.005 ETH — over default 0.001 ETH cap.
  assertThrows(
    () => assertGasCostBelowThreshold(1_000_000n, 5_000_000_000n, DEFAULT_GAS_ABORT_WEI),
    /Gas cost .* exceeds abort threshold/,
    'over-cap should throw'
  );
});

test('assertGasCostBelowThreshold rejects non-positive gas inputs', () => {
  assertThrows(
    () => assertGasCostBelowThreshold(0n, 1n, DEFAULT_GAS_ABORT_WEI),
    /Gas limit must be positive/,
    'zero limit'
  );
  assertThrows(
    () => assertGasCostBelowThreshold(1n, 0n, DEFAULT_GAS_ABORT_WEI),
    /Gas price must be positive/,
    'zero price'
  );
});

test('assertGasCostBelowThreshold honors explicit threshold parameter', () => {
  // Cost = 100, custom threshold = 50 → should throw.
  assertThrows(
    () => assertGasCostBelowThreshold(10n, 10n, 50n),
    /exceeds abort threshold 50 wei/,
    'explicit threshold should win over env'
  );
});

// ---------------------------------------------------------------------------
// Group 3b: selectGasLimit — defends against malicious /v1/swap hint
// ---------------------------------------------------------------------------

console.log('\nGroup 3b: selectGasLimit');

test('selectGasLimit returns local estimate when no hint provided', () => {
  assertEqual(selectGasLimit(200_000n, null), 200_000n);
});

test('selectGasLimit takes max(local, hint) when hint is higher', () => {
  assertEqual(selectGasLimit(200_000n, 250_000n), 250_000n);
});

test('selectGasLimit ignores under-spec hint (cannot be used to lower limit)', () => {
  // Malicious hint of 1 must NOT shrink the broadcast gas limit.
  assertEqual(selectGasLimit(200_000n, 1n), 200_000n);
});

test('selectGasLimit caps result at absolute ceiling', () => {
  // Hint above ceiling → result is the ceiling, not the hint.
  assertEqual(
    selectGasLimit(200_000n, 5_000_000n),
    ABSOLUTE_GAS_LIMIT_CEILING
  );
});

test('selectGasLimit throws when local estimate alone exceeds ceiling', () => {
  assertThrows(
    () => selectGasLimit(ABSOLUTE_GAS_LIMIT_CEILING + 1n, null),
    /exceeds absolute ceiling/,
    'over-ceiling local estimate'
  );
});

test('selectGasLimit rejects non-positive local estimate', () => {
  assertThrows(
    () => selectGasLimit(0n, null),
    /Local gas estimate must be positive/,
    'zero local estimate'
  );
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n=== Edge-cases results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
