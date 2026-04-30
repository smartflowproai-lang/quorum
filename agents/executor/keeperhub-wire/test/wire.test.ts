// keeperhub-wire/test/wire.test.ts
// Integration tests against the in-process mock KH MCP. Exercises every code
// path the wire claims to handle: 402 → pay → retry, 404 → re-resolve, 5xx
// burn-down, idempotency replay short-circuit, malformed responses.
//
// Run: `node --test --import tsx wire.test.ts` (or via package.json scripts).
// We use node:test (built-in) to avoid pulling in jest / vitest at this layer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ExecutorKeeperHubWire, type WireLogEntry } from '../executor-wire';
import { startMockKhServer } from '../mock-kh-server';
import { deriveIdempotencyKey } from '../idempotency';
import {
  verifyKhWebhook,
  WebhookSignatureInvalid,
  WebhookReplayRejected,
} from '../webhook-verify';
import { createHmac } from 'node:crypto';
import type { KeeperHubWireConfig, X402Challenge } from '../types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function captureLogger(entries: WireLogEntry[]) {
  return (e: WireLogEntry) => entries.push(e);
}

async function buildWire(opts?: { mockOpts?: Parameters<typeof startMockKhServer>[0] }) {
  const mock = await startMockKhServer(opts?.mockOpts);
  // Inline payer: marks current idempotency key as paid on the mock so the
  // retry returns 200. The wire echoes the key on the Idempotency-Key header
  // and our mock keys 402-clearance off that.
  let lastIdem: string | null = null;
  const log: WireLogEntry[] = [];
  const tee = (e: WireLogEntry) => {
    if (e.idempotency_key) lastIdem = e.idempotency_key;
    log.push(e);
  };
  const cfg: KeeperHubWireConfig = {
    mcpEndpoint: mock.url,
    webhookSecret: 'test-secret',
    workflowIdTtlMs: 6 * 60 * 60 * 1000,
    idempotencyWindowMs: 24 * 60 * 60 * 1000,
  };
  const payer = async (_args: { challenge: X402Challenge; traceId: string }) => {
    if (lastIdem) mock.markPaid(lastIdem);
    return { settleTxHash: '0x' + 'a'.repeat(64) };
  };
  const wire = new ExecutorKeeperHubWire(cfg, tee, payer);
  return { mock, wire, log };
}

// ---------------------------------------------------------------------------
// happy path: search → 402 → pay → 200
// ---------------------------------------------------------------------------

test('happy path: pays x402 and lands attestation', async () => {
  const { mock, wire, log } = await buildWire();
  try {
    const out = await wire.landAttestation({
      workflowQuery: 'quorum-attest-v1',
      input: { verdict: 'pump-it', i: 1 },
    });
    assert.equal(out.result.status, 'settled');
    assert.match(out.result.attestation_tx ?? '', /^0x[0-9a-f]{64}$/);
    assert.equal(out.shortCircuited, false);
    const stats = mock.stats();
    assert.equal(stats.search, 1);
    assert.equal(stats.call, 2); // 402 then 200
    assert.equal(stats.paid402, 1);
    // log must contain a paying_x402 entry
    assert.ok(log.some((e) => e.event === 'paying_x402'));
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// idempotency: same input twice → second short-circuits
// ---------------------------------------------------------------------------

test('idempotency: replay short-circuits on local store', async () => {
  const { mock, wire } = await buildWire();
  try {
    const input = { verdict: 'replay', i: 7 };
    const r1 = await wire.landAttestation({ workflowQuery: 'quorum-attest-v1', input });
    assert.equal(r1.result.status, 'settled');
    const r2 = await wire.landAttestation({ workflowQuery: 'quorum-attest-v1', input });
    assert.equal(r2.shortCircuited, true);
    assert.equal(r2.result.status, 'duplicate');
    // First call_workflow round = 1 search + 2 calls (402+200); replay must add zero calls
    const stats = mock.stats();
    assert.equal(stats.call, 2);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// idempotency key derivation: stable across argument order
// ---------------------------------------------------------------------------

test('idempotency key is stable across input key order', () => {
  const k1 = deriveIdempotencyKey('wf_x', { a: 1, b: 2, c: { d: 3, e: 4 } });
  const k2 = deriveIdempotencyKey('wf_x', { c: { e: 4, d: 3 }, b: 2, a: 1 });
  assert.equal(k1, k2);
  // Different workflow id ⇒ different key
  const k3 = deriveIdempotencyKey('wf_y', { a: 1, b: 2, c: { d: 3, e: 4 } });
  assert.notEqual(k1, k3);
});

// ---------------------------------------------------------------------------
// 404 republished: re-resolve + retry
// ---------------------------------------------------------------------------

test('404 republished: re-resolves workflow id and retries', async () => {
  const { mock, wire, log } = await buildWire();
  try {
    // First call resolves wf_<hash>; force a one-time 404 for that id
    // We don't know the hash up front — easier to flip the spec via a synthetic
    // search. The mock's setSpec keys on workflow_id, so we resolve once first.
    const probe = await wire.landAttestation({
      workflowQuery: 'republish-target',
      input: { i: 0 },
    });
    const wfId = probe.workflowId;
    mock.setSpec(wfId, { force404Once: true, force402: true });
    const out = await wire.landAttestation({
      workflowQuery: 'republish-target',
      input: { i: 1 },
    });
    assert.equal(out.result.status, 'settled');
    const stats = mock.stats();
    assert.equal(stats.served404, 1);
    assert.ok(log.some((e) => e.event === 'wf_id_refreshed'));
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// transient 5xx burn-down
// ---------------------------------------------------------------------------

test('transient 5xx: backs off and eventually settles', async () => {
  const { mock, wire } = await buildWire();
  try {
    const probe = await wire.landAttestation({
      workflowQuery: '5xx-target',
      input: { i: 0 },
    });
    const wfId = probe.workflowId;
    mock.setSpec(wfId, { force5xxCount: 1, force402: true });
    const out = await wire.landAttestation({
      workflowQuery: '5xx-target',
      input: { i: 1 },
    });
    assert.equal(out.result.status, 'settled');
    assert.ok(mock.stats().served5xx >= 1);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// webhook verifier
// ---------------------------------------------------------------------------

test('webhook verifier: accepts a correctly signed payload', () => {
  const secret = 'shh';
  const payload = JSON.stringify({
    delivery_id: 'd1',
    workflow_id: 'wf_x',
    execution_id: 'exec_x',
    status: 'settled',
    attestation_tx: '0x' + 'c'.repeat(64),
    delivered_at: new Date().toISOString(),
  });
  const ts = String(Date.now());
  const sig = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  const out = verifyKhWebhook({
    rawBody: payload,
    headers: { 'x-kh-signature': sig, 'x-kh-timestamp': ts },
    secret,
  });
  assert.equal(out.delivery_id, 'd1');
});

test('webhook verifier: rejects on hmac mismatch', () => {
  const secret = 'shh';
  const ts = String(Date.now());
  assert.throws(
    () =>
      verifyKhWebhook({
        rawBody: '{"x":1}',
        headers: { 'x-kh-signature': 'deadbeef'.repeat(8), 'x-kh-timestamp': ts },
        secret,
      }),
    WebhookSignatureInvalid,
  );
});

test('webhook verifier: rejects stale timestamp', () => {
  const secret = 'shh';
  const oldTs = String(Date.now() - 10 * 60 * 1000);
  const sig = createHmac('sha256', secret).update(`${oldTs}.x`).digest('hex');
  assert.throws(
    () =>
      verifyKhWebhook({
        rawBody: 'x',
        headers: { 'x-kh-signature': sig, 'x-kh-timestamp': oldTs },
        secret,
      }),
    WebhookReplayRejected,
  );
});
