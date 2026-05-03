// shared/axl-wrap.ts — AXL HTTP API wrapper
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Tom Smart (@TomSmart_ai) — built for QUORUM at ETHGlobal OpenAgents 2026.
//
// STANDALONE-FRIENDLY: this file is intentionally dependency-free (just `fetch`,
// no @gensyn/axl-sdk, no Zod). Drop into any TypeScript project that talks to
// a local AXL node. Copy-paste this file + the AxlEnvelope/AxlSendArgs types,
// set `AXL_HTTP_BASE` env if your node isn't on `http://localhost:9002`, done.
//
// Reference TypeScript implementation of the AXL agent-runtime API
// (`localhost:9002` send/recv/topology). Reverse-engineered from a real
// two-VPS Frankfurt+NYC mesh during the QUORUM build window — see
// FEEDBACK-GENSYN.md item 7 for the docs gap I'd most want closed upstream.
//
// PR-ready: as soon as Gensyn opens an AXL repo (or a docs site that takes
// PRs) where this kind of reference implementation belongs, this file is
// ready to upstream verbatim. Until then, MIT-licensed and copy-friendly.
//
// Original module header preserved below.
//
// ---------------------------------------------------------------------------

// shared/axl-wrap.ts — AXL HTTP API wrapper
// AXL node exposes a local HTTP API on localhost:9002. This module provides typed
// send/recv helpers so each QUORUM agent talks to its co-located AXL node without
// depending on the AXL binary being in PATH.
//
// Architecture:
//   Frankfurt VPS: Scout agent + AXL node-A  (localhost:9002)
//   NYC VPS:       Judge agent  + AXL node-B  (localhost:9002)
//   Both nodes are pre-peered via TLS:9001 (established Day 1).
//
// Design decision: HTTP over binary exec.
// The AXL node exposes a stable REST interface at localhost:9002.
// Using fetch (Node 18+) avoids binary PATH issues in Docker containers and
// is simpler to mock in tests. The binary-exec approach was a Day-1 stub.

const AXL_HTTP_BASE = process.env.AXL_HTTP_BASE ?? 'http://localhost:9002';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AxlEnvelope {
  /** Originating agent / peer ID */
  from: string;
  /** Serialised JSON payload (callers parse after receiving) */
  data: string;
  /** Unix epoch ms from the receiving node */
  ts: number;
  /**
   * Parsed payload, set by callers after JSON.parse(data). Optional
   * because raw envelopes from /recv don't include it; verifier and
   * judge populate it after parsing.
   */
  payload?: unknown;
}

/** Backwards-compatible alias used by verifier and judge imports. */
export type AxlMessage = AxlEnvelope;

/**
 * Verify an AXL envelope shape. Stub for hackathon: returns true if the
 * envelope is well-formed (long-lived per-host signing keys deferred
 * post-hackathon — see README:30 honest caveat). Verifier guards calls
 * behind QUORUM_REQUIRE_AXL_SIG env flag — default off; flip on once
 * long-lived per-host keys ship.
 */
export async function axlVerify(msg: AxlMessage): Promise<boolean> {
  return (
    msg !== null &&
    typeof msg === 'object' &&
    typeof msg.from === 'string' &&
    typeof msg.data === 'string'
  );
}

// ---------------------------------------------------------------------------
// axlSend — POST /send to the local AXL node
// ---------------------------------------------------------------------------

/**
 * Send a JSON-serialisable payload to a named peer.
 *
 * @param peer    Peer ID as returned by /topology (or the logical agent name
 *                used in AXL peer config, e.g. "judge").
 * @param payload Any JSON-serialisable value. Will be stringified.
 *
 * Scale note: at 14 wallets the naive one-shot send is fine. For >1 K peers
 * a batched /broadcast or publish-subscribe channel would replace this.
 */
export async function axlSend(peer: string, payload: unknown): Promise<void> {
  const body = JSON.stringify({ to: peer, data: JSON.stringify(payload) });
  const res = await fetch(`${AXL_HTTP_BASE}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`axlSend failed: ${res.status} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// axlRecv — GET /recv from the local AXL node
// ---------------------------------------------------------------------------

/**
 * Pull all inbound messages queued by the AXL node for this agent.
 * Returns an empty array when the queue is empty (not an error).
 *
 * Callers are expected to poll this in a loop, e.g. every 500-1000 ms.
 * The AXL node delivers messages in FIFO order and clears them on read.
 */
export async function axlRecv(): Promise<AxlEnvelope[]> {
  const res = await fetch(`${AXL_HTTP_BASE}/recv`);
  if (!res.ok) {
    // 404 during node startup — treat as empty, don't crash the poll loop
    if (res.status === 404) return [];
    throw new Error(`axlRecv failed: ${res.status}`);
  }
  const json = (await res.json()) as { messages?: AxlEnvelope[] };
  return json.messages ?? [];
}

// ---------------------------------------------------------------------------
// axlTopology — GET /topology (diagnostic)
// ---------------------------------------------------------------------------

export interface AxlPeer {
  id: string;
  address?: string;
}

export async function axlTopology(): Promise<AxlPeer[]> {
  const res = await fetch(`${AXL_HTTP_BASE}/topology`);
  if (!res.ok) return [];
  const json = (await res.json()) as { peers?: AxlPeer[] };
  return json.peers ?? [];
}

// ---------------------------------------------------------------------------
// Legacy compat shim — Day-1 callers used axlReceive(agentId)
// Deprecated: use axlRecv() and filter client-side if needed.
// ---------------------------------------------------------------------------

export async function axlReceive(_agentId?: string): Promise<AxlEnvelope | null> {
  const msgs = await axlRecv().catch(() => []);
  return msgs[0] ?? null;
}
