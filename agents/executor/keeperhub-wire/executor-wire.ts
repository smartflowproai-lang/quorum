// keeperhub-wire/executor-wire.ts
// Top-level orchestrator: takes a verdict, lands an attestation via KH.
//
// Composition (boring on purpose — each layer has one job):
//
//   resolve workflow id (cached, 6h)
//      ↓
//   derive idempotency key (workflow_id + canonical input)
//      ↓
//   short-circuit if already executed
//      ↓
//   call_workflow
//      ↓
//      ├── 402 → pay via Treasurer over AXL → retry once under same idem key
//      ├── 404 → invalidate cache → re-resolve → retry once
//      └── 5xx → backoff + retry under same idem key (max 3)
//
// Anything outside that envelope (judge verdict shape, ed25519 signature
// payload, ERC-8004 wrapping) is the caller's job — this module does not
// know what's inside `input`. That separation is what lets the same wire
// host new attestation shapes without churn.

import {
  KeeperHubMcpClient,
  McpInvalidInput,
  McpPaymentRequired,
  McpTransientError,
  McpWorkflowNotFound,
} from './mcp-client';
import { WorkflowIdCache } from './workflow-cache';
import {
  IdempotencyStore,
  deriveIdempotencyKey,
  newTraceId,
} from './idempotency';
import { payX402ViaTreasurer } from './x402-payer';
import type {
  CallWorkflowResult,
  KeeperHubWireConfig,
  WorkflowSearchHit,
  X402Challenge,
} from './types';

// ---------------------------------------------------------------------------
// Payer injection — production uses Treasurer over AXL; verify-mode and tests
// inject an inline payer so the wire is exercisable without a live AXL mesh.
// ---------------------------------------------------------------------------

export type X402Payer = (args: {
  challenge: X402Challenge;
  traceId: string;
}) => Promise<{ settleTxHash: string }>;

export const treasurerPayer: X402Payer = (args) =>
  payX402ViaTreasurer({ challenge: args.challenge, traceId: args.traceId });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LandAttestationArgs {
  /** Discovery query — Executor's logical handle for the KH workflow. */
  workflowQuery: string;
  /** Workflow input — the verdict payload. Must be JSON-serialisable. */
  input: Record<string, unknown>;
  /** Optional caller-provided trace id; one is generated if absent. */
  traceId?: string;
}

export interface LandAttestationResult {
  traceId: string;
  workflowId: string;
  idempotencyKey: string;
  result: CallWorkflowResult;
  /** True when the result was served from the local idempotency store. */
  shortCircuited: boolean;
  /** Number of `call_workflow` HTTP attempts (1 = no retry). */
  attempts: number;
}

export type WireLogger = (entry: WireLogEntry) => void;

export interface WireLogEntry {
  ts: string;
  trace_id: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  workflow_query?: string;
  workflow_id?: string;
  idempotency_key?: string;
  attempts?: number;
  attestation_tx?: string;
  status?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;

export class ExecutorKeeperHubWire {
  private readonly mcp: KeeperHubMcpClient;
  private readonly cache: WorkflowIdCache;
  private readonly idem: IdempotencyStore;

  private readonly payer: X402Payer;

  constructor(
    cfg: KeeperHubWireConfig,
    private readonly log: WireLogger = defaultLogger,
    payer: X402Payer = treasurerPayer,
  ) {
    this.mcp = new KeeperHubMcpClient(cfg);
    this.cache = new WorkflowIdCache(this.mcp, cfg.workflowIdTtlMs);
    this.idem = new IdempotencyStore(cfg.idempotencyWindowMs);
    this.payer = payer;
  }

  async landAttestation(
    args: LandAttestationArgs,
  ): Promise<LandAttestationResult> {
    const traceId = args.traceId ?? newTraceId();

    // Step 1: resolve workflow id via cache
    let hit: WorkflowSearchHit;
    try {
      hit = await this.cache.resolve(args.workflowQuery);
    } catch (e) {
      this.log({
        ts: nowIso(),
        trace_id: traceId,
        level: 'error',
        event: 'resolve_failed',
        workflow_query: args.workflowQuery,
        error: errMsg(e),
      });
      throw e;
    }

    // Step 2: idempotency key + short-circuit
    const idempotencyKey = deriveIdempotencyKey(hit.id, args.input);
    const cachedExec = this.idem.lookup(idempotencyKey);
    if (cachedExec) {
      this.log({
        ts: nowIso(),
        trace_id: traceId,
        level: 'info',
        event: 'short_circuit',
        workflow_id: hit.id,
        idempotency_key: idempotencyKey,
        status: 'duplicate',
      });
      return {
        traceId,
        workflowId: hit.id,
        idempotencyKey,
        shortCircuited: true,
        attempts: 0,
        result: {
          status: 'duplicate',
          execution_id: cachedExec,
        },
      };
    }

    // Step 3: call_workflow loop with typed-error-driven recovery
    let attempts = 0;
    let workflowId = hit.id;
    let cacheRefreshed = false;
    /**
     * Bound on "free retries" (402 → pay → retry, 404 → re-resolve → retry).
     * Without this an infinite loop is possible if a misbehaving server keeps
     * returning 402 even after settle confirmation. 8 = enough for one each
     * of {402, 404, 5xx} with comfortable headroom.
     */
    let freeRetriesUsed = 0;
    const MAX_FREE_RETRIES = 8;

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      try {
        const result = await this.mcp.callWorkflow({
          workflowId,
          slug: hit.workflow_handle,
          input: args.input,
          idempotencyKey,
        });
        if (result.status === 'settled' || result.status === 'pending') {
          this.idem.record(idempotencyKey, result.execution_id);
        } else if (result.status === 'failed') {
          // Failed terminal — drop key so a true retry can fire
          this.idem.drop(idempotencyKey);
        }
        this.log({
          ts: nowIso(),
          trace_id: traceId,
          level: result.status === 'failed' ? 'warn' : 'info',
          event: 'call_workflow_done',
          workflow_query: args.workflowQuery,
          workflow_id: workflowId,
          idempotency_key: idempotencyKey,
          attempts,
          status: result.status,
          attestation_tx: result.attestation_tx,
          error: result.error,
        });
        return {
          traceId,
          workflowId,
          idempotencyKey,
          shortCircuited: false,
          attempts,
          result,
        };
      } catch (e) {
        if (e instanceof McpPaymentRequired) {
          if (freeRetriesUsed >= MAX_FREE_RETRIES) {
            this.log({
              ts: nowIso(),
              trace_id: traceId,
              level: 'error',
              event: 'free_retries_exhausted_402',
              workflow_id: workflowId,
              idempotency_key: idempotencyKey,
            });
            throw e;
          }
          this.log({
            ts: nowIso(),
            trace_id: traceId,
            level: 'info',
            event: 'paying_x402',
            workflow_id: workflowId,
            idempotency_key: idempotencyKey,
            attempts,
          });
          await this.payer({
            challenge: e.challenge,
            traceId,
          });
          freeRetriesUsed += 1;
          // pay → retry under same idem key, do not increment burn budget
          attempts -= 1;
          continue;
        }
        if (e instanceof McpWorkflowNotFound) {
          if (cacheRefreshed) {
            this.log({
              ts: nowIso(),
              trace_id: traceId,
              level: 'error',
              event: 'wf_not_found_after_refresh',
              workflow_id: workflowId,
            });
            throw e;
          }
          this.cache.invalidateById(workflowId);
          const refreshed = await this.cache.resolve(args.workflowQuery);
          workflowId = refreshed.id;
          cacheRefreshed = true;
          freeRetriesUsed += 1;
          this.log({
            ts: nowIso(),
            trace_id: traceId,
            level: 'warn',
            event: 'wf_id_refreshed',
            workflow_query: args.workflowQuery,
            workflow_id: workflowId,
          });
          // refresh → retry under same idem key
          attempts -= 1;
          continue;
        }
        if (e instanceof McpTransientError) {
          if (attempts >= MAX_ATTEMPTS) {
            this.log({
              ts: nowIso(),
              trace_id: traceId,
              level: 'error',
              event: 'transient_exhausted',
              workflow_id: workflowId,
              attempts,
              error: errMsg(e),
            });
            throw e;
          }
          const delay = e.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (attempts - 1);
          this.log({
            ts: nowIso(),
            trace_id: traceId,
            level: 'warn',
            event: 'transient_retry',
            workflow_id: workflowId,
            attempts,
            error: errMsg(e),
          });
          await sleep(delay);
          continue;
        }
        if (e instanceof McpInvalidInput) {
          this.log({
            ts: nowIso(),
            trace_id: traceId,
            level: 'error',
            event: 'invalid_input',
            workflow_id: workflowId,
            error: errMsg(e),
          });
          throw e;
        }
        // unknown error — surface with context
        this.log({
          ts: nowIso(),
          trace_id: traceId,
          level: 'error',
          event: 'unknown_error',
          workflow_id: workflowId,
          error: errMsg(e),
        });
        throw e;
      }
    }
    throw new Error(`unreachable: exhausted attempts without resolution`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const defaultLogger: WireLogger = (entry) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
};
