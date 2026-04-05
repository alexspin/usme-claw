/**
 * Scoring function for retrieval candidates.
 *
 * Weighted formula: similarity + recency_decay + provenance_tier + access_frequency
 * With skill-specific weights that include teachability.
 */

import type { MemoryTier, RetrievalCandidate, ScoredCandidate, ScoreBreakdown } from "./types.js";

/** Default weights (D6). */
const DEFAULT_WEIGHTS = {
  similarity: 0.40,
  recency: 0.25,
  provenance: 0.20,
  accessFreq: 0.15,
} as const;

/** Skill-specific weights (D7). */
const SKILL_WEIGHTS = {
  similarity: 0.20,
  recency: 0.00,
  provenance: 0.10,
  accessFreq: 0.30,
  teachability: 0.40,
} as const;

/** Recency half-lives per tier in days. */
const HALF_LIFE_DAYS: Record<MemoryTier, number> = {
  sensory_trace: 1,
  episodes: 7,
  concepts: 90,
  skills: Infinity,
  entities: 30,
};

/** Provenance reliability scores. */
const PROVENANCE_SCORES: Record<string, number> = {
  user: 1.0,
  tool: 0.85,
  file: 0.75,
  web: 0.70,
  model: 0.60,
};

/**
 * Score a batch of candidates against the query embedding.
 * Each candidate receives a composite score in [0, 1].
 */
export function scoreCandidates(
  candidates: RetrievalCandidate[],
  queryEmbedding: number[],
  now: Date = new Date(),
): ScoredCandidate[] {
  return candidates.map((c) => scoreCandidate(c, queryEmbedding, now));
}

function scoreCandidate(
  candidate: RetrievalCandidate,
  queryEmbedding: number[],
  now: Date,
): ScoredCandidate {
  const sim = cosineSimilarity(candidate.embedding, queryEmbedding);
  const rec = recencyDecay(candidate.createdAt, now, HALF_LIFE_DAYS[candidate.tier]);
  const prov = PROVENANCE_SCORES[candidate.provenanceKind] ?? 0.5;
  const acc = accessFrequencyScore(candidate.accessCount, candidate.lastAccessed, now);

  let score: number;
  let breakdown: ScoreBreakdown;

  if (candidate.tier === "skills" && candidate.teachability != null) {
    const teach = candidate.teachability / 10; // normalize 0-10 to 0-1
    score =
      SKILL_WEIGHTS.similarity * sim +
      SKILL_WEIGHTS.recency * rec +
      SKILL_WEIGHTS.provenance * prov +
      SKILL_WEIGHTS.accessFreq * acc +
      SKILL_WEIGHTS.teachability * teach;
    breakdown = { similarity: sim, recency: rec, provenance: prov, accessFrequency: acc, teachability: teach };
  } else {
    score =
      DEFAULT_WEIGHTS.similarity * sim +
      DEFAULT_WEIGHTS.recency * rec +
      DEFAULT_WEIGHTS.provenance * prov +
      DEFAULT_WEIGHTS.accessFreq * acc;
    breakdown = { similarity: sim, recency: rec, provenance: prov, accessFrequency: acc };
  }

  return { ...candidate, score, scoreBreakdown: breakdown };
}

/** Exponential decay with tier-specific half-life. */
function recencyDecay(createdAt: Date, now: Date, halfLifeDays: number): number {
  if (!isFinite(halfLifeDays)) return 1.0;
  const ageDays = (now.getTime() - createdAt.getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Log-scaled access frequency with recency bonus. */
function accessFrequencyScore(accessCount: number, lastAccessed: Date | null, now: Date): number {
  if (!lastAccessed) return 0;
  const recencyBonus = recencyDecay(lastAccessed, now, 14);
  return Math.min(1.0, Math.log(1 + accessCount) / Math.log(50)) * recencyBonus;
}

/** In-process cosine similarity fallback. ANN queries compute this in pgvector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
