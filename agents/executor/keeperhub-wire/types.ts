// keeperhub-wire/types.ts
// Shared types + zod schemas for the KeeperHub MCP wire integration.
//
// Boundary contract: every external surface (MCP responses, x402 challenges,
// webhook payloads, AXL envelopes carrying KH data) is parsed through a zod
// schema before it reaches the rest of the wire. Internal modules consume the
// already-validated types — never raw `unknown`.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** EVM checksum address (validated by viem at construction sites). */
export type Address = `0x${string}`;

/** 0x-prefixed 32-byte tx hash. */
export type Hex32 = `0x${string}`;

/** Treasurer EOA — single source of truth, mirrors persona/identity. */
export const TREASURER_EOA: Address =
  '0xd779cE46567d21b9918F24f0640cA5Ad6058C893';

/** Base mainnet chain id — KH lands attestations here today. */
export const BASE_CHAIN_ID = 8453 as const;

// ---------------------------------------------------------------------------
// MCP search_workflows
// ---------------------------------------------------------------------------

/**
 * Workflow hit. Two real-world shapes feed this schema:
 *   - mock-kh-server: { id, name, workflow_handle, price_usdc, ... }
 *   - real KH MCP:    { id, name, listedSlug, priceUsdcPerCall, ... }
 * The preprocessor below normalises real-shape fields to mock-shape names so
 * the rest of the wire sees a single hit type.
 */
const WorkflowSearchHitInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    /** Mock shape. */
    workflow_handle: z.string().optional(),
    price_usdc: z.string().optional(),
    /** Real-KH shape. */
    listedSlug: z.string().optional(),
    priceUsdcPerCall: z.string().nullable().optional(),
  })
  .passthrough();

export const WorkflowSearchHitSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  return {
    ...r,
    workflow_handle: r.workflow_handle ?? r.listedSlug,
    price_usdc:
      r.price_usdc ?? (r.priceUsdcPerCall == null ? undefined : r.priceUsdcPerCall),
  };
}, WorkflowSearchHitInputSchema);
export type WorkflowSearchHit = z.infer<typeof WorkflowSearchHitSchema>;

/**
 * Search result. Mock returns `{ hits }`, real KH returns `{ items, total, page, limit }`.
 * Preprocess into a single canonical `{ hits }` view.
 */
export const WorkflowSearchResultSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.hits)) return { hits: r.hits };
  if (Array.isArray(r.items)) return { hits: r.items };
  return raw;
}, z.object({ hits: z.array(WorkflowSearchHitSchema) }));
export type WorkflowSearchResult = z.infer<typeof WorkflowSearchResultSchema>;

// ---------------------------------------------------------------------------
// MCP call_workflow
// ---------------------------------------------------------------------------

/**
 * Outcome of a single call_workflow invocation.
 *
 * Two upstream shapes feed this schema:
 *   - mock-kh-server: { status: settled|pending|failed|duplicate, execution_id, attestation_tx? }
 *   - real KH MCP:    { status: success|error, executionId, output?, error? }
 * The preprocessor maps real-shape fields onto the canonical wire types.
 */
const CallWorkflowResultInputSchema = z
  .object({
    status: z.enum(['settled', 'pending', 'failed', 'duplicate']),
    execution_id: z.string().min(1),
    attestation_tx: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
    error: z.string().optional(),
    retry_after_ms: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const CallWorkflowResultSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  // Real-KH status mapping
  let status = r.status;
  if (status === 'success') status = 'settled';
  else if (status === 'error') status = 'failed';
  else if (status === 'pending' || status === 'queued' || status === 'running')
    status = 'pending';
  // Real-KH camelCase id
  const execution_id = r.execution_id ?? r.executionId;
  // attestation_tx may live under output.txHash for write workflows; best-effort
  let attestation_tx = r.attestation_tx;
  const output = r.output as Record<string, unknown> | undefined;
  if (!attestation_tx && output) {
    const candidate = output.txHash ?? output.transactionHash ?? output.tx_hash;
    if (typeof candidate === 'string') attestation_tx = candidate;
  }
  // Coerce error to string when present
  let error = r.error;
  if (error != null && typeof error !== 'string') error = JSON.stringify(error);
  return { ...r, status, execution_id, attestation_tx, error };
}, CallWorkflowResultInputSchema);
export type CallWorkflowResult = z.infer<typeof CallWorkflowResultSchema>;

// ---------------------------------------------------------------------------
// x402 challenge (mirror of treasurer/index.ts shape — kept local to avoid
// a cross-agent type dependency that pulls in viem at this layer)
// ---------------------------------------------------------------------------

export const X402ChallengeSchema = z.object({
  url: z.string().url(),
  amount: z.string().regex(/^\d+$/), // smallest-unit decimal
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().positive(),
  payTo: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  rawHeader: z.string().optional(),
});
export type X402Challenge = z.infer<typeof X402ChallengeSchema>;

// ---------------------------------------------------------------------------
// Webhook payload — KH workflow-completion delivery
// ---------------------------------------------------------------------------

export const KhWebhookPayloadSchema = z.object({
  /** KH-side delivery id; stable across retries. Use as handler idempotency key. */
  delivery_id: z.string().min(1),
  /** Logical workflow handle (or id when handle missing). */
  workflow_id: z.string().min(1),
  /** KH-side execution id correlating to call_workflow result. */
  execution_id: z.string().min(1),
  status: z.enum(['settled', 'failed']),
  attestation_tx: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional(),
  delivered_at: z.string(), // ISO-8601
});
export type KhWebhookPayload = z.infer<typeof KhWebhookPayloadSchema>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface KeeperHubWireConfig {
  /** MCP endpoint (JSON-RPC over HTTP). */
  mcpEndpoint: string;
  /** Bearer token for MCP, if configured server-side. */
  mcpAuthToken?: string;
  /** Webhook secret used for HMAC verification. */
  webhookSecret: string;
  /** Cache TTL for resolved workflow ids — 6h per FEEDBACK item 1. */
  workflowIdTtlMs: number;
  /** Idempotency window — KH should dedupe within this window. */
  idempotencyWindowMs: number;
  /** Path to verify-mode log file. Set when running staged exec evidence run. */
  verifyLogPath?: string;
}

export const DEFAULT_CONFIG: Omit<
  KeeperHubWireConfig,
  'mcpEndpoint' | 'webhookSecret'
> = {
  workflowIdTtlMs: 6 * 60 * 60 * 1000, // 6h
  idempotencyWindowMs: 24 * 60 * 60 * 1000, // 24h
};
