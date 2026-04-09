/**
 * assemble() -- hot path orchestrator.
 *
 * Pipeline: retrieve -> score -> critic -> pack
 * Read-only: NEVER writes to DB.
 * P95 target: 150ms.
 */

import type { Pool } from "pg";
import type {
  AssembleRequest,
  AssembleResult,
  AssembleMetadata,
  AssemblyModeProfile,
  InjectedMemory,
  MemoryTier,
} from "./types.js";
import { retrieve } from "./retrieve.js";
import { scoreCandidates } from "./score.js";
import { criticFilter } from "./critic.js";
import { pack } from "./pack.js";
import { resolveMode } from "./modes.js";

export interface SpreadingActivationPass {
  run: (
    candidates: import('./types.js').RetrievalCandidate[],
    pool: Pool,
  ) => Promise<{
    candidates: import('./types.js').RetrievalCandidate[];
    metrics: {
      initialCount: number;
      entitiesMatched: number;
      connectedEntities: number;
      episodesAdded: number;
      spreadDepth: number;
      durationMs: number;
    };
  }>;
}

export interface AssembleOptions {
  pool: Pool;
  queryEmbedding: number[];
  modeOverrides?: Partial<AssemblyModeProfile>;
  spreadingPass?: SpreadingActivationPass;
}

/**
 * Main assembly entry point. Orchestrates the full hot path pipeline:
 * retrieve candidates -> score -> critic filter -> greedy pack.
 *
 * Returns selected memory items and metadata for logging/shadow comparison.
 */
export async function assemble(
  request: AssembleRequest,
  options: AssembleOptions,
): Promise<AssembleResult> {
  const start = performance.now();

  const profile = resolveMode(request.mode, options.modeOverrides);
  const memoryBudget = Math.floor(request.tokenBudget * profile.tokenBudgetFraction);

  // 1. Retrieve: parallel ANN across enabled tiers
  let candidates = await retrieve({
    pool: options.pool,
    queryEmbedding: options.queryEmbedding,
    tiers: profile.tiersEnabled,
    topK: profile.candidatesPerTier,
  });

  // 1b. Spreading activation (optional second pass via entity graph)
  let spreadingMetrics: {
    initialCount: number;
    entitiesMatched: number;
    connectedEntities: number;
    episodesAdded: number;
    spreadDepth: number;
    durationMs: number;
  } | undefined;
  if (options.spreadingPass) {
    const spreadResult = await options.spreadingPass.run(candidates, options.pool);
    candidates = spreadResult.candidates;
    spreadingMetrics = spreadResult.metrics;
  }

  // 2. Score: weighted formula per candidate
  const scored = scoreCandidates(candidates, options.queryEmbedding);

  // 3. Critic: rule-based filter
  const filtered = criticFilter(scored, {
    minConfidence: profile.minConfidence,
  });

  // 4. Apply minimum inclusion score
  const eligible = filtered.filter((c) => c.score >= profile.minInclusionScore);

  // 5. Pack: greedy token-budget packing
  const selected = pack(eligible, memoryBudget);

  const durationMs = performance.now() - start;

  const tiersQueried = [...new Set(candidates.map((c) => c.tier))] as MemoryTier[];

  const metadata: AssembleMetadata & { spreadingMetrics?: typeof spreadingMetrics } = {
    itemsConsidered: candidates.length,
    itemsSelected: selected.length,
    tiersQueried,
    durationMs,
    mode: request.mode,
    tokenBudget: memoryBudget,
    tokensUsed: selected.reduce((sum, item) => sum + item.tokenCount, 0),
    spreadingMetrics,
  };

  return { items: selected, metadata };
}

// Re-export types and sub-modules for convenience
export type {
  AssembleRequest,
  AssembleResult,
  AssembleMetadata,
  AssemblyMode,
  AssemblyModeProfile,
  InjectedMemory,
  MemoryTier,
  RetrievalCandidate,
  ScoredCandidate,
  ScoreBreakdown,
} from "./types.js";
export { retrieve } from "./retrieve.js";
export { scoreCandidates, cosineSimilarity } from "./score.js";
export { criticFilter } from "./critic.js";
export { pack } from "./pack.js";
export { resolveMode, MODE_PROFILES } from "./modes.js";
