// keeperhub-wire/mock-kh-server.ts
// In-process HTTP mock of the KH MCP surface. Used by verify-mode and tests.
//
// Behaviour matrix (kept honest — the wire must exercise the same code paths
// against the mock as it does against the real endpoint):
//
//   tools/call name=search_workflows
//     → 200 { result: { hits: [{ id, name, ... }] } }
//
//   tools/call name=call_workflow
//     - First time we see (workflow_id, idempotency_key) and force402=true
//       → 402 with X402Challenge body
//     - After the wire pays (paid registry seeded by /mock/__paid POST or by
//       the verify-mode harness invoking markPaid())
//       → 200 { result: { status: 'settled', execution_id, attestation_tx } }
//     - If force404 set for the workflow_id → 404 once, then 200
//     - If force5xx_count > 0 for the workflow_id → 5xx that many times
//
// The mock is deliberately strict about the JSON-RPC envelope so a malformed
// wire request surfaces here rather than silently passing.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import type { X402Challenge } from './types';

const FACILITATOR_URL = 'https://mock-facilitator.local/x402/settle';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TREASURER_EOA = '0xd779cE46567d21b9918F24f0640cA5Ad6058C893';

interface CallSpec {
  /** Force 402 on first hit (then 200 once paid). Default true. */
  force402: boolean;
  /** Force a one-time 404 (workflow republished scenario). */
  force404Once: boolean;
  /** Force this many transient 5xx responses before success. */
  force5xxCount: number;
}

export interface MockKhServerOptions {
  port?: number;
  /** Map of workflow_id → CallSpec controlling per-workflow behaviour. */
  specs?: Map<string, CallSpec>;
}

export interface MockKhServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Mark an idempotency key as paid (skip 402 on next call). */
  markPaid(idempotencyKey: string): void;
  /** Set or update a per-workflow spec. */
  setSpec(workflowId: string, spec: Partial<CallSpec>): void;
  /** Diagnostic: counts received per tool. */
  stats(): { search: number; call: number; paid402: number; served5xx: number; served404: number };
}

export async function startMockKhServer(
  opts: MockKhServerOptions = {},
): Promise<MockKhServer> {
  const port = opts.port ?? 0; // 0 = OS-assigned
  const specs: Map<string, CallSpec> = opts.specs ?? new Map();
  const paid: Set<string> = new Set();
  const served5xxByWf: Map<string, number> = new Map();
  const served404ByWf: Map<string, number> = new Map();
  const stats = { search: 0, call: 0, paid402: 0, served5xx: 0, served404: 0 };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }
    const idempotencyKey =
      typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key']
        : '';
    const body = await readBody(req);
    let env: { id: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      env = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    if (env.method !== 'tools/call') {
      res.statusCode = 400;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: env.id, error: { code: -32601, message: 'method not found' } }));
      return;
    }
    const name = env.params?.name;
    const args = env.params?.arguments ?? {};

    if (name === 'search_workflows') {
      stats.search += 1;
      const query = String(args.query ?? '');
      const id = `wf_${shortHash(query)}`;
      respond(res, 200, {
        jsonrpc: '2.0',
        id: env.id,
        result: {
          hits: [
            {
              id,
              workflow_handle: `quorum/${query}`,
              name: query,
              version: '1.0.0',
              description: 'Mock KH workflow',
              price_usdc: '0.10',
            },
          ],
        },
      });
      return;
    }

    if (name === 'call_workflow') {
      stats.call += 1;
      const workflowId = String(args.workflow_id ?? '');
      const spec: CallSpec = specs.get(workflowId) ?? defaultSpec();

      // 5xx burn-down
      const burnt = served5xxByWf.get(workflowId) ?? 0;
      if (spec.force5xxCount > burnt) {
        served5xxByWf.set(workflowId, burnt + 1);
        stats.served5xx += 1;
        res.statusCode = 503;
        res.setHeader('Retry-After', '1');
        res.end('mock transient');
        return;
      }

      // One-time 404
      const four04Burnt = served404ByWf.get(workflowId) ?? 0;
      if (spec.force404Once && four04Burnt === 0) {
        served404ByWf.set(workflowId, 1);
        stats.served404 += 1;
        res.statusCode = 404;
        res.end('mock workflow gone');
        return;
      }

      // Payment gate
      if (spec.force402 && !paid.has(idempotencyKey)) {
        stats.paid402 += 1;
        const challenge: X402Challenge = {
          url: FACILITATOR_URL,
          amount: '100000', // 0.10 USDC at 6 dp
          tokenAddress: USDC_BASE,
          chainId: 8453,
          payTo: TREASURER_EOA,
        };
        respond(res, 402, challenge);
        return;
      }

      // Success
      respond(res, 200, {
        jsonrpc: '2.0',
        id: env.id,
        result: {
          status: 'settled',
          execution_id: `exec_${randomBytes(6).toString('hex')}`,
          attestation_tx: `0x${randomBytes(32).toString('hex')}`,
        },
      });
      return;
    }

    respond(res, 400, {
      jsonrpc: '2.0',
      id: env.id,
      error: { code: -32601, message: `unknown tool ${name}` },
    });
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      // Defensive: any throw inside handler must surface as 500, never crash.
      // eslint-disable-next-line no-console
      console.error('[mock-kh] handler error:', e);
      try {
        res.statusCode = 500;
        res.end('mock handler error');
      } catch {
        /* socket already closed */
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('mock-kh: failed to bind');
  }
  const boundPort = addr.port;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    markPaid: (idempotencyKey: string) => {
      paid.add(idempotencyKey);
    },
    setSpec: (workflowId, partial) => {
      const existing = specs.get(workflowId) ?? defaultSpec();
      specs.set(workflowId, { ...existing, ...partial });
    },
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function defaultSpec(): CallSpec {
  return { force402: true, force404Once: false, force5xxCount: 0 };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 8);
}
