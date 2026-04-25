// agents/scout/linkToEVM.test.ts — unit tests for EVM cross-chain resolution
// Run with: npx ts-node linkToEVM.test.ts  (or `npm test` after package.json update)
//
// Deliberately uses no test framework — Node's built-in assert + a tiny harness.
// This keeps CI dependency surface minimal and lets judges run tests without
// installing extra packages.

import assert from 'assert';
import { linkToEVM, linkToEVMBatch, isRisky, EvmMapping } from './linkToEVM';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Suite: linkToEVM
// ---------------------------------------------------------------------------

console.log('\nlinkToEVM — unit tests\n');

test('returns unresolved for unknown pubkey', () => {
  const result = linkToEVM('unknownPubkeyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
  assert.strictEqual(result.confidence, 'unresolved');
  assert.strictEqual(result.evmAddress, null);
  assert.strictEqual(result.solanaPubkey, 'unknownPubkeyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
});

test('unresolved mapping is not risky', () => {
  const result = linkToEVM('unknownPubkeyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
  assert.strictEqual(isRisky(result), false);
});

test('linkToEVM always returns EvmMapping shape', () => {
  const result = linkToEVM('11111111111111111111111111111111');
  assert.ok('solanaPubkey' in result, 'missing solanaPubkey');
  assert.ok('evmAddress' in result, 'missing evmAddress');
  assert.ok('confidence' in result, 'missing confidence');
});

test('linkToEVMBatch returns Map with same size as input', () => {
  const pubkeys = [
    '11111111111111111111111111111111',
    '22222222222222222222222222222222',
    '33333333333333333333333333333333',
  ];
  const result = linkToEVMBatch(pubkeys);
  assert.strictEqual(result.size, pubkeys.length);
});

test('linkToEVMBatch maps each key to an EvmMapping', () => {
  const pubkeys = ['AAA111', 'BBB222'];
  const result = linkToEVMBatch(pubkeys);
  for (const pk of pubkeys) {
    const m = result.get(pk);
    assert.ok(m !== undefined, `missing entry for ${pk}`);
    assert.strictEqual(m!.solanaPubkey, pk);
  }
});

test('isRisky returns false when riskReason is undefined', () => {
  const noRisk: EvmMapping = {
    solanaPubkey: 'ABC',
    evmAddress: '0xdeadbeef',
    confidence: 'seed',
  };
  assert.strictEqual(isRisky(noRisk), false);
});

test('isRisky returns true when riskReason is set', () => {
  const withRisk: EvmMapping = {
    solanaPubkey: 'ABC',
    evmAddress: '0xdeadbeef',
    confidence: 'seed',
    riskReason: 'known-rug-deployer',
  };
  assert.strictEqual(isRisky(withRisk), true);
});

test('isRisky returns false for empty riskReason string', () => {
  const emptyRisk: EvmMapping = {
    solanaPubkey: 'ABC',
    evmAddress: null,
    confidence: 'unresolved',
    riskReason: '',
  };
  assert.strictEqual(isRisky(emptyRisk), false);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
