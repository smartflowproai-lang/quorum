// Treasurer ↔ Uniswap Trading API integration tests.
//
// Boundary tests, not e2e: HTTP fetcher is injected, fixtures are pre-recorded.
// Each test pins a contract derived from the friction items in FEEDBACK-UNISWAP.md.
//
// Run: npx tsx --test test/uniswap-client.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  UniswapClient,
  type FetchLike,
  type QuoteRequest,
  StaleQuoteError,
  UnsupportedChainError,
  TradingApiError,
  QuoteResponseSchema,
} from "../uniswap-client";

const FIXTURES = path.join(__dirname, "fixtures");
const QUOTE_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "quote-weth-usdc.json"), "utf8"));
const SWAP_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "swap-calldata.json"), "utf8"));

const TREASURY = "0xd779cE46567d21b9918F24f0640cA5Ad6058C893";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function mockFetch(routes: Record<string, () => { ok: boolean; status: number; body: unknown }>): FetchLike {
  return async (url, _init) => {
    const matched = Object.keys(routes).find((k) => url.endsWith(k));
    if (!matched) throw new Error(`unmocked url ${url}`);
    const r = routes[matched]();
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
}

const baseReq: QuoteRequest = {
  type: "EXACT_INPUT",
  tokenIn: WETH,
  tokenOut: USDC,
  amount: "1000000000000000000",
  tokenInChainId: 8453,
  tokenOutChainId: 8453,
  swapper: TREASURY,
  slippageTolerance: 0.5,
  protocols: ["V3", "V4"],
};

test("quote: returns parsed response with quotedAt timestamp", async () => {
  const client = new UniswapClient({
    apiBase: "https://trade.uniswap.org",
    apiKey: "test-key",
    fetcher: mockFetch({ "/v1/quote": () => ({ ok: true, status: 200, body: QUOTE_FIXTURE }) }),
  });
  const before = Date.now();
  const { res, quotedAt } = await client.quote(baseReq);
  assert.equal(res.routing, "CLASSIC");
  assert.equal(res.permitData.primaryType, "PermitTransferFrom");
  assert.ok(quotedAt >= before);
});

test("quote: refuses Sepolia chainId early (FEEDBACK item #2)", async () => {
  const client = new UniswapClient({
    apiBase: "https://trade.uniswap.org",
    apiKey: "test-key",
    fetcher: mockFetch({ "/v1/quote": () => ({ ok: true, status: 200, body: QUOTE_FIXTURE }) }),
  });
  await assert.rejects(
    () => client.quote({ ...baseReq, tokenInChainId: 84532, tokenOutChainId: 84532 }),
    UnsupportedChainError,
  );
});

test("quote: refuses request without protocols (FEEDBACK item #4)", async () => {
  const client = new UniswapClient({
    apiBase: "https://trade.uniswap.org",
    apiKey: "test-key",
    fetcher: mockFetch({ "/v1/quote": () => ({ ok: true, status: 200, body: QUOTE_FIXTURE }) }),
  });
  // @ts-expect-error — protocols required by schema
  await assert.rejects(() => client.quote({ ...baseReq, protocols: undefined }));
});

test("quote: surfaces TradingApiError on non-2xx", async () => {
  const client = new UniswapClient({
    apiBase: "https://trade.uniswap.org",
    apiKey: "test-key",
    fetcher: mockFetch({ "/v1/quote": () => ({ ok: false, status: 429, body: "rate limited" }) }),
  });
  await assert.rejects(() => client.quote(baseReq), TradingApiError);
});

test("schema: rejects quote response without primaryType (FEEDBACK item #1)", () => {
  const broken = JSON.parse(JSON.stringify(QUOTE_FIXTURE));
  delete broken.permitData.primaryType;
  assert.throws(() => QuoteResponseSchema.parse(broken));
});

test("swap: refuses stale quote past TTL (FEEDBACK item #5)", async () => {
  const client = new UniswapClient({
    apiBase: "https://trade.uniswap.org",
    apiKey: "test-key",
    fetcher: mockFetch({ "/v1/swap": () => ({ ok: true, status: 200, body: SWAP_FIXTURE }) }),
    quoteTtlMs: 1000,
  });
  const stale = { res: QUOTE_FIXTURE, quotedAt: Date.now() - 5000 };
  await assert.rejects(
    () => client.swap({ quote: stale.res, quotedAt: stale.quotedAt, signedPermit: { signature: "0xdead" } }),
    StaleQuoteError,
  );
});

test("swap: returns calldata for fresh quote", async () => {
  const client = new UniswapClient({
    apiBase: "https://trade.uniswap.org",
    apiKey: "test-key",
    fetcher: mockFetch({ "/v1/swap": () => ({ ok: true, status: 200, body: SWAP_FIXTURE }) }),
    quoteTtlMs: 30_000,
  });
  const out = await client.swap({
    quote: QUOTE_FIXTURE,
    quotedAt: Date.now() - 100,
    signedPermit: { signature: "0xdead" },
  });
  assert.equal(out.to, "0x6fF5693b99212Da76ad316178A184AB56D299b43");
  assert.equal(out.gasLimit, "180000");
});
