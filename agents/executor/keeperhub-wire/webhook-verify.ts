// keeperhub-wire/webhook-verify.ts
// HMAC-SHA256 signature verification for KH workflow-completion webhooks.
//
// FEEDBACK item 7: KH ships an SDK helper for this; we mirror its semantics
// rather than depending on the SDK because the rest of the wire is dep-free
// at the network layer. One additional thing this module does that the docs
// example does not: it strips out two foot-guns —
//
//   1. constant-time compare via timingSafeEqual on the raw byte buffers
//      (string == is variable-time and leaks the prefix length on mismatch)
//   2. timestamp-bounded replay rejection — a valid-but-old signature is
//      still a replay vector if the handler is idempotent only on
//      delivery_id and the attacker spoofs delivery_id. We bind freshness
//      to a 5-minute envelope around the X-KH-Timestamp header.
//
// Production note: KH's actual header names may differ (X-KH-Signature vs
// X-KeeperHub-Signature). We accept both via a small alias set; the wire
// updates if KH renames upstream.

import { createHmac, timingSafeEqual } from 'node:crypto';

import { KhWebhookPayloadSchema, type KhWebhookPayload } from './types';

// ---------------------------------------------------------------------------
// Header aliases (case-insensitive lookup)
// ---------------------------------------------------------------------------

const SIG_HEADERS = ['x-kh-signature', 'x-keeperhub-signature'] as const;
const TS_HEADERS = ['x-kh-timestamp', 'x-keeperhub-timestamp'] as const;

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WebhookSignatureInvalid extends Error {
  constructor(reason: string) {
    super(`webhook signature invalid: ${reason}`);
    this.name = 'WebhookSignatureInvalid';
  }
}

export class WebhookReplayRejected extends Error {
  constructor(deltaMs: number) {
    super(`webhook timestamp outside replay window (delta=${deltaMs}ms)`);
    this.name = 'WebhookReplayRejected';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VerifyArgs {
  /** Raw request body bytes (NOT JSON.parse'd — signature covers the bytes). */
  rawBody: Buffer | string;
  /** Map of HTTP request headers (case-insensitive lookup performed). */
  headers: Record<string, string | string[] | undefined>;
  /** HMAC secret configured for KH webhooks. */
  secret: string;
  /** Inject a clock for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Verify the HMAC, enforce the replay window, parse the payload through zod.
 * Throws on any failure; returns the validated payload on success.
 */
export function verifyKhWebhook(args: VerifyArgs): KhWebhookPayload {
  const now = args.now ?? Date.now;

  const headerSig = pickHeader(args.headers, SIG_HEADERS);
  if (!headerSig) {
    throw new WebhookSignatureInvalid('missing signature header');
  }
  const headerTs = pickHeader(args.headers, TS_HEADERS);
  if (!headerTs) {
    throw new WebhookSignatureInvalid('missing timestamp header');
  }

  // Replay window
  const ts = Number(headerTs);
  if (!Number.isFinite(ts)) {
    throw new WebhookSignatureInvalid('non-numeric timestamp');
  }
  const tsMs = ts < 1e12 ? ts * 1000 : ts; // accept seconds or ms
  const delta = Math.abs(now() - tsMs);
  if (delta > REPLAY_WINDOW_MS) {
    throw new WebhookReplayRejected(delta);
  }

  // HMAC. Convention: HMAC over `${timestamp}.${rawBody}` — matches Stripe-
  // style schemes and is what KH's SDK helper uses internally per the
  // example we read.
  const bodyStr =
    typeof args.rawBody === 'string'
      ? args.rawBody
      : args.rawBody.toString('utf8');
  const signed = `${headerTs}.${bodyStr}`;
  const expected = createHmac('sha256', args.secret).update(signed).digest();

  // Header may be hex or `sha256=hex` — accept both.
  const cleaned = headerSig.startsWith('sha256=')
    ? headerSig.slice('sha256='.length)
    : headerSig;
  let provided: Buffer;
  try {
    provided = Buffer.from(cleaned, 'hex');
  } catch {
    throw new WebhookSignatureInvalid('non-hex signature');
  }

  if (provided.length !== expected.length) {
    throw new WebhookSignatureInvalid('length mismatch');
  }
  if (!timingSafeEqual(provided, expected)) {
    throw new WebhookSignatureInvalid('hmac mismatch');
  }

  // Parse payload last — we don't trust unsigned bytes.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyStr);
  } catch {
    throw new WebhookSignatureInvalid('body is not valid JSON');
  }
  const parsed = KhWebhookPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new WebhookSignatureInvalid(
      `payload schema mismatch: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  names: readonly string[],
): string | undefined {
  // Build a case-insensitive view once.
  const lower: Record<string, string | string[] | undefined> = {};
  for (const k of Object.keys(headers)) {
    lower[k.toLowerCase()] = headers[k];
  }
  for (const n of names) {
    const v = lower[n];
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.length > 0) return v[0];
  }
  return undefined;
}
