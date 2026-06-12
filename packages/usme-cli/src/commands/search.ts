/**
 * `usme memory search "query"`
 *
 * Semantic ANN search across memory tiers with transparent relevance metadata.
 * Unlike `assemble`, it does NOT apply the critic filter or token packing — it is
 * a ranked relevance view answering "what is semantically relevant, and why?".
 *
 * Reuses @usme/core retrieve() + scoreCandidates(); applies CLI-level thresholds
 * and per-tier / global caps. READ-ONLY.
 */

import { scoreCandidates } from "@usme/core";
import type { ScoredCandidate, MemoryTier } from "@usme/core";
import type { ParsedArgs } from "../parse.js";
import {
  str,
  num,
  bool,
  resolveTiers,
  resolveTierLimits,
  applyTierAndGlobalLimitsDetailed,
} from "../parse.js";
import { resolveDb, redactConnString } from "../db.js";
import { embedQuery } from "../embed.js";
import { createDebugLogger } from "../debug.js";
import { retrieveForCli } from "../retrieve.js";
import {
  preview,
  relevanceLabel,
  formatBreakdown,
  fmt,
  isoDate,
  emitJson,
  line,
  meta,
} from "../format.js";

export async function runSearch(args: ParsedArgs): Promise<void> {
  const query = args.positionals[0];
  if (!query) throw new Error('search requires a query: usme memory search "your query"');

  const json = bool(args.values, "json");
  const full = bool(args.values, "full");
  const previewLen = num(args.values, "preview");
  const showScores = bool(args.values, "show-scores");
  const debug = createDebugLogger(args);

  const tiers = resolveTiers(args.values);
  const topK = num(args.values, "top-k-per-tier") ?? 20;
  const tierTimeoutMs = num(args.values, "tier-timeout-ms") ?? 500;
  if (tierTimeoutMs <= 0) throw new Error("--tier-timeout-ms must be greater than 0");
  const minScore = num(args.values, "min-score");
  const minSimilarity = num(args.values, "min-similarity");
  const tierLimits = resolveTierLimits(args.values);
  const globalLimit = num(args.values, "limit");

  const db = resolveDb(str(args.values, "database-url"));
  debug.log("db.resolved", {
    source: db.source,
    connectionString: redactConnString(db.connectionString),
  });
  if (!json) {
    meta(`DB: ${redactConnString(db.connectionString)} (source: ${db.source})`);
    meta(`Embedding query…`);
  }

  const queryEmbedding = await debug.duration("embedding.query", () => embedQuery(query), {
    queryChars: query.length,
  });

  let candidates = await retrieveForCli({
    pool: db.pool,
    queryEmbedding,
    tiers,
    topK,
    tierTimeoutMs,
    debug,
  });
  const retrievedCount = candidates.length;

  if (minSimilarity !== undefined) {
    candidates = candidates.filter((c) => c.similarity >= minSimilarity);
  }
  debug.log("filter.similarity", {
    before: retrievedCount,
    after: candidates.length,
    minSimilarity,
  });

  let scored: ScoredCandidate[] = scoreCandidates(candidates, queryEmbedding);
  debug.log("scoring.end", { candidates: candidates.length, scored: scored.length });
  const scoredCount = scored.length;
  if (minScore !== undefined) scored = scored.filter((s) => s.score >= minScore);
  debug.log("filter.score", { before: scoredCount, after: scored.length, minScore });

  // Rank by composite score descending, then apply caps.
  scored.sort((a, b) => b.score - a.score);
  const limitResult = applyTierAndGlobalLimitsDetailed(scored, tierLimits, globalLimit);
  debug.log("limits.applied", {
    before: limitResult.before,
    afterTierLimits: limitResult.afterTierLimits,
    afterGlobalLimit: limitResult.afterGlobalLimit,
    tierLimits,
    globalLimit,
  });
  const results = limitResult.items;

  if (json) {
    emitJson({
      command: "search",
      query,
      db: { source: db.source },
      tiers,
      topKPerTier: topK,
      tierTimeoutMs,
      thresholds: { minScore, minSimilarity },
      counts: { retrieved: retrievedCount, filtered: candidates.length, returned: results.length },
      results: results.map((s) => ({
        id: s.id,
        tier: s.tier,
        score: s.score,
        similarity: s.similarity,
        relevance: relevanceLabel(s.score),
        tokenCount: s.tokenCount,
        createdAt: s.createdAt,
        provenanceKind: s.provenanceKind,
        scoreBreakdown: s.scoreBreakdown,
        content: s.content,
      })),
    });
    return;
  }

  line();
  line(`USME search — semantic relevance`);
  line(`  query: "${query}"  tiers: ${tiers.join(",")}  top-k/tier: ${topK}`);
  line(`  retrieved ${retrievedCount} → returning ${results.length}`);
  line();
  if (results.length === 0) line(`  (no results)`);
  const byTier = countByTier(results);
  for (const [tier, n] of Object.entries(byTier)) meta(`  ${tier}: ${n}`);
  for (const s of results) {
    line(
      `  • [${s.tier}] ${s.id}  score:${fmt(s.score)} (${relevanceLabel(s.score)})  sim:${fmt(s.similarity)}  ${isoDate(s.createdAt)}`,
    );
    if (showScores) line(`      ${formatBreakdown(s.scoreBreakdown)}`);
    line(`      ${preview(s.content, { full, previewLen })}`);
  }
  line();
}

function countByTier(items: { tier: MemoryTier }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.tier] = (out[i.tier] ?? 0) + 1;
  return out;
}
