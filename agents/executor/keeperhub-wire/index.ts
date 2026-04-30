// keeperhub-wire/index.ts
// Public surface of the KeeperHub MCP wire. Executor's main loop imports
// from here; nothing in this directory should be imported via deeper paths
// from outside the wire so we keep one ratchet on what's stable.

export { ExecutorKeeperHubWire } from './executor-wire';
export type {
  LandAttestationArgs,
  LandAttestationResult,
  WireLogger,
  WireLogEntry,
} from './executor-wire';

export {
  KeeperHubMcpClient,
  McpInvalidInput,
  McpPaymentRequired,
  McpTransientError,
  McpWorkflowNotFound,
} from './mcp-client';

export { WorkflowIdCache } from './workflow-cache';
export {
  IdempotencyStore,
  deriveIdempotencyKey,
  newTraceId,
} from './idempotency';
export {
  verifyKhWebhook,
  WebhookSignatureInvalid,
  WebhookReplayRejected,
  type VerifyArgs,
} from './webhook-verify';
export {
  payX402ViaTreasurer,
  X402PayTimeout,
  X402PayRejected,
} from './x402-payer';

export {
  DEFAULT_CONFIG,
  TREASURER_EOA,
  BASE_CHAIN_ID,
  type KeeperHubWireConfig,
  type CallWorkflowResult,
  type WorkflowSearchHit,
  type WorkflowSearchResult,
  type X402Challenge,
  type KhWebhookPayload,
} from './types';
