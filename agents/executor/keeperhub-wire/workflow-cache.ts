// keeperhub-wire/workflow-cache.ts
// 6h TTL cache over resolved KH workflow ids, with re-search on first 404.
//
// Why this layer exists: FEEDBACK item 1 — KH's workflow `id` field is not
// guaranteed stable across the workflow author's republishes. Caching across a
// long-lived Executor process is a footgun without an explicit invalidation
// path. This module gives Executor:
//
//   1. A boot-time resolved id (search once, cache 6h)
//   2. A single-shot invalidation hook that the MCP client calls when it gets
//      a 404 on `call_workflow` — the next resolve() goes back to the wire
//   3. A hard ceiling (6h) so even if KH never 404s, we periodically re-verify
//
// Concurrency note: the resolver promise is memoised so a thundering herd of
// verdicts on cache miss collapses to one search call. After that they all
// observe the same result.

import type { KeeperHubMcpClient } from './mcp-client';
import type { WorkflowSearchHit } from './types';

interface CacheEntry {
  hit: WorkflowSearchHit;
  /** epoch ms when the entry was resolved. */
  resolvedAt: number;
}

export class WorkflowIdCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<WorkflowSearchHit>>();

  constructor(
    private readonly mcp: KeeperHubMcpClient,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Resolve a logical workflow query to a current KH workflow id.
   * `query` is the discovery string Executor uses (e.g. "quorum-attest-v1").
   *
   * Returns the cached hit if fresh, otherwise issues one `search_workflows`
   * and caches the first result. Throws if KH returns zero hits.
   */
  async resolve(query: string): Promise<WorkflowSearchHit> {
    const fresh = this.lookupFresh(query);
    if (fresh) return fresh;

    // Collapse concurrent misses
    const pending = this.inFlight.get(query);
    if (pending) return pending;

    const p = this.searchAndCache(query).finally(() => {
      this.inFlight.delete(query);
    });
    this.inFlight.set(query, p);
    return p;
  }

  /**
   * Drop the cache entry whose `id` matches `workflowId`. Called by the wire
   * orchestrator when call_workflow surfaces McpWorkflowNotFound.
   *
   * After invalidation, the next `resolve(query)` triggers a re-search. We
   * key invalidation by id rather than query because the orchestrator only
   * holds the id at the moment of failure; iterating entries is fine at our
   * scale (single-digit registered workflows).
   */
  invalidateById(workflowId: string): void {
    for (const [k, v] of this.entries) {
      if (v.hit.id === workflowId) {
        this.entries.delete(k);
        return;
      }
    }
  }

  /** Test/debug helper — not used by the wire itself. */
  size(): number {
    return this.entries.size;
  }

  private lookupFresh(query: string): WorkflowSearchHit | null {
    const e = this.entries.get(query);
    if (!e) return null;
    if (this.now() - e.resolvedAt > this.ttlMs) {
      this.entries.delete(query);
      return null;
    }
    return e.hit;
  }

  private async searchAndCache(query: string): Promise<WorkflowSearchHit> {
    const result = await this.mcp.searchWorkflows(query);
    if (result.hits.length === 0) {
      throw new Error(`workflow-cache: zero hits for query=${query}`);
    }
    const hit = result.hits[0]!;
    this.entries.set(query, { hit, resolvedAt: this.now() });
    return hit;
  }
}
