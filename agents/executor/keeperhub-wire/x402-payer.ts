// keeperhub-wire/x402-payer.ts
// Pay an x402 challenge surfaced by KH MCP, by delegating to the Treasurer
// agent over the AXL mesh.
//
// Contract:
//   Executor never holds Treasurer's private key. When KH returns a 402,
//   Executor packages the challenge into an AXL message addressed to
//   `treasurer` and waits (with timeout) for a `settlement` reply
//   referencing the same trace id. Treasurer's existing X402Handler does
//   the swap-and-settle; this module is purely the request/response wire.
//
// Why this shape: the QUORUM brief (SUBMISSION.md) is "no shared wallet,
// no human in the gas loop". Treasurer is the only agent with the signer.
// Executor must not be tempted to settle directly even if the signer were
// in scope, because the audit trail of "who paid what for which verdict"
// is what makes the multi-agent posture defensible.
//
// Failure-mode contract:
//   - timeout → throws X402PayTimeout (caller decides to retry under same idem key)
//   - explicit reject from Treasurer → throws X402PayRejected (terminal)

import { axlSend, axlRecv } from '../../../shared/axl-wrap';

import type { X402Challenge } from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class X402PayTimeout extends Error {
  constructor(traceId: string, ms: number) {
    super(`x402 pay timed out after ${ms}ms (trace=${traceId})`);
    this.name = 'X402PayTimeout';
  }
}

export class X402PayRejected extends Error {
  constructor(public readonly reason: string, traceId: string) {
    super(`treasurer rejected x402 pay (trace=${traceId}): ${reason}`);
    this.name = 'X402PayRejected';
  }
}

// ---------------------------------------------------------------------------
// Wire envelope shapes (kept loose — Treasurer owns the Settlement schema)
// ---------------------------------------------------------------------------

interface X402PayRequest {
  agent: 'executor';
  request: 'x402_pay';
  trace_id: string;
  challenge: X402Challenge;
  /** ISO-8601, lets Treasurer drop stale requests. */
  issued_at: string;
}

interface X402PayResponse {
  request: 'x402_pay';
  trace_id: string;
  status: 'settled' | 'rejected';
  /** Filled when settled. */
  settle_tx_hash?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PayX402Args {
  challenge: X402Challenge;
  traceId: string;
  /** Reservation-window timeout — FEEDBACK item 2 says we want 15s. */
  timeoutMs?: number;
  /** Polling cadence for Treasurer's reply on the AXL queue. */
  pollIntervalMs?: number;
}

/**
 * Send the challenge to Treasurer and wait for the settlement envelope.
 * Returns the settle tx hash on success.
 */
export async function payX402ViaTreasurer(
  args: PayX402Args,
): Promise<{ settleTxHash: string }> {
  const timeoutMs = args.timeoutMs ?? 15_000; // FEEDBACK item 2
  const pollMs = args.pollIntervalMs ?? 250;

  const req: X402PayRequest = {
    agent: 'executor',
    request: 'x402_pay',
    trace_id: args.traceId,
    challenge: args.challenge,
    issued_at: new Date().toISOString(),
  };
  await axlSend('treasurer', req);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inbox = await axlRecv().catch(() => []);
    for (const env of inbox) {
      const parsed = tryParseResponse(env.data);
      if (!parsed) continue;
      if (parsed.trace_id !== args.traceId) continue;
      if (parsed.status === 'settled' && parsed.settle_tx_hash) {
        return { settleTxHash: parsed.settle_tx_hash };
      }
      throw new X402PayRejected(
        parsed.reason ?? 'no reason given',
        args.traceId,
      );
    }
    await sleep(pollMs);
  }
  throw new X402PayTimeout(args.traceId, timeoutMs);
}

function tryParseResponse(raw: string): X402PayResponse | null {
  try {
    const o = JSON.parse(raw) as Partial<X402PayResponse> & Record<string, unknown>;
    if (o.request !== 'x402_pay') return null;
    if (typeof o.trace_id !== 'string') return null;
    if (o.status !== 'settled' && o.status !== 'rejected') return null;
    return o as X402PayResponse;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
