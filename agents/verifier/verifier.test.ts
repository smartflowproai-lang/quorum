// VERIFIER agent — test suite (node:test)
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'os';

import { validateVerdict, type OnChainProbe, type ProbeReceipt } from './validator';
import {
  buildAttestationId,
  issueAttestation,
  appendJsonl,
  assertSafeLogPath,
} from './attestation';
import {
  handleMessage,
  pollLoop,
  _resetDedupeForTests,
  _resetRateForTests,
} from './index';
import type { AxlEnvelope } from '../../shared/axl-wrap';
import { MAX_PAYLOAD_BYTES } from './types';
import type {
  JudgeVerdict,
  ValidationResult,
  AttestationPayload,
} from './types';
import { JudgeVerdictSchema, MAX_REASONING_BYTES } from './types';

// Tests must opt in to the allow-listed test prefix so attestation.assertSafeLogPath
// accepts the path. See ALLOWED_LOG_ROOTS in attestation.ts.
const TEST_ROOT = path.join(os.tmpdir(), 'quorum-verifier-test', `pid-${process.pid}-${Date.now()}`);
const LOG = path.join(TEST_ROOT, 'attest.jsonl');

function makeVerdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    agent: 'judge',
    verdict: 'AVOID',
    score: 0.85,
    reasoning: 'cluster overlap with known farmer',
    tokenAddress: '0x' + 'a'.repeat(40),
    chainId: 8453,
    emittedAt: 1700_000_000_000,
    ...overrides,
  };
}

const VALID_TX_HASH = ('0x' + 'b'.repeat(64)) as `0x${string}`;

function makeProbe(receipt: ProbeReceipt | null, chainId = 8453): OnChainProbe {
  return {
    chainId,
    async getTransactionReceipt() {
      return receipt;
    },
  };
}

// ---------------------------------------------------------------------------
// Schema (zod) parsing — boundary defense
// ---------------------------------------------------------------------------

test('JudgeVerdictSchema: accepts well-formed verdict', () => {
  const r = JudgeVerdictSchema.safeParse(makeVerdict());
  assert.equal(r.success, true);
});

test('JudgeVerdictSchema: rejects extra keys (strict mode)', () => {
  const r = JudgeVerdictSchema.safeParse({ ...makeVerdict(), evil: 'payload' });
  assert.equal(r.success, false);
});

test('JudgeVerdictSchema: rejects oversized reasoning', () => {
  const r = JudgeVerdictSchema.safeParse(
    makeVerdict({ reasoning: 'x'.repeat(MAX_REASONING_BYTES + 1) })
  );
  assert.equal(r.success, false);
});

test('JudgeVerdictSchema: rejects prototype pollution attempts', () => {
  const r = JudgeVerdictSchema.safeParse(
    JSON.parse('{"__proto__":{"polluted":1},"agent":"judge"}')
  );
  assert.equal(r.success, false);
});

// ---------------------------------------------------------------------------
// validateVerdict — shape checks (defense in depth)
// ---------------------------------------------------------------------------

test('validateVerdict: well-formed verdict passes', async () => {
  const r = await validateVerdict(makeVerdict());
  assert.equal(r.valid, true);
  assert.deepEqual(r.failures, []);
});

test('validateVerdict: re-asserts schema and rejects invalid score', async () => {
  const r = await validateVerdict(makeVerdict({ score: 99 } as Partial<JudgeVerdict>) as JudgeVerdict);
  assert.equal(r.valid, false);
  assert.ok(r.failures.length > 0);
});

test('validateVerdict: tx hash absent passes shape', async () => {
  const r = await validateVerdict(makeVerdict());
  assert.equal(r.valid, true);
  assert.equal(r.evidence.txExists, undefined);
});

test('validateVerdict: requireOnChain without txHash fails (HIGH #5 fix)', async () => {
  const r = await validateVerdict(makeVerdict(), { requireOnChain: true });
  assert.equal(r.valid, false);
  assert.ok(
    r.failures.some((f) => f.includes('on-chain probe required')),
    `failures: ${r.failures.join(' | ')}`
  );
});

test('validateVerdict: requireOnChain with txHash but no probe fails', async () => {
  const r = await validateVerdict(makeVerdict({ txHash: VALID_TX_HASH }), {
    requireOnChain: true,
  });
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => f.includes('no probe configured')));
});

// ---------------------------------------------------------------------------
// validateVerdict — chain binding + on-chain probe
// ---------------------------------------------------------------------------

test('validateVerdict: probe with mismatched chainId is refused (HIGH #2)', async () => {
  const probe = makeProbe(
    { blockNumber: 1n, blockHash: '0x', status: 'success', logs: [{ address: '0x' + 'a'.repeat(40) }] },
    1
  );
  const r = await validateVerdict(makeVerdict({ chainId: 8453, txHash: VALID_TX_HASH }), { probe });
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => f.includes('probe chainId 1 does not match')));
});

test('validateVerdict: probe success + matching token log passes', async () => {
  const probe = makeProbe({
    blockNumber: 42n,
    blockHash: '0xdead',
    status: 'success',
    logs: [{ address: '0x' + 'a'.repeat(40) }],
  });
  const r = await validateVerdict(makeVerdict({ txHash: VALID_TX_HASH }), { probe });
  assert.equal(r.valid, true);
  assert.equal(r.evidence.tokenLogPresent, true);
  assert.equal(r.evidence.txStatus, 'success');
  assert.equal(r.evidence.blockNumber, 42n);
});

test('validateVerdict: probe success but token NOT in logs fails (HIGH #2)', async () => {
  const probe = makeProbe({
    blockNumber: 42n,
    blockHash: '0xdead',
    status: 'success',
    logs: [{ address: '0x' + 'f'.repeat(40) }], // unrelated
  });
  const r = await validateVerdict(makeVerdict({ txHash: VALID_TX_HASH }), { probe });
  assert.equal(r.valid, false);
  assert.equal(r.evidence.tokenLogPresent, false);
  assert.ok(r.failures.some((f) => f.includes('does not touch the verdict tokenAddress')));
});

test('validateVerdict: probe returns null → tx not found', async () => {
  const probe = makeProbe(null);
  const r = await validateVerdict(makeVerdict({ txHash: VALID_TX_HASH }), { probe });
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => f.includes('tx not found')));
  assert.equal(r.evidence.txExists, false);
});

test('validateVerdict: probe returns reverted → failure', async () => {
  const probe = makeProbe({
    blockNumber: 1n,
    blockHash: '0xa',
    status: 'reverted',
    logs: [{ address: '0x' + 'a'.repeat(40) }],
  });
  const r = await validateVerdict(makeVerdict({ txHash: VALID_TX_HASH }), { probe });
  assert.equal(r.valid, false);
  assert.ok(r.failures.some((f) => f.includes('tx reverted')));
});

test('validateVerdict: probe error returns generic message — no secret leak (MED #7)', async () => {
  const probe: OnChainProbe = {
    chainId: 8453,
    async getTransactionReceipt() {
      throw new Error('https://mainnet.helius-rpc.com/?api-key=SECRET-LEAKED');
    },
  };
  const r = await validateVerdict(makeVerdict({ txHash: VALID_TX_HASH }), { probe });
  assert.equal(r.valid, false);
  for (const f of r.failures) {
    assert.ok(!f.includes('SECRET-LEAKED'), `secret leaked into failure: ${f}`);
    assert.ok(!f.includes('api-key'), `key marker leaked: ${f}`);
  }
});

// ---------------------------------------------------------------------------
// buildAttestationId
// ---------------------------------------------------------------------------

test('buildAttestationId: deterministic + format', () => {
  const v: ValidationResult = {
    valid: true,
    failures: [],
    evidence: { observedAt: 1 },
    validatedAt: 2,
  };
  const id = buildAttestationId(makeVerdict(), v);
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.equal(id, buildAttestationId(makeVerdict(), v));
});

test('buildAttestationId: ignores volatile timestamps', () => {
  const verdict = makeVerdict();
  const v1: ValidationResult = { valid: true, failures: [], evidence: { observedAt: 1 }, validatedAt: 2 };
  const v2: ValidationResult = { valid: true, failures: [], evidence: { observedAt: 999 }, validatedAt: 888 };
  assert.equal(buildAttestationId(verdict, v1), buildAttestationId(verdict, v2));
});

test('buildAttestationId: differs by validation outcome', () => {
  const verdict = makeVerdict();
  const v1: ValidationResult = { valid: true, failures: [], evidence: { observedAt: 1 }, validatedAt: 2 };
  const v2: ValidationResult = { valid: false, failures: ['x'], evidence: { observedAt: 1 }, validatedAt: 2 };
  assert.notEqual(buildAttestationId(verdict, v1), buildAttestationId(verdict, v2));
});

// ---------------------------------------------------------------------------
// assertSafeLogPath
// ---------------------------------------------------------------------------

test('assertSafeLogPath: refuses paths outside allow-list (HIGH #1)', () => {
  assert.throws(() => assertSafeLogPath('/etc/passwd'));
  assert.throws(() => assertSafeLogPath('/tmp/random.log'));
});

test('assertSafeLogPath: accepts paths under quorum-verifier-test prefix', () => {
  const ok = assertSafeLogPath(LOG);
  assert.ok(ok.includes('quorum-verifier-test'));
});

test('assertSafeLogPath: refuses path traversal sequences', () => {
  assert.throws(() => assertSafeLogPath('/var/lib/quorum/../../etc/passwd'));
});

test('assertSafeLogPath: refuses nul bytes', () => {
  assert.throws(() => assertSafeLogPath(`/var/lib/quorum/foo\0bar`));
});

// ---------------------------------------------------------------------------
// issueAttestation + appendJsonl
// ---------------------------------------------------------------------------

test('issueAttestation: appends payload to JSONL', async () => {
  const verdict = makeVerdict();
  const validation = await validateVerdict(verdict);
  const att = await issueAttestation(verdict, validation, { logPath: LOG });
  const content = await fs.readFile(LOG, 'utf8');
  const last = JSON.parse(content.trim().split('\n').pop()!);
  assert.equal(last.attestationId, att.attestationId);
  assert.equal(last.verifier, 'verifier');
});

test('issueAttestation: respects custom verifierId', async () => {
  const verdict = makeVerdict();
  const validation = await validateVerdict(verdict);
  const att = await issueAttestation(verdict, validation, {
    logPath: LOG,
    verifierId: 'verifier-fra-01',
  });
  assert.equal(att.verifier, 'verifier-fra-01');
});

test('issueAttestation: handles bigint evidence in JSONL', async () => {
  const verdict = makeVerdict({ txHash: VALID_TX_HASH });
  const probe = makeProbe({
    blockNumber: 12345n,
    blockHash: '0xfeed',
    status: 'success',
    logs: [{ address: '0x' + 'a'.repeat(40) }],
  });
  const validation = await validateVerdict(verdict, { probe });
  const att = await issueAttestation(verdict, validation, { logPath: LOG });
  assert.match(att.attestationId, /^0x[0-9a-f]{64}$/);
});

test('issueAttestation: refuses to write to disallowed path (HIGH #1)', async () => {
  await assert.rejects(
    issueAttestation(makeVerdict(), {
      valid: true,
      failures: [],
      evidence: { observedAt: 0 },
      validatedAt: 0,
    }, { logPath: '/etc/quorum-evil.jsonl' })
  );
});

test('appendJsonl: serialized writes do not interleave (MED #6)', async () => {
  const concurrent = path.join(TEST_ROOT, 'concurrent.jsonl');
  const N = 50;
  const payload = (i: number): AttestationPayload => ({
    verifier: 'v',
    verdict: makeVerdict({ reasoning: `r${i}` }),
    validation: { valid: true, failures: [], evidence: { observedAt: 0 }, validatedAt: 0 },
    attestationId: '0x' + i.toString(16).padStart(64, '0'),
    emittedAt: 0,
  });
  await Promise.all(Array.from({ length: N }, (_, i) => appendJsonl(concurrent, payload(i))));
  const content = await fs.readFile(concurrent, 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, N);
  // Every line must parse as JSON — torn writes would break this.
  for (const line of lines) JSON.parse(line);
});

test('appendJsonl: refuses to follow a symlink at final path (HIGH #1)', async () => {
  const real = path.join(TEST_ROOT, 'real-target.jsonl');
  const link = path.join(TEST_ROOT, 'symlinked.jsonl');
  await fs.mkdir(TEST_ROOT, { recursive: true });
  await fs.writeFile(real, '');
  await fs.symlink(real, link);
  await assert.rejects(
    appendJsonl(link, {
      verifier: 'v',
      verdict: makeVerdict(),
      validation: { valid: true, failures: [], evidence: { observedAt: 0 }, validatedAt: 0 },
      attestationId: '0xdead',
      emittedAt: 0,
    }),
    /symlink/
  );
});

// ---------------------------------------------------------------------------
// handleMessage — boundary defenses
// ---------------------------------------------------------------------------

test('handleMessage: valid verdict → attest target', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: Array<{ peer: string; payload: any }> = [];
  await handleMessage(
    { from: 'judge', to: 'verifier', payload: { kind: 'verdict_request', verdict: makeVerdict() }, ts: Date.now() },
    {
      send: async (peer, payload) => { sent.push({ peer, payload }); },
      attestLogPath: LOG,
    }
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peer, 'executor');
  assert.equal(sent[0].payload.kind, 'attestation');
  assert.match(sent[0].payload.attestation.attestationId, /^0x[0-9a-f]{64}$/);
});

test('handleMessage: invalid verdict → reprobe_request with clamped failures', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: Array<{ peer: string; payload: any }> = [];
  // Pass a payload whose schema parses but whose chain is unsupported — we route
  // through reprobe path. Use a verdict that schema-passes but probes will mark
  // invalid: chainId 1 + probe binding 8453.
  const verdict = makeVerdict({ chainId: 1, txHash: VALID_TX_HASH });
  const probe = makeProbe(
    { blockNumber: 1n, blockHash: '0x', status: 'success', logs: [{ address: '0x' + 'a'.repeat(40) }] },
    8453
  );
  await handleMessage(
    { from: 'judge', to: 'verifier', payload: { kind: 'verdict_request', verdict }, ts: Date.now() },
    { send: async (peer, payload) => { sent.push({ peer, payload }); }, attestLogPath: LOG, probe }
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peer, 'judge');
  assert.equal(sent[0].payload.kind, 'reprobe_request');
  assert.ok(Array.isArray(sent[0].payload.failures));
  for (const f of sent[0].payload.failures) {
    assert.ok(f.length <= 201, `failure too long: ${f.length}`);
  }
});

test('handleMessage: reprobe_request → reprobe_response back to sender', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: Array<{ peer: string; payload: any }> = [];
  await handleMessage(
    { from: 'executor', to: 'verifier', payload: { kind: 'reprobe_request', verdict: makeVerdict() }, ts: Date.now() },
    { send: async (peer, payload) => { sent.push({ peer, payload }); }, attestLogPath: LOG }
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peer, 'executor');
  assert.equal(sent[0].payload.kind, 'reprobe_response');
});

test('handleMessage: malformed payload is dropped silently', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: any[] = [];
  await handleMessage(
    { from: 'judge', to: 'verifier', payload: { kind: 'noise' }, ts: Date.now() },
    { send: async (p, q) => { sent.push({ p, q }); } }
  );
  assert.equal(sent.length, 0);
});

test('handleMessage: oversized payload is dropped (HIGH #3)', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: any[] = [];
  const huge = { kind: 'verdict_request', verdict: makeVerdict({ reasoning: 'x'.repeat(20_000) }) };
  await handleMessage(
    { from: 'judge', to: 'verifier', payload: huge, ts: Date.now() },
    { send: async (p, q) => { sent.push({ p, q }); } }
  );
  assert.equal(sent.length, 0);
});

test('handleMessage: stale message is dropped (HIGH #4 — replay)', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: any[] = [];
  await handleMessage(
    {
      from: 'judge',
      to: 'verifier',
      payload: { kind: 'verdict_request', verdict: makeVerdict() },
      ts: Date.now() - 5 * 60_000, // 5 min old, well outside 60s window
    },
    { send: async (p, q) => { sent.push({ p, q }); }, now: () => Date.now(), attestLogPath: LOG }
  );
  assert.equal(sent.length, 0);
});

test('handleMessage: duplicate attestation is suppressed (HIGH #4 — amplification)', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: any[] = [];
  const verdict = makeVerdict();
  const ts = Date.now();
  await handleMessage(
    { from: 'judge', to: 'verifier', payload: { kind: 'verdict_request', verdict }, ts },
    { send: async (p, q) => { sent.push({ p, q }); }, attestLogPath: LOG }
  );
  await handleMessage(
    { from: 'judge', to: 'verifier', payload: { kind: 'verdict_request', verdict }, ts: ts + 100 },
    { send: async (p, q) => { sent.push({ p, q }); }, attestLogPath: LOG }
  );
  assert.equal(sent.length, 1);
});

test('handleMessage: missing ts is dropped (round-2 MED — replay bypass)', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: any[] = [];
  await handleMessage(
    {
      from: 'judge',
      to: 'verifier',
      payload: { kind: 'verdict_request', verdict: makeVerdict() },
      ts: undefined as unknown as number,
    },
    { send: async (p, q) => { sent.push({ p, q }); }, attestLogPath: LOG }
  );
  assert.equal(sent.length, 0);
});

test('handleMessage: non-numeric ts is dropped', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: any[] = [];
  await handleMessage(
    {
      from: 'judge',
      to: 'verifier',
      payload: { kind: 'verdict_request', verdict: makeVerdict() },
      ts: 'not-a-number' as unknown as number,
    },
    { send: async (p, q) => { sent.push({ p, q }); }, attestLogPath: LOG }
  );
  assert.equal(sent.length, 0);
});

test('handleMessage: rate limit drops floods from same peer (HIGH #4 — DoS)', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  // Set a tiny rate limit via env override is process-wide and risky for parallel tests;
  // instead we pre-fill the rate window by sending many messages and expect later ones to drop.
  const sent: any[] = [];
  const ts = Date.now();
  const verdict = makeVerdict();
  // Send 70 messages; default rate limit is 60/min → at least 10 should drop.
  for (let i = 0; i < 70; i++) {
    await handleMessage(
      {
        from: 'spammer',
        to: 'verifier',
        payload: { kind: 'verdict_request', verdict: { ...verdict, emittedAt: verdict.emittedAt + i } },
        ts: ts + i,
      },
      { send: async (p, q) => { sent.push({ p, q }); }, attestLogPath: LOG }
    );
  }
  // First-time attestations are deduped per identical evidence, so most will dedupe;
  // the rate limit ALSO drops some. Assert that we did not send 70 outgoing messages
  // (i.e. a peer cannot 1:1 amplify).
  assert.ok(sent.length < 70, `expected fanout to be capped, got ${sent.length}`);
});

// ---------------------------------------------------------------------------
// pollLoop — drain pattern + boundary defenses (bug_005 + merged_bug_007)
// ---------------------------------------------------------------------------

function makeEnvelope(verdict: JudgeVerdict, from = 'judge'): AxlEnvelope {
  return {
    from,
    data: JSON.stringify({ kind: 'verdict_request', verdict }),
    ts: Date.now(),
  };
}

test('pollLoop: drains all envelopes per poll (bug_005 — no message loss in bursts)', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: Array<{ peer: string; payload: unknown }> = [];
  const verdictA = makeVerdict({ tokenAddress: ('0x' + 'a'.repeat(40)) as `0x${string}` });
  const verdictB = makeVerdict({ tokenAddress: ('0x' + 'b'.repeat(40)) as `0x${string}` });
  const verdictC = makeVerdict({ tokenAddress: ('0x' + 'c'.repeat(40)) as `0x${string}` });
  // 3 envelopes returned in a single poll — single-shot axlReceive() would lose
  // the 2nd and 3rd. drain pattern must process all three.
  const batch = [makeEnvelope(verdictA), makeEnvelope(verdictB), makeEnvelope(verdictC)];
  let pollCount = 0;
  await pollLoop(
    {
      send: async (peer, payload) => { sent.push({ peer, payload }); },
      probe: makeProbe({ blockNumber: 100n, status: 'success', logs: [{ address: verdictA.tokenAddress, topics: [], data: '0x' }] }),
      attestLogPath: LOG,
      recv: async () => {
        pollCount++;
        return pollCount === 1 ? batch : [];
      },
    },
    1
  );
  // Each verdict should produce one outbound attestation send (probe matches each).
  // Pre-fix (single-shot axlReceive) would yield <= 1 send. Drain yields 3.
  assert.equal(sent.length, 3, `drain should process all 3 envelopes, got ${sent.length}`);
});

test('pollLoop: oversized envelope dropped before JSON.parse (merged_bug_007 — byte cap)', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: Array<{ peer: string; payload: unknown }> = [];
  // Envelope.data exceeds MAX_PAYLOAD_BYTES — must drop BEFORE parsing.
  const oversized: AxlEnvelope = {
    from: 'judge',
    data: 'x'.repeat(MAX_PAYLOAD_BYTES + 1),
    ts: Date.now(),
  };
  let pollCount = 0;
  await pollLoop(
    {
      send: async (peer, payload) => { sent.push({ peer, payload }); },
      attestLogPath: LOG,
      recv: async () => {
        pollCount++;
        return pollCount === 1 ? [oversized] : [];
      },
    },
    1
  );
  assert.equal(sent.length, 0, 'oversized envelope must be dropped, no send');
});

test('pollLoop: malformed JSON envelope dropped without crash (merged_bug_007 — parse-fail handling)', async () => {
  _resetDedupeForTests();
  _resetRateForTests();
  const sent: Array<{ peer: string; payload: unknown }> = [];
  const malformed: AxlEnvelope = {
    from: 'judge',
    data: '{not valid json',
    ts: Date.now(),
  };
  let pollCount = 0;
  // Should not throw, should not call send.
  await pollLoop(
    {
      send: async (peer, payload) => { sent.push({ peer, payload }); },
      attestLogPath: LOG,
      recv: async () => {
        pollCount++;
        return pollCount === 1 ? [malformed] : [];
      },
    },
    1
  );
  assert.equal(sent.length, 0, 'malformed envelope must drop silently, no send');
});
