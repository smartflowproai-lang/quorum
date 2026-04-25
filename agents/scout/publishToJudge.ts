// agents/scout/publishToJudge.ts — AXL send wrapper for Scout → Judge events
//
// PURPOSE
// -------
// Scout detects smart-money wallet activity on Solana and enriches each event
// with an EVM correlation. This module sends the enriched candidate to the
// Judge agent on the NYC AXL node for verdict computation.
//
// DESIGN NOTES
// ------------
// - Scout runs on Frankfurt VPS; Judge runs on NYC VPS.
// - Both VPSes have a co-located AXL node (localhost:9002).
// - Frankfurt AXL node routes messages to NYC AXL node via the pre-peered
//   TLS:9001 mesh established on Day 1.
// - This module is intentionally thin: it does ONE thing (serialise + send).
//   Retry logic lives in the AXL node itself (mesh-level delivery guarantees).
// - All fields are typed so the Judge can deserialise with confidence.

import { axlSend } from '../../shared/axl-wrap';
import type { ScoutCandidate } from './index';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Peer ID of the Judge agent's AXL node. In production this comes from the
// /topology response of Frankfurt's node, set at deploy time via env.
// Fallback "judge" is used during local compose testing where both agents
// run on the same host with AXL peer alias "judge".
const JUDGE_PEER = process.env.JUDGE_AXL_PEER ?? 'judge';

// Message type tag — lets Judge filter without deserialising full payload
export const CANDIDATE_MSG_TYPE = 'scout.candidate.v1' as const;

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export interface CandidateMessage {
  type: typeof CANDIDATE_MSG_TYPE;
  schemaVersion: 1;
  candidate: ScoutCandidate;
  /** Scout's agent ID / hostname for traceability */
  origin: string;
  /** Unix epoch ms when Scout emitted this message */
  emittedAt: number;
}

// ---------------------------------------------------------------------------
// publishToJudge — main export
// ---------------------------------------------------------------------------

/**
 * Publish a ScoutCandidate to the Judge agent via AXL.
 *
 * Throws if AXL /send returns an error (caller should catch and log,
 * then continue processing the next event — one dropped message is acceptable).
 *
 * @param candidate  Enriched wallet-activity event from Scout's event handler.
 */
export async function publishToJudge(candidate: ScoutCandidate): Promise<void> {
  const msg: CandidateMessage = {
    type: CANDIDATE_MSG_TYPE,
    schemaVersion: 1,
    candidate,
    origin: process.env.HOSTNAME ?? 'scout-frankfurt',
    emittedAt: Date.now(),
  };

  await axlSend(JUDGE_PEER, msg);
}

/**
 * Deserialise a raw AXL envelope data string back to a CandidateMessage.
 * Used by Judge agent to validate incoming messages.
 *
 * Returns null if the message is not a scout candidate (graceful multi-sender
 * support: Judge may receive heartbeats and other types on the same recv queue).
 */
export function parseCandidateMessage(rawData: string): CandidateMessage | null {
  try {
    const parsed = JSON.parse(rawData) as { type?: string };
    if (parsed.type !== CANDIDATE_MSG_TYPE) return null;
    return parsed as CandidateMessage;
  } catch {
    return null;
  }
}
