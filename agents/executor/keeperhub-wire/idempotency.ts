// keeperhub-wire/idempotency.ts
// Client-side idempotency for KH `call_workflow` invocations.
//
// Per FEEDBACK item 4: KH does not yet honour an Idempotency-Key header
// authoritatively, so a missed-bundle retry can produce a duplicate
// attestation if the first attempt also lands. The wire enforces uniqueness
// itself by hashing (workflow_id, input) into a stable key and checking a
// local store before firing the second call.
//
// Storage: in-memory Map for the scaffold; the persistent Treasurer DB (the
// `payments.db` SQLite file used elsewhere in QUORUM) takes over once the
// wire is folded into the live Executor process. The interface here is
// designed so that swap is a single-line change in executor-wire.ts.

import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Idempotency key derivation
// ---------------------------------------------------------------------------

/**
 * Stable key for an attempt. Two retries of the same logical job MUST produce
 * the same key; two distinct jobs (even with overlapping inputs) MUST NOT.
 *
 * We hash:
 *   - workflowId (as resolved post-cache; survives KH republishes within
 *     the wire's invalidation window)
 *   - canonical JSON of the input
 *
 * Canonicalisation: keys sorted alphabetically, no whitespace, no lossy
 * coercion. This is sufficient for our verdict shape (small flat objects);
 * a richer canonicaliser would be needed for nested arrays-of-objects with
 * field-order ambiguity.
 */
export function deriveIdempotencyKey(
  workflowId: string,
  input: Record<string, unknown>,
): string {
  const canonical = canonicalJson(input);
  const h = createHash('sha256');
  h.update(workflowId);
  h.update('\u0000'); // null separator — workflowId never contains \u0000
  h.update(canonical);
  return `kh-idem-${h.digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

// ---------------------------------------------------------------------------
// IdempotencyStore — short-circuit duplicate calls
// ---------------------------------------------------------------------------

interface StoredAttempt {
  /** First-issue result handle; subsequent attempts return this. */
  executionId: string;
  /** epoch ms */
  recordedAt: number;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, StoredAttempt>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * If we have already recorded a settled or in-flight attempt for `key`
   * within the window, return its execution_id. Otherwise null.
   */
  lookup(key: string): string | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.now() - e.recordedAt > this.windowMs) {
      this.entries.delete(key);
      return null;
    }
    return e.executionId;
  }

  /** Record a successfully-issued execution against this key. */
  record(key: string, executionId: string): void {
    this.entries.set(key, { executionId, recordedAt: this.now() });
  }

  /**
   * Drop a key — called when call_workflow returns failed and we want to
   * allow a fresh retry under a new bundle slot. We do NOT drop on transient
   * 5xx (those should retry under the same key by design).
   */
  drop(key: string): void {
    this.entries.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Trace ids — orthogonal to idempotency, used for log correlation only
// ---------------------------------------------------------------------------

export function newTraceId(): string {
  return 'tr_' + randomBytes(8).toString('hex');
}
