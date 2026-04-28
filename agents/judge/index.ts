// agents/judge/index.ts — QUORUM Judge agent
//
// PURPOSE
// -------
// Judge receives ScoutCandidate events forwarded by Scout over the AXL mesh
// (Frankfurt → NYC). For each candidate it applies a multi-feature risk model
// and emits a verdict (SAFE | WATCH | RUG) to the Executor agent.
//
// ARCHITECTURE
// ------------
//   NYC VPS
//   ┌──────────────────────────────────────┐
//   │  AXL node B (localhost:9002)         │
//   │     ↑ receives from Frankfurt AXL A  │
//   │     ↓ forwards to this process       │
//   └──────────────┬───────────────────────┘
//                  │ poll GET /recv every 500 ms
//   ┌──────────────▼───────────────────────┐
//   │  Judge agent (this file)             │
//   │  1. parseCandidateMessage            │
//   │  2. extractFeatures(candidate)       │
//   │  3. computeVerdict(features)         │
//   │  4. log verdict + ack via axlSend    │
//   └──────────────────────────────────────┘
//
// Day 3 scope: HTTP poll loop + feature extraction stubs + verdict emission.
// Day 4 will replace stub feature weights with backtested model coefficients.

import { axlRecv, axlSend } from '../../shared/axl-wrap';
import {
  parseCandidateMessage,
  type CandidateMessage,
} from '../scout/publishToJudge';
import type { ScoutCandidate } from '../scout/index';
import * as http from 'http';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AGENT_ID = 'judge';

// Peer to ack back to (Scout's AXL peer ID or "scout" for local compose)
const SCOUT_PEER = process.env.SCOUT_AXL_PEER ?? 'scout';

// Peer to forward verdicts to (Executor agent on same NYC node or separate)
const EXECUTOR_PEER = process.env.EXECUTOR_AXL_PEER ?? 'executor';

// Poll interval for AXL recv queue (ms)
const POLL_INTERVAL_MS = 500;

// Health-check HTTP port (judges may curl to verify liveness)
const HEALTH_PORT = parseInt(process.env.JUDGE_PORT ?? '9100', 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Verdict = 'SAFE' | 'WATCH' | 'RUG';

export interface FeatureVector {
  hasEvmCorrelation: boolean;
  isRisky: boolean;
  lamports: number;
  /** Lamports normalised 0-1 relative to 10 SOL heuristic threshold */
  lamportsNorm: number;
  ageMs: number;
}

export interface JudgeVerdict {
  candidateWallet: string;
  verdict: Verdict;
  score: number; // 0.0 (safe) – 1.0 (definite rug)
  features: FeatureVector;
  judgedAt: number;
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * Extract a fixed-size feature vector from a ScoutCandidate.
 *
 * Day 3: features are structural (what we can derive from the event shape).
 * Day 4: add backtested weights from historical rug-vs-safe labelled dataset.
 */
function extractFeatures(candidate: ScoutCandidate): FeatureVector {
  const hasEvmCorrelation = candidate.bridge?.evmCorrelation !== undefined;
  const isRisky = candidate.bridge?.riskFlag ?? false;
  const lamports = candidate.event.lamports;

  // 10 SOL (10e9 lamports) is an empirical threshold: wallets accumulating
  // more than this in a single account change are worth watching.
  const lamportsNorm = Math.min(lamports / 10_000_000_000, 1.0);

  const ageMs = Date.now() - candidate.event.timestamp;

  return { hasEvmCorrelation, isRisky, lamports, lamportsNorm, ageMs };
}

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

/**
 * Simple weighted rule-based scorer.
 *
 * Score formula (Day 3 — before backtested weights):
 *   score = 0.6 * isRisky + 0.25 * hasEvmCorrelation + 0.15 * lamportsNorm
 *
 * Thresholds:
 *   score >= 0.7 → RUG
 *   score >= 0.4 → WATCH
 *   score <  0.4 → SAFE
 *
 * Day 4: Replace coefficients with logistic regression weights trained on
 * SmartFlow observatory rug-vs-safe dataset (8-feature model, AUC 0.87).
 */
function computeVerdict(features: FeatureVector): { verdict: Verdict; score: number } {
  const score =
    0.6 * (features.isRisky ? 1 : 0) +
    0.25 * (features.hasEvmCorrelation ? 1 : 0) +
    0.15 * features.lamportsNorm;

  const verdict: Verdict =
    score >= 0.7 ? 'RUG' : score >= 0.4 ? 'WATCH' : 'SAFE';

  return { verdict, score: Math.round(score * 1000) / 1000 };
}

// ---------------------------------------------------------------------------
// Process a single candidate
// ---------------------------------------------------------------------------

async function processCandidate(msg: CandidateMessage): Promise<void> {
  const { candidate } = msg;
  const features = extractFeatures(candidate);
  const { verdict, score } = computeVerdict(features);

  const judgeVerdict: JudgeVerdict = {
    candidateWallet: candidate.event.wallet,
    verdict,
    score,
    features,
    judgedAt: Date.now(),
  };

  console.log(
    `[${AGENT_ID}] verdict=${verdict} score=${score} wallet=${candidate.event.wallet.slice(0, 8)}… ` +
      `evm=${features.hasEvmCorrelation} risky=${features.isRisky}`
  );

  // 1. Ack back to Scout so it knows the message was processed
  await axlSend(SCOUT_PEER, {
    type: 'judge.ack.v1',
    ref: msg.emittedAt,
    verdict,
    judgedAt: judgeVerdict.judgedAt,
  }).catch((e: Error) => console.error(`[${AGENT_ID}] ack failed:`, e.message));

  // 2. Forward verdict to Executor for downstream action (swap, alert, etc.)
  await axlSend(EXECUTOR_PEER, {
    type: 'judge.verdict.v1',
    verdict: judgeVerdict,
  }).catch((e: Error) => console.error(`[${AGENT_ID}] executor fwd failed:`, e.message));
}

// ---------------------------------------------------------------------------
// AXL recv poll loop
// ---------------------------------------------------------------------------

let processingCount = 0; // in-flight candidates (for health endpoint)
let totalProcessed = 0;

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const messages = await axlRecv();
      for (const envelope of messages) {
        const candidate = parseCandidateMessage(envelope.data);
        if (!candidate) {
          // Not a scout candidate — could be heartbeat or other type, skip silently
          continue;
        }
        processingCount++;
        await processCandidate(candidate).catch((e: Error) =>
          console.error(`[${AGENT_ID}] processCandidate error:`, e.message)
        );
        processingCount--;
        totalProcessed++;
      }
    } catch (e) {
      // AXL node may not be ready yet (first seconds after startup)
      console.warn(`[${AGENT_ID}] axlRecv error (will retry):`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// Health-check HTTP server
// ---------------------------------------------------------------------------

// Judges (hackathon reviewers) can verify the Judge is live with:
//   curl http://NYC_VPS:9100/health
// Returns: { status: "ok", processed: N, inFlight: M, uptime: Xs }

const startTime = Date.now();

function startHealthServer(): void {
  const server = http.createServer((_req, res) => {
    const body = JSON.stringify({
      status: 'ok',
      agent: AGENT_ID,
      processed: totalProcessed,
      inFlight: processingCount,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  server.listen(HEALTH_PORT, () => {
    console.log(`[${AGENT_ID}] health endpoint: http://localhost:${HEALTH_PORT}/health`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `[${AGENT_ID}] starting — poll=${POLL_INTERVAL_MS}ms ` +
      `scout_peer=${SCOUT_PEER} executor_peer=${EXECUTOR_PEER}`
  );

  startHealthServer();

  // Begin polling AXL recv queue
  await pollLoop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
