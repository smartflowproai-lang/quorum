// Uniswap Trading API client — Day-6 wiring scaffold.
//
// This module is the boundary between Treasurer's float-management logic
// and the Uniswap Trading API (`/v1/quote`, `/v1/swap`). The HTTP fetcher is
// injected so tests can supply pre-recorded fixtures without hitting the live API.
//
// Design intent (per FEEDBACK-UNISWAP.md learnings):
//   * Quote freshness is enforced by the caller — we expose `quotedAt` so the
//     caller can re-quote on retry rather than silently re-using a stale quote.
//   * Permit2 `primaryType` is passed through verbatim — no positional fallback.
//   * `chainId` is validated up-front so we don't get a 200 from /v1/quote on a
//     chain we can't actually swap on.

import { z } from "zod";

// Base mainnet only for QUORUM. Trading API quote endpoint accepts other
// chainIds and returns 200, but /v1/swap rejects them. We refuse early.
export const SUPPORTED_CHAINS = [8453] as const;
export type SupportedChain = typeof SUPPORTED_CHAINS[number];

export const QuoteRequestSchema = z.object({
  type: z.enum(["EXACT_INPUT", "EXACT_OUTPUT"]),
  tokenIn: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  tokenOut: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+$/), // wei, decimal string
  tokenInChainId: z.number().int().positive(),
  tokenOutChainId: z.number().int().positive(),
  swapper: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  slippageTolerance: z.number().min(0).max(50).optional(),
  // Documented default of /v1/quote includes UniswapX. We refuse to default
  // implicitly — caller picks. See FEEDBACK-UNISWAP.md item #4.
  protocols: z.array(z.enum(["V2", "V3", "V4", "UniswapX"])).min(1),
}).strict();

export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const QuoteResponseSchema = z.object({
  quote: z.object({
    input: z.object({ token: z.string(), amount: z.string() }),
    output: z.object({ token: z.string(), amount: z.string() }),
    priceImpact: z.number(),
    gasFeeUSD: z.string().optional(),
  }),
  permitData: z.object({
    domain: z.record(z.unknown()),
    types: z.record(z.unknown()),
    primaryType: z.string(), // mandatory for QUORUM — see FEEDBACK item #1
    message: z.record(z.unknown()),
  }),
  routing: z.enum(["CLASSIC", "UNISWAPX", "DUTCH_LIMIT", "DUTCH_V2"]),
}).strict();

export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface UniswapClientOpts {
  apiBase: string;
  apiKey: string;
  fetcher: FetchLike;
  // Quote freshness budget — caller must re-quote past this. Default 30s.
  quoteTtlMs?: number;
}

export class StaleQuoteError extends Error {
  constructor(ageMs: number, ttlMs: number) {
    super(`quote stale: ${ageMs}ms > ${ttlMs}ms ttl`);
    this.name = "StaleQuoteError";
  }
}

export class UnsupportedChainError extends Error {
  constructor(chainId: number) {
    super(`unsupported chainId ${chainId}; QUORUM accepts ${SUPPORTED_CHAINS.join(", ")}`);
    this.name = "UnsupportedChainError";
  }
}

export class TradingApiError extends Error {
  constructor(public status: number, public bodyText: string) {
    super(`trading api status ${status}`);
    this.name = "TradingApiError";
  }
}

export class UniswapClient {
  private readonly opts: Required<UniswapClientOpts>;
  constructor(opts: UniswapClientOpts) {
    this.opts = { quoteTtlMs: 30_000, ...opts };
  }

  async quote(req: QuoteRequest): Promise<{ res: QuoteResponse; quotedAt: number }> {
    QuoteRequestSchema.parse(req);
    if (!SUPPORTED_CHAINS.includes(req.tokenInChainId as SupportedChain)) {
      throw new UnsupportedChainError(req.tokenInChainId);
    }
    if (!SUPPORTED_CHAINS.includes(req.tokenOutChainId as SupportedChain)) {
      throw new UnsupportedChainError(req.tokenOutChainId);
    }
    const r = await this.opts.fetcher(`${this.opts.apiBase}/v1/quote`, {
      method: "POST",
      headers: { "x-api-key": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw new TradingApiError(r.status, await r.text());
    const parsed = QuoteResponseSchema.parse(await r.json());
    return { res: parsed, quotedAt: Date.now() };
  }

  // Returns the calldata for the caller to broadcast. Caller computes tx hash
  // post-broadcast and reconciles in payments.db. See FEEDBACK item #6.
  async swap(opts: {
    quote: QuoteResponse;
    quotedAt: number;
    signedPermit: { signature: string };
  }): Promise<{ to: string; data: string; value: string; gasLimit: string }> {
    const age = Date.now() - opts.quotedAt;
    if (age > this.opts.quoteTtlMs) throw new StaleQuoteError(age, this.opts.quoteTtlMs);
    const r = await this.opts.fetcher(`${this.opts.apiBase}/v1/swap`, {
      method: "POST",
      headers: { "x-api-key": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ quote: opts.quote.quote, permitData: opts.quote.permitData, signature: opts.signedPermit.signature }),
    });
    if (!r.ok) throw new TradingApiError(r.status, await r.text());
    const body = await r.json() as { swap: { to: string; data: string; value: string; gasLimit: string } };
    return body.swap;
  }
}
