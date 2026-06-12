/**
 * `usme memory assemble "query"`
 *
 * Simulates the runtime injection path as closely as practical. It reuses the
 * exact same @usme/core primitives the hot path uses, composed in the same order
 * as coreAssemble() (see packages/usme-core/src/assemble/index.ts):
 *
 *   retrieve -> spreading activation -> score -> critic -> minInclusionScore -> pack
 *
 * plus the same separate constraints query the plugin runs. Composing the
 * primitives (rather than calling coreAssemble directly) lets the workbench expose
 * per-candidate scores and rejection reasons without duplicating any scoring or
 * retrieval logic.
 *
 * READ-ONLY: unlike the live plugin, this deliberately does NOT call
 * bumpAccessCounts — a dry-run never perturbs access/recency signals.
 */

import {
  scoreCandidates,
  criticFilter,
  pack,
  resolveMode,
  MODE_PROFILES,
} from "@usme/core";
import type {
  AssemblyMode,
  AssemblyModeProfile,
  ScoredCandidate,
  RetrievalCandidate,
  MemoryTier,
} from "@usme/core";
import { spreadingActivation } from "usme-claw/spread";
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

/** Per-mode request token budget, matching the plugin's assembly.modes config. */
const MODE_TOKEN_BUDGET: Record<AssemblyMode, number> = {
  "psycho-genius": 50_000,
  brilliant: 30_000,
  "smart-efficient": 15_000,
};

interface Constraint {
  pattern: string;
  content: string;
}

export async function runAssemble(args: ParsedArgs): Promise<void> {
  const query = args.positionals[0];
  if (!query) throw new Error('assemble requires a query: usme memory assemble "your query"');

  const json = bool(args.values, "json");
  const full = bool(args.values, "full");
  const previewLen = num(args.values, "preview");
  const showScores = bool(args.values, "show-scores");
  const showRejected = bool(args.values, "show-rejected");
  const includeConstraints = bool(args.values, "include-constraints");
  const debug = createDebugLogger(args);

  const mode = (str(args.values, "mode") ?? "brilliant") as AssemblyMode;
  if (!MODE_PROFILES[mode]) {
    throw new Error(
      `Unknown mode "${mode}". Valid: ${Object.keys(MODE_PROFILES).join(", ")}`,
    );
  }

  // Build mode-profile overrides from explicit flags (flags override the preset).
  const overrides: Partial<AssemblyModeProfile> = {};
  const tiersFlag = str(args.values, "tiers");
  if (tiersFlag) overrides.tiersEnabled = resolveTiers(args.values);
  const topK = num(args.values, "top-k-per-tier");
  if (topK !== undefined) overrides.candidatesPerTier = topK;
  const minScore = num(args.values, "min-score");
  if (minScore !== undefined) overrides.minInclusionScore = minScore;
  const minConfidence = num(args.values, "min-confidence");
  if (minConfidence !== undefined) overrides.minConfidence = minConfidence;

  const profile = resolveMode(mode, overrides);
  const tokenBudget = num(args.values, "token-budget") ?? MODE_TOKEN_BUDGET[mode];
  const memoryBudget = Math.floor(tokenBudget * profile.tokenBudgetFraction);
  const minSimilarity = num(args.values, "min-similarity");
  const spreadingDepth = num(args.values, "spreading-depth") ?? 2;
  const tierTimeoutMs = num(args.values, "tier-timeout-ms") ?? 500;
  if (tierTimeoutMs <= 0) throw new Error("--tier-timeout-ms must be greater than 0");

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

  // ── Mirror of coreAssemble (assemble/index.ts), with introspection ──────────
  let candidates: RetrievalCandidate[] = await retrieveForCli({
    pool: db.pool,
    queryEmbedding,
    tiers: profile.tiersEnabled,
    topK: profile.candidatesPerTier,
    tierTimeoutMs,
    debug,
  });
  const retrievedCount = candidates.length;

  let spreadingMetrics:
    | { entitiesMatched: number; episodesAdded: number; spreadDepth: number }
    | undefined;
  if (spreadingDepth > 0) {
    const spread = await debug.duration(
      "spreading",
      () =>
        spreadingActivation(candidates, db.pool, {
          maxDepth: spreadingDepth,
          maxAdditional: 10,
        }),
      { depth: spreadingDepth, before: candidates.length },
    );
    candidates = spread.candidates;
    spreadingMetrics = {
      entitiesMatched: spread.metrics.entitiesMatched,
      episodesAdded: spread.metrics.episodesAdded,
      spreadDepth: spread.metrics.spreadDepth,
    };
    debug.log("spreading.counts", {
      before: retrievedCount,
      after: candidates.length,
      entitiesMatched: spreadingMetrics.entitiesMatched,
      episodesAdded: spreadingMetrics.episodesAdded,
    });
  }

  const afterSpreadingCount = candidates.length;
  if (minSimilarity !== undefined) {
    candidates = candidates.filter((c) => c.similarity >= minSimilarity);
  }
  debug.log("filter.similarity", {
    before: afterSpreadingCount,
    after: candidates.length,
    minSimilarity,
  });

  const scored = scoreCandidates(candidates, queryEmbedding);
  debug.log("scoring.end", { candidates: candidates.length, scored: scored.length });
  const filtered = criticFilter(scored, { minConfidence: profile.minConfidence });
  debug.log("filter.critic", {
    before: scored.length,
    after: filtered.length,
    minConfidence: profile.minConfidence,
  });
  const eligible = filtered.filter((c) => c.score >= profile.minInclusionScore);
  debug.log("filter.minScore", {
    before: filtered.length,
    after: eligible.length,
    minScore: profile.minInclusionScore,
  });
  const packed = pack(eligible, memoryBudget);
  debug.log("packing.end", {
    before: eligible.length,
    after: packed.length,
    memoryBudget,
    tokens: packed.reduce((sum, p) => sum + p.tokenCount, 0),
  });
  const packedIds = new Set(packed.map((p) => p.id));

  // Selected = scored items that survived all the way into the pack (score order).
  const scoredById = new Map(scored.map((s) => [s.id, s]));
  let selected: ScoredCandidate[] = packed
    .map((p) => scoredById.get(p.id))
    .filter((s): s is ScoredCandidate => s !== undefined);

  // Final caps (post-selection): --tier-limit and --limit
  const tierLimits = resolveTierLimits(args.values);
  const globalLimit = num(args.values, "limit");
  const limitResult = applyTierAndGlobalLimitsDetailed(selected, tierLimits, globalLimit);
  debug.log("limits.applied", {
    before: limitResult.before,
    afterTierLimits: limitResult.afterTierLimits,
    afterGlobalLimit: limitResult.afterGlobalLimit,
    tierLimits,
    globalLimit,
  });
  selected = limitResult.items;

  // Rejection reasons for --show-rejected (no critic-internals duplication).
  const filteredIds = new Set(filtered.map((f) => f.id));
  const rejected = scored
    .filter((s) => !packedIds.has(s.id))
    .map((s) => ({
      candidate: s,
      reason: !filteredIds.has(s.id)
        ? ("critic_filtered" as const)
        : s.score < profile.minInclusionScore
          ? ("below_min_score" as const)
          : ("budget_exceeded" as const),
    }));

  // Constraints (always injected separately at runtime).
  let constraints: Constraint[] = [];
  if (includeConstraints) {
    const { rows } = await debug.duration(
      "constraints.fetch",
      () =>
        db.pool.query<Constraint>(
          `SELECT pattern, content FROM constraints
           WHERE dismissed_at IS NULL
           ORDER BY created_at DESC
           LIMIT 10`,
        ),
    );
    constraints = rows;
  }
  debug.log("constraints.count", { count: constraints.length, fetched: includeConstraints });

  const tokensUsed = selected.reduce((sum, s) => sum + s.tokenCount, 0);
  const tiersQueried = [...new Set(candidates.map((c) => c.tier))] as MemoryTier[];

  if (json) {
    emitJson({
      command: "assemble",
      query,
      db: { source: db.source },
      mode,
      profile: {
        tiersEnabled: profile.tiersEnabled,
        candidatesPerTier: profile.candidatesPerTier,
        tierTimeoutMs,
        minInclusionScore: profile.minInclusionScore,
        minConfidence: profile.minConfidence,
        tokenBudgetFraction: profile.tokenBudgetFraction,
      },
      budget: { requestTokenBudget: tokenBudget, memoryBudget, tokensUsed },
      spreading: { depth: spreadingDepth, ...spreadingMetrics },
      counts: {
        candidates: candidates.length,
        eligible: eligible.length,
        selected: selected.length,
      },
      constraints,
      selected: selected.map(toJsonItem),
      rejected: showRejected
        ? rejected.map((r) => ({ ...toJsonItem(r.candidate), reason: r.reason }))
        : undefined,
    });
    return;
  }

  // ── Human-readable ──────────────────────────────────────────────────────────
  line();
  line(`USME assemble — simulated runtime injection`);
  line(`  query:    "${query}"`);
  line(`  mode:     ${mode}  tiers: ${profile.tiersEnabled.join(",")}`);
  line(
    `  budget:   request ${tokenBudget} tok × ${profile.tokenBudgetFraction} = ${memoryBudget} memory-budget; used ${tokensUsed}`,
  );
  line(
    `  pipeline: ${candidates.length} candidates → ${eligible.length} eligible → ${selected.length} selected`,
  );
  if (spreadingMetrics) {
    line(
      `  spreading: depth ${spreadingDepth}, entities matched ${spreadingMetrics.entitiesMatched}, episodes added ${spreadingMetrics.episodesAdded}`,
    );
  }

  if (includeConstraints) {
    line();
    line(`[constraints] (${constraints.length}, always injected separately)`);
    if (constraints.length === 0) line(`  (none active)`);
    for (const c of constraints) line(`  ${c.pattern}: ${c.content}`);
  }

  line();
  line(`Selected memories (${selected.length}):`);
  if (selected.length === 0) line(`  (none)`);
  for (const s of selected) printItem(s, { full, previewLen, showScores });

  if (showRejected) {
    line();
    line(`Rejected candidates (${rejected.length}):`);
    for (const r of rejected) {
      printItem(r.candidate, { full, previewLen, showScores }, r.reason);
    }
  }
  line();
}

function printItem(
  s: ScoredCandidate,
  opts: { full?: boolean; previewLen?: number; showScores?: boolean },
  reason?: string,
): void {
  const header =
    `  • [${s.tier}] ${s.id}  score:${fmt(s.score)} (${relevanceLabel(s.score)})` +
    `  ${isoDate(s.createdAt)}  ${s.tokenCount}tok` +
    (reason ? `  REJECTED:${reason}` : "");
  line(header);
  if (opts.showScores) line(`      ${formatBreakdown(s.scoreBreakdown)}`);
  line(`      ${preview(s.content, opts)}`);
}

function toJsonItem(s: ScoredCandidate) {
  return {
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
  };
}
