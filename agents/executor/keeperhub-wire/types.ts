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

export const WorkflowSearchHitSchema = z.object({
  /** Stable handle if KH ships it; falls back to id today. See FEEDBACK item 1. */
  workflow_handle: z.string().optional(),
  id: z.string().min(1),
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  /** USDC denominated price-per-call as decimal string, optional. */
  price_usdc: z.string().optional(),
});
export type WorkflowSearchHit = z.infer<typeof WorkflowSearchHitSchema>;

export const WorkflowSearchResultSchema = z.object({
  hits: z.array(WorkflowSearchHitSchema),
});
export type WorkflowSearchResult = z.infer<typeof WorkflowSearchResultSchema>;

// ---------------------------------------------------------------------------
// MCP call_workflow
// ---------------------------------------------------------------------------

/** Outcome of a single call_workflow invocation. */
export const CallWorkflowResultSchema = z.object({
  /** Status returned by KH MCP. */
  status: z.enum(['settled', 'pending', 'failed', 'duplicate']),
  /** KH-side execution id (stable; usable as audit handle). */
  execution_id: z.string().min(1),
  /** Optional on-chain attestation tx hash if landed synchronously. */
  attestation_tx: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional(),
  /** Optional human-readable error code on failed status. */
  error: z.string().optional(),
  /** Optional latency hint surfaced by KH for backpressure (FEEDBACK item 2). */
  retry_after_ms: z.number().int().nonnegative().optional(),
});
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
