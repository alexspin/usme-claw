/**
 * Critic gate: rule-based filter that runs after scoring.
 * Removes candidates that fail mandatory or soft rules.
 * This is a filter, not a scorer -- it does not modify scores.
 */

import type { ScoredCandidate } from "./types.js";
import { cosineSimilarity } from "./score.js";

export interface CriticOptions {
  /** Minimum confidence threshold. Default: 0.3 */
  minConfidence?: number;
  /** Cosine similarity threshold for deduplication. Default: 0.95 (distance < 0.05) */
  dedupThreshold?: number;
}

/**
 * Filter scored candidates through mandatory and soft rules.
 * Processes candidates in score-descending order; dedup is checked
 * against already-accepted items.
 */
export function criticFilter(
  candidates: ScoredCandidate[],
  opts: CriticOptions = {},
): ScoredCandidate[] {
  const { minConfidence = 0.3, dedupThreshold = 0.95 } = opts;

  // Sort descending by score so higher-scored items are kept during dedup
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const accepted: ScoredCandidate[] = [];

  for (const c of sorted) {
    // --- Mandatory rules (hard discard) ---
    if (c.utilityPrior === "discard") continue;
    if (c.confidence < minConfidence) continue;
    if (c.isActive === false) continue;
    if (/\bHEARTBEAT\b/i.test(c.content)) continue; // heartbeat_noise

    // --- Soft rules ---
    // Deduplicate semantically similar items (cosine distance < 0.05)
    if (isDuplicate(c, accepted, dedupThreshold)) continue;

    // Flag model provenance with low confidence
    if (c.provenanceKind === "model" && c.confidence < 0.6) continue;

    accepted.push(c);
  }

  return accepted;
}

function isDuplicate(
  candidate: ScoredCandidate,
  accepted: ScoredCandidate[],
  threshold: number,
): boolean {
  if (candidate.embedding.length === 0) return false;
  for (const item of accepted) {
    if (item.embedding.length === 0) continue;
    if (cosineSimilarity(candidate.embedding, item.embedding) > threshold) {
      return true;
    }
  }
  return false;
}
