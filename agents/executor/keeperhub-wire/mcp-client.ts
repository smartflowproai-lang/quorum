// keeperhub-wire/mcp-client.ts
// Minimal MCP client for the KeeperHub MCP server.
//
// Transport: JSON-RPC 2.0 over HTTP POST. KH exposes its MCP behind a stable
// HTTPS endpoint that accepts `tools/call` requests with two tool names of
// interest to QUORUM: `search_workflows` and `call_workflow`.
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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class KeeperHubMcpClient {
  private rpcId = 1;

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
    input: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<CallWorkflowResult> {
    const raw = await this.tool({
      name: 'call_workflow',
      arguments: {
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
  // Internal: tool call → JSON-RPC POST
  // -------------------------------------------------------------------------

  private async tool(params: ToolCallParams): Promise<unknown> {
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
      Accept: 'application/json',
    };
    if (this.cfg.mcpAuthToken) {
      headers.Authorization = `Bearer ${this.cfg.mcpAuthToken}`;
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

    // 402: parse challenge from body. KH wraps the challenge under a stable
    // shape; treat any non-conformant body as transient so we don't burn the
    // idempotency slot on garbage.
    if (res.status === 402) {
      const challengeJson = await res.json().catch(() => null);
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

    const json = await res.json().catch(() => null);
    const env = JsonRpcResponseSchema.safeParse(json);
    if (!env.success) {
      throw new McpInvalidInput(`malformed JSON-RPC envelope`);
    }
    if (env.data.error) {
      const { code, message } = env.data.error;
      if (code === -32602) throw new McpInvalidInput(message);
      throw new McpTransientError(`JSON-RPC ${code}: ${message}`);
    }
    return env.data.result;
  }
}
