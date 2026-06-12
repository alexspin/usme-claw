import { retrieve } from "@usme/core";
import type { MemoryTier, RetrievalCandidate } from "@usme/core";
import { performance } from "node:perf_hooks";
import type pg from "pg";
import type { DebugLogger } from "./debug.js";

export interface CliRetrieveOptions {
  pool: pg.Pool;
  queryEmbedding: number[];
  tiers: MemoryTier[];
  topK: number;
  tierTimeoutMs: number;
  debug: DebugLogger;
}

export async function retrieveForCli(opts: CliRetrieveOptions): Promise<RetrievalCandidate[]> {
  const { pool, queryEmbedding, tiers, topK, tierTimeoutMs, debug } = opts;
  debug.log("retrieval.start", { tiers, topK, tierTimeoutMs });
  const started = performance.now();

  const tierResults = await Promise.all(
    tiers.map(async (tier) => {
      const tierStarted = performance.now();
      debug.log("retrieval.tier.start", { tier, topK, tierTimeoutMs });
      try {
        const candidates = await retrieve({
          pool,
          queryEmbedding,
          tiers: [tier],
          topK,
          tierTimeoutMs,
        });
        const durationMs = Math.round(performance.now() - tierStarted);
        debug.log("retrieval.tier.end", {
          tier,
          requestedTopK: topK,
          count: candidates.length,
          timeoutMs: tierTimeoutMs,
          durationMs,
          possibleTimeout: candidates.length === 0 && durationMs >= tierTimeoutMs,
        });
        return candidates;
      } catch (err) {
        debug.log("retrieval.tier.error", {
          tier,
          requestedTopK: topK,
          timeoutMs: tierTimeoutMs,
          durationMs: Math.round(performance.now() - tierStarted),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }),
  );

  const candidates = tierResults.flat();
  debug.log("retrieval.end", {
    tiers: tiers.length,
    count: candidates.length,
    durationMs: Math.round(performance.now() - started),
  });
  return candidates;
}
