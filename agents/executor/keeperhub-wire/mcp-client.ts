// keeperhub-wire/mcp-client.ts
// Minimal MCP client for the KeeperHub MCP server.
//
// Transport: JSON-RPC 2.0 over HTTP POST. KH exposes its MCP behind a stable
// HTTPS endpoint that accepts `tools/call` requests with two tool names of
// interest to QUORUM: `search_workflows` and `call_workflow`.
//
// Session lifecycle (KH MCP spec, 2024-11-05):
//   1. First call → POST `initialize` with protocolVersion + clientInfo.
//      Server replies 200 with `mcp-session-id` response header (JWT).
//   2. All subsequent JSON-RPC calls echo that header back.
//   3. On 401 we assume the session expired, drop it, re-init once, retry.
//
//   Auth-less mode (mock server, tests) skips initialize entirely — the mock
//   does not implement the handshake and we keep the wire's existing failure
//   surface unchanged in stub mode.
//
// Why not the @modelcontextprotocol/sdk client?
//   We only need two tool calls and a tight failure surface (typed retry,
//   typed 402 surfacing, typed 404 → cache invalidation). Hand-rolling 80
//   lines of JSON-RPC keeps the dependency tree shallow and lets us shape
//   errors exactly the way the rest of the wire wants to consume them.
//
// Failure-mode contract:
//   - HTTP 402 surfaces as McpPaymentRequired with the parsed challenge.
//   - HTTP 404 surfaces as McpWorkflowNotFound (cache layer drops + re-searches).
//   - HTTP 5xx surfaces as McpTransientError (caller retries with same idem key).
//   - HTTP 401 → drop session, re-init once, retry. Second 401 → McpInvalidInput.
//   - JSON-RPC error.code -32602 (invalid params) surfaces as McpInvalidInput.

import { z } from 'zod';

import {
  CallWorkflowResultSchema,
  WorkflowSearchResultSchema,
  X402ChallengeSchema,
  type CallWorkflowResult,
  type KeeperHubWireConfig,
  type WorkflowSearchResult,
  type X402Challenge,
} from './types';

// ---------------------------------------------------------------------------
// Typed error classes
// ---------------------------------------------------------------------------

export class McpPaymentRequired extends Error {
  constructor(public readonly challenge: X402Challenge) {
    super(`KH MCP returned 402: ${challenge.amount} @ ${challenge.url}`);
    this.name = 'McpPaymentRequired';
  }
}

export class McpWorkflowNotFound extends Error {
  constructor(public readonly workflowId: string) {
    super(`KH MCP 404 for workflow id=${workflowId}`);
    this.name = 'McpWorkflowNotFound';
  }
}

export class McpTransientError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'McpTransientError';
  }
}

export class McpInvalidInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpInvalidInput';
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

interface ToolCallParams {
  name: 'search_workflows' | 'call_workflow';
  arguments: Record<string, unknown>;
  /** Idempotency-Key per FEEDBACK item 4. */
  idempotencyKey?: string;
}

const MCP_PROTOCOL_VERSION = '2024-11-05';
const ACCEPT_HEADER = 'application/json, text/event-stream';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class KeeperHubMcpClient {
  private rpcId = 1;
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly cfg: KeeperHubWireConfig) {
    if (!cfg.mcpEndpoint || !/^https?:\/\//.test(cfg.mcpEndpoint)) {
      throw new Error(
        `KeeperHubMcpClient: invalid mcpEndpoint=${cfg.mcpEndpoint}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // search_workflows
  // -------------------------------------------------------------------------

  async searchWorkflows(query: string): Promise<WorkflowSearchResult> {
    const raw = await this.tool({
      name: 'search_workflows',
      arguments: { query },
    });
    const parsed = WorkflowSearchResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new McpInvalidInput(
        `search_workflows: malformed response (${parsed.error.message})`,
      );
    }
    return parsed.data;
  }

  // -------------------------------------------------------------------------
  // call_workflow
  // -------------------------------------------------------------------------

  async callWorkflow(args: {
    workflowId: string;
    /** KH-side invocation handle (listedSlug). Falls back to workflowId. */
    slug?: string;
    input: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<CallWorkflowResult> {
    const slug = args.slug ?? args.workflowId;
    // Send both the spec-compliant fields (slug/inputs — what real KH expects)
    // AND the legacy fields (workflow_id/input — what the in-process mock keys
    // off). Real KH ignores the extras silently; mock ignores the new ones if
    // it's not yet updated. Cheap belt-and-braces compatibility.
    const raw = await this.tool({
      name: 'call_workflow',
      arguments: {
        slug,
        inputs: args.input,
        workflow_id: args.workflowId,
        input: args.input,
      },
      idempotencyKey: args.idempotencyKey,
    });
    const parsed = CallWorkflowResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new McpInvalidInput(
        `call_workflow: malformed response (${parsed.error.message})`,
      );
    }
    return parsed.data;
  }

  // -------------------------------------------------------------------------
  // Internal: session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Lazy initialise the MCP session. No-op when no auth token configured
   * (test mock path) — the mock server does not implement initialize and
   * keeping the call out preserves the existing test surface.
   *
   * Concurrency: parallel callers share a single in-flight init promise so
   * we never fire two initialize handshakes against the server.
   */
  private async ensureSession(): Promise<void> {
    if (!this.cfg.mcpAuthToken) return;
    if (this.sessionId) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.initialize().finally(() => {
      this.initPromise = null;
    });
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const body = {
      jsonrpc: '2.0' as const,
      id: this.rpcId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'quorum-executor', version: '0.2.0' },
      },
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: ACCEPT_HEADER,
      Authorization: `Bearer ${this.cfg.mcpAuthToken}`,
    };

    let res: Response;
    try {
      res = await fetch(this.cfg.mcpEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new McpTransientError(
        `initialize network error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 401 on initialize means the bearer token itself is bad — not a
      // session expiry, so don't dress it up as transient.
      if (res.status === 401) {
        throw new McpInvalidInput(
          `initialize 401 invalid_token: ${text.slice(0, 200)}`,
        );
      }
      if (res.status >= 500) {
        throw new McpTransientError(
          `initialize ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      throw new McpInvalidInput(
        `initialize ${res.status}: ${text.slice(0, 300)}`,
      );
    }

    const sid = res.headers.get('mcp-session-id');
    if (!sid) {
      throw new McpInvalidInput(
        'initialize succeeded but server returned no mcp-session-id header',
      );
    }
    // Drain body to free the connection. We don't strictly need to parse it
    // — the contract is "200 + session-id header" per the KH spec.
    await drainResponse(res);
    this.sessionId = sid;
  }

  // -------------------------------------------------------------------------
  // Internal: tool call → JSON-RPC POST
  // -------------------------------------------------------------------------

  private async tool(params: ToolCallParams): Promise<unknown> {
    await this.ensureSession();
    try {
      return await this.toolOnce(params);
    } catch (e) {
      // Session-expiry path: drop the cached session id and try once more.
      // Only retries when we have a token (no token ⇒ no session ⇒ no expiry).
      if (e instanceof SessionExpired && this.cfg.mcpAuthToken) {
        this.sessionId = null;
        await this.ensureSession();
        return await this.toolOnce(params);
      }
      throw e;
    }
  }

  private async toolOnce(params: ToolCallParams): Promise<unknown> {
    const body = {
      jsonrpc: '2.0' as const,
      id: this.rpcId++,
      method: 'tools/call',
      params: {
        name: params.name,
        arguments: params.arguments,
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: ACCEPT_HEADER,
    };
    if (this.cfg.mcpAuthToken) {
      headers.Authorization = `Bearer ${this.cfg.mcpAuthToken}`;
    }
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }
    if (params.idempotencyKey) {
      // FEEDBACK item 4 — server may not yet honour, we send it anyway so
      // logs show our intent and so the day KH ships server-side dedupe we
      // pick it up for free.
      headers['Idempotency-Key'] = params.idempotencyKey;
    }

    let res: Response;
    try {
      res = await fetch(this.cfg.mcpEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new McpTransientError(
        `network error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // 401: session expired (or token revoked). The outer tool() decides
    // whether to retry — we just signal via SessionExpired.
    if (res.status === 401) {
      await drainResponse(res);
      throw new SessionExpired();
    }

    // 402: parse challenge from body. KH wraps the challenge under a stable
    // shape; treat any non-conformant body as transient so we don't burn the
    // idempotency slot on garbage.
    if (res.status === 402) {
      const challengeJson = await readJsonOrSse(res);
      const parsed = X402ChallengeSchema.safeParse(challengeJson);
      if (!parsed.success) {
        throw new McpTransientError(
          `402 with malformed challenge: ${parsed.error?.message ?? 'no body'}`,
        );
      }
      throw new McpPaymentRequired(parsed.data);
    }

    if (res.status === 404) {
      const wid =
        typeof params.arguments.workflow_id === 'string'
          ? params.arguments.workflow_id
          : '<unknown>';
      throw new McpWorkflowNotFound(wid);
    }

    if (res.status >= 500) {
      const retryHdr = res.headers.get('Retry-After');
      const retryAfterMs = retryHdr ? Number(retryHdr) * 1000 : undefined;
      throw new McpTransientError(
        `KH MCP ${res.status}`,
        Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new McpInvalidInput(`KH MCP ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await readJsonOrSse(res);
    const env = JsonRpcResponseSchema.safeParse(json);
    if (!env.success) {
      throw new McpInvalidInput(`malformed JSON-RPC envelope`);
    }
    if (env.data.error) {
      const { code, message } = env.data.error;
      if (code === -32602) throw new McpInvalidInput(message);
      throw new McpTransientError(`JSON-RPC ${code}: ${message}`);
    }
    return unwrapMcpToolResult(env.data.result);
  }
}

/**
 * Real KH MCP wraps tool results per the MCP spec:
 *   { content: [{ type: "text", text: "<JSON-string>" }], isError?: boolean }
 * The in-process mock returns the inner shape directly. We accept either.
 *
 * If isError is true, the inner text is an error string (not JSON). Surface
 * as McpInvalidInput so the wire bails out cleanly.
 */
function unwrapMcpToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.content)) return result;
  const first = r.content[0];
  if (!first || typeof first !== 'object') return result;
  const f = first as Record<string, unknown>;
  if (f.type !== 'text' || typeof f.text !== 'string') return result;

  if (r.isError === true) {
    // KH packs validation/runtime errors here (`-32602` style messages).
    throw new McpInvalidInput(`KH tool error: ${f.text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(f.text);
  } catch (e) {
    throw new McpInvalidInput(
      `MCP tool result text was not JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Internal sentinel — never escapes the client. */
class SessionExpired extends Error {
  constructor() {
    super('mcp session expired (401)');
    this.name = 'SessionExpired';
  }
}

/**
 * Read response body as JSON, transparently unwrapping SSE framing.
 *
 * KH MCP advertises `Accept: application/json, text/event-stream` and chooses
 * per-request: small payloads come back as plain JSON, larger / streamable
 * payloads as SSE (`data: <json>` lines, terminated by a blank line). For the
 * tools we call the response is always a single JSON-RPC envelope, so we
 * just take the last `data:` line if SSE, else parse the whole body.
 */
async function readJsonOrSse(res: Response): Promise<unknown> {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((l) => l.length > 0);
    if (dataLines.length === 0) return null;
    // Last data line wins (server may emit progress frames before the final
    // result). Bad framing surfaces as JSON.parse throwing → caller maps to
    // McpInvalidInput.
    return JSON.parse(dataLines[dataLines.length - 1]);
  }
  if (text.length === 0) return null;
  return JSON.parse(text);
}

async function drainResponse(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    /* socket already closed — nothing to drain */
  }
}
