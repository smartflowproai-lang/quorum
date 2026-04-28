// treasurer.test.ts — type-safety + interface contract tests
//
// Purpose: validate that TypeScript types are correct and that the Treasurer
// class accepts / rejects the right shapes at compile time.
// These are NOT integration tests — no real RPC calls, no real swaps.
// Integration tests (real Base mainnet swaps) are Day 7-8 work.
//
// Run: npx ts-node treasurer.test.ts

import {
  Treasurer,
  BASE_CHAIN_ID,
  TOKENS,
  type Address,
  type TokenBalance,
  type RebalancePlan,
  type X402Challenge,
  type PaymentReceipt,
  type TxReceipt,
} from './index';
import { UniswapClient, type QuoteRequest, type QuoteResponse } from './uniswap-client';
import { X402Handler } from './x402-handler';

// ---------------------------------------------------------------------------
// Test runner — minimal, no external test framework dependency
// ---------------------------------------------------------------------------

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(`${message ?? 'assertEqual'}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

console.log('\n=== Treasurer Agent — Type Contract Tests ===\n');

// ---------------------------------------------------------------------------
// Test group 1: Type shapes compile and satisfy their interfaces
// ---------------------------------------------------------------------------

console.log('Group 1: Type shapes');

test('Address type accepts valid 0x-prefixed hex', () => {
  const addr: Address = '0xd779cE46567d21b9918F24f0640cA5Ad6058C893';
  assert(addr.startsWith('0x'), 'Address must start with 0x');
  assert(addr.length === 42, 'Address must be 42 chars');
});

test('TokenBalance shape matches interface', () => {
  const balance: TokenBalance = {
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    symbol: 'USDC',
    decimals: 6,
    rawAmount: '10000000',
    formattedAmount: '10.0',
    usdValue: 10.0,
  };
  assertEqual(balance.symbol, 'USDC');
  assertEqual(balance.decimals, 6);
  assert(typeof balance.usdValue === 'number', 'usdValue should be a number');
});

test('RebalancePlan shape matches interface', () => {
  const plan: RebalancePlan = {
    fromAddress: '0xAAAA000000000000000000000000000000000001' as Address,
    toAddress:   '0xBBBB000000000000000000000000000000000002' as Address,
    tokenIn:  TOKENS.WETH,
    tokenOut: TOKENS.USDC,
    amountIn: '1000000000000000000', // 1 WETH in wei
    reason: 'gas-low: scout agent needs ETH',
  };
  assert(plan.amountIn.length > 0, 'amountIn must not be empty');
  assert(plan.reason.length > 0, 'reason must not be empty');
});

test('X402Challenge shape matches interface', () => {
  const challenge: X402Challenge = {
    url: 'https://api.smartflowproai.com/v1/decision',
    amount: '1000000', // 1 USDC (6 decimals)
    tokenAddress: TOKENS.USDC,
    chainId: BASE_CHAIN_ID,
    payTo: '0xFacilitat0r0000000000000000000000000000' as Address,
    rawHeader: 'x402 amount=1000000 token=0x833...',
  };
  assertEqual(challenge.chainId, 8453, 'chainId must be Base mainnet = 8453');
  assert(challenge.url.startsWith('https://'), 'url must be HTTPS');
});

test('TxReceipt status is a union type', () => {
  const pending: TxReceipt = {
    txHash: '0x' + '0'.repeat(64) as `0x${string}`,
    status: 'pending',
    timestamp: new Date().toISOString(),
  };
  const success: TxReceipt = { ...pending, status: 'success', blockNumber: BigInt(12345678) };
  const reverted: TxReceipt = { ...pending, status: 'reverted' };

  assert(pending.status === 'pending', 'pending status');
  assert(success.status === 'success', 'success status');
  assert(reverted.status === 'reverted', 'reverted status');
  assert(success.blockNumber === BigInt(12345678), 'blockNumber as bigint');
});

test('PaymentReceipt shape matches interface', () => {
  const receipt: PaymentReceipt = {
    swapTxHash: '0x' + 'a'.repeat(64) as `0x${string}`,
    settleTxHash: '0x' + 'b'.repeat(64) as `0x${string}`,
    paidTokenAddress: TOKENS.USDC,
    paidAmount: '1000000',
    requestedTokenAddress: TOKENS.USDC,
    timestamp: new Date().toISOString(),
  };
  assert(receipt.settleTxHash.length === 66, 'settleTxHash must be 66 chars (0x + 64)');
});

// ---------------------------------------------------------------------------
// Test group 2: Constants are correct
// ---------------------------------------------------------------------------

console.log('\nGroup 2: Constants');

test('BASE_CHAIN_ID is 8453', () => {
  // Critical per research §3.10: "Base chain ID = 8453 (easy to fumble)"
  // Base Sepolia = 84532 — DO NOT use that
  assertEqual(BASE_CHAIN_ID, 8453, 'BASE_CHAIN_ID');
});

test('TOKENS.USDC has correct Base mainnet address', () => {
  // From uniswap research §3.5 hello world example
  assertEqual(TOKENS.USDC, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
});

test('TOKENS.WETH has correct Base mainnet address', () => {
  // From uniswap research §3.5 hello world example
  assertEqual(TOKENS.WETH, '0x4200000000000000000000000000000000000006');
});

// ---------------------------------------------------------------------------
// Test group 3: Class instantiation (no RPC calls)
// ---------------------------------------------------------------------------

console.log('\nGroup 3: Class instantiation');

test('UniswapClient instantiates without API key (warns, does not throw)', () => {
  // Save and clear env
  const saved = process.env.UNISWAP_API_KEY;
  delete process.env.UNISWAP_API_KEY;

  let threw = false;
  try {
    new UniswapClient();
  } catch {
    threw = true;
  } finally {
    if (saved !== undefined) process.env.UNISWAP_API_KEY = saved;
  }

  assert(!threw, 'UniswapClient constructor should warn, not throw, when API key is missing');
});

test('X402Handler instantiates with valid inputs', () => {
  const uniswap = new UniswapClient();
  const handler = new X402Handler(uniswap, '0x' + 'a'.repeat(64) as `0x${string}`);
  assert(handler instanceof X402Handler, 'X402Handler should instantiate');
});

test('Treasurer instantiates with a private key', () => {
  const treasurer = new Treasurer('0x' + 'f'.repeat(64) as `0x${string}`);
  assert(treasurer instanceof Treasurer, 'Treasurer should instantiate');
});

test('Treasurer.getBalances() returns empty Map for empty WATCHED_ADDRESSES', async () => {
  const saved = process.env.WATCHED_ADDRESSES;
  process.env.WATCHED_ADDRESSES = '';

  const treasurer = new Treasurer('0x' + 'f'.repeat(64) as `0x${string}`);
  const balances = await treasurer.getBalances();

  if (saved !== undefined) process.env.WATCHED_ADDRESSES = saved;
  else delete process.env.WATCHED_ADDRESSES;

  assert(balances instanceof Map, 'getBalances should return a Map');
  assertEqual(balances.size, 0, 'Empty WATCHED_ADDRESSES → empty Map');
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
