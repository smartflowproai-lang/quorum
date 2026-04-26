// VERIFIER agent — main loop
//
// Hardening (per hostile review):
//  - zod schema-parses every inbound payload at the boundary (HIGH/MED #9, #3)
//  - hard byte cap on incoming AXL frames (HIGH #3 — DoS via huge payloads)
//  - signature check on AXL envelope when QUORUM_REQUIRE_AXL_SIG=true (HIGH #4)
//  - freshness window on msg.ts (HIGH #4 — replay)
//  - LRU dedupe by (from, attestationId) (HIGH #4 — amplification)
//  - per-peer rate limit (HIGH #4 — DoS via spam)
//  - failure strings echoed to peers are length-clamped (HIGH #3 — log/peer flood)

import { createHash } from 'node:crypto';
import {
  axlSend,
  axlReceive,
  axlVerify,
  type AxlMessage,
} from '../../shared/axl-wrap';
import { validateVerdict, type OnChainProbe } from './validator';
import { issueAttestation } from './attestation';
import {
  MAX_PAYLOAD_BYTES,
  VerifierIncomingSchema,
  type JudgeVerdict,
  type VerifierIncoming,
} from './types';

const AGENT_ID = 'verifier';
const POLL_INTERVAL_MS = Number(process.env.VERIFIER_POLL_INTERVAL_MS ?? 1000);
const ATTEST_TARGET = process.env.AXL_ATTEST_TARGET || 'executor';
const REPROBE_TARGET = process.env.AXL_REPROBE_TARGET || 'judge';
const REQUIRE_SIG = process.env.QUORUM_REQUIRE_AXL_SIG === 'true';
const FRESHNESS_MS = Number(process.env.VERIFIER_FRESHNESS_MS ?? 60_000);
const RATE_LIMIT_PER_PEER_PER_MIN = Number(process.env.VERIFIER_PEER_RATE ?? 60);

// Outbound failure strings are clamped so a hostile peer cannot use us to flood
// downstream peers with attacker-controlled blobs.
const MAX_FAILURE_LEN = 200;
const clampFailures = (fs: string[]): string[] =>
  fs.slice(0, 20).map((f) => (f.length > MAX_FAILURE_LEN ? f.slice(0, MAX_FAILURE_LEN) + '…' : f));

export interface HandlerDeps {
  send?: (peer: string, payload: unknown) => Promise<void>;
  probe?: OnChainProbe;
  attestLogPath?: string;
  // Override clock for tests.
  now?: () => number;
}

// LRU dedupe — bounded Map. Eviction is FIFO via Map's insertion-order semantics.
// We do NOT short-circuit eviction on the first non-expired entry: clock skew
// (NTP step, VM resume) can place newer entries before older ones in iteration
// order. Sweeping the full map is cheap at this size.
const DEDUPE_MAX = 1024;
const DEDUPE_TTL_MS = 5 * 60_000;
const dedupe = new Map<string, number>();
function alreadySeen(key: string, now: number): boolean {
  for (const [k, ts] of dedupe) {
    if (now - ts > DEDUPE_TTL_MS) dedupe.delete(k);
  }
  if (dedupe.has(key)) return true;
  if (dedupe.size >= DEDUPE_MAX) {
    const oldest = dedupe.keys().next().value;
    if (oldest !== undefined) dedupe.delete(oldest);
  }
  dedupe.set(key, now);
  return false;
}
export function _resetDedupeForTests(): void {
  dedupe.clear();
}

// Rate limit — token bucket per peer. O(1) consume, no array shifts. Cap on
// number of distinct peers tracked (prevents OOM from spoofed `from` values).
const RATE_MAX_PEERS = 10_000;
const RATE_BURST = RATE_LIMIT_PER_PEER_PER_MIN; // bucket size
const RATE_REFILL_PER_MS = RATE_LIMIT_PER_PEER_PER_MIN / 60_000;
interface Bucket {
  tokens: number;
  lastRefillAt: number;
}
const buckets = new Map<string, Bucket>();
function rateLimited(from: string, now: number): boolean {
  const b = buckets.get(from);
  if (!b) {
    if (buckets.size >= RATE_MAX_PEERS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(from, { tokens: RATE_BURST - 1, lastRefillAt: now });
    return false;
  }
  // Refill based on elapsed time. Clamp to burst so a long-idle peer cannot
  // accumulate unlimited tokens.
  const elapsed = Math.max(0, now - b.lastRefillAt);
  b.tokens = Math.min(RATE_BURST, b.tokens + elapsed * RATE_REFILL_PER_MS);
  b.lastRefillAt = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  // Refresh insertion order so the FIFO eviction targets cold peers.
  buckets.delete(from);
  buckets.set(from, b);
  return false;
}
function rateRefund(from: string): void {
  const b = buckets.get(from);
  if (b) b.tokens = Math.min(RATE_BURST, b.tokens + 1);
}
export function _resetRateForTests(): void {
  buckets.clear();
}

function payloadByteSize(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseIncoming(payload: unknown): VerifierIncoming | null {
  const result = VerifierIncomingSchema.safeParse(payload);
  return result.success ? result.data : null;
}

// Stable, input-only dedupe key — does not require running validation. Lets us
// suppress duplicates BEFORE consuming rate-limit tokens (legit retries don't
// burn quota).
function inputDedupeKey(from: string, verdict: JudgeVerdict): string {
  const canon = JSON.stringify({
    v: verdict.verdict,
    s: verdict.score,
    t: verdict.tokenAddress.toLowerCase(),
    c: verdict.chainId,
    h: verdict.txHash ?? null,
    e: verdict.emittedAt,
  });
  return from + ':' + createHash('sha256').update(canon).digest('hex');
}

export async function handleMessage(
  msg: AxlMessage,
  deps: HandlerDeps = {}
): Promise<void> {
  const send = deps.send || axlSend;
  const now = (deps.now || Date.now)();

  // Size cap — reject oversized frames before any further parsing.
  if (payloadByteSize(msg.payload) > MAX_PAYLOAD_BYTES) {
    console.warn(`[${AGENT_ID}] dropping oversized message from ${msg.from}`);
    return;
  }

  // Freshness — reject messages without a numeric ts (fail closed) or outside
  // the freshness window. Without this, an attacker who omits ts bypasses the
  // gate and replay protection collapses to dedupe alone.
  if (typeof msg.ts !== 'number' || !Number.isFinite(msg.ts)) {
    console.warn(`[${AGENT_ID}] dropping message from ${msg.from} — missing ts`);
    return;
  }
  if (Math.abs(now - msg.ts) > FRESHNESS_MS) {
    console.warn(`[${AGENT_ID}] dropping stale/future message from ${msg.from}`);
    return;
  }

  // Signature — required when QUORUM_REQUIRE_AXL_SIG=true.
  if (REQUIRE_SIG) {
    const ok = await axlVerify(msg).catch(() => false);
    if (!ok) {
      console.warn(`[${AGENT_ID}] dropping unsigned/invalid message from ${msg.from}`);
      return;
    }
  }

  const incoming = parseIncoming(msg.payload);
  if (!incoming) {
    console.warn(`[${AGENT_ID}] dropping malformed message from ${msg.from}`);
    return;
  }

  if (incoming.kind === 'verdict_request') {
    const verdict: JudgeVerdict = incoming.verdict;
    // Dedupe BEFORE rate-limit so legitimate retries don't burn the peer's
    // token quota.
    const key = inputDedupeKey(msg.from, verdict);
    if (alreadySeen(key, now)) {
      console.warn(`[${AGENT_ID}] duplicate attestation suppressed`);
      return;
    }
    if (rateLimited(msg.from, now)) {
      console.warn(`[${AGENT_ID}] rate-limited message from ${msg.from}`);
      return;
    }
    let validation;
    try {
      validation = await validateVerdict(verdict, { probe: deps.probe });
    } catch {
      // Validation failure rolls back the rate token (we did not produce work).
      rateRefund(msg.from);
      throw new Error('validation crashed');
    }
    if (validation.valid) {
      const attestation = await issueAttestation(verdict, validation, {
        logPath: deps.attestLogPath,
      });
      await send(ATTEST_TARGET, { kind: 'attestation', attestation });
      return;
    }
    await send(REPROBE_TARGET, {
      kind: 'reprobe_request',
      verdict,
      failures: clampFailures(validation.failures),
    });
    return;
  }

  // reprobe_request — count toward rate limit (no dedupe; reprobe is a request
  // for a fresh look, not a one-shot attestation).
  if (rateLimited(msg.from, now)) {
    console.warn(`[${AGENT_ID}] rate-limited message from ${msg.from}`);
    return;
  }
  const validation = await validateVerdict(incoming.verdict, { probe: deps.probe });
  await send(msg.from, {
    kind: 'reprobe_response',
    verdict: incoming.verdict,
    validation: { ...validation, failures: clampFailures(validation.failures) },
  });
}

export async function pollLoop(
  deps: HandlerDeps = {},
  iterations?: number
): Promise<void> {
  let i = 0;
  while (iterations === undefined || i < iterations) {
    const msg = await axlReceive(AGENT_ID).catch(() => null);
    if (msg) {
      try {
        await handleMessage(msg, deps);
      } catch (err) {
        // Log the error type but never the raw message — RPC errors can carry secrets.
        console.error(`[${AGENT_ID}] handler error:`, (err as Error).name);
      }
    } else {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    i++;
  }
}

async function main(): Promise<void> {
  console.log(
    `[${AGENT_ID}] starting — attest→${ATTEST_TARGET} reprobe→${REPROBE_TARGET} poll=${POLL_INTERVAL_MS}ms sig=${REQUIRE_SIG}`
  );
  await pollLoop();
}

if (require.main === module) {
  main().catch((e) => {
    console.error((e as Error).name);
    process.exit(1);
  });
}
