/**
 * Unit tests for the scoring + packing pipeline (selection formula).
 */

import { describe, it, expect } from "vitest";
import { pack } from "../../src/assemble/pack.js";
import { scoreCandidates, cosineSimilarity } from "../../src/assemble/score.js";
import type { RetrievalCandidate, ScoredCandidate } from "../../src/assemble/types.js";

// ── Helpers ──────────────────────────────────────────────────

function makeCandidate(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    id: overrides.id ?? "c1",
    tier: overrides.tier ?? "concepts",
    content: overrides.content ?? "test content",
    embedding: overrides.embedding ?? [1, 0, 0],
    tokenCount: overrides.tokenCount ?? 100,
    createdAt: overrides.createdAt ?? new Date(),
    provenanceKind: overrides.provenanceKind ?? "user",
    utilityPrior: overrides.utilityPrior ?? "medium",
    confidence: overrides.confidence ?? 1.0,
    isActive: overrides.isActive ?? true,
    accessCount: overrides.accessCount ?? 0,
    lastAccessed: overrides.lastAccessed ?? null,
    teachability: overrides.teachability ?? null,
  };
}

function makeScoredCandidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    ...makeCandidate(overrides),
    score: overrides.score ?? 0.5,
    scoreBreakdown: overrides.scoreBreakdown ?? {
      similarity: 0.5,
      recency: 0.5,
      provenance: 0.5,
      accessFrequency: 0,
    },
  };
}

// ── Greedy Packing Tests ─────────────────────────────────────

describe("pack (greedy packing)", () => {
  it("selects items by score descending until budget exhausted", () => {
    const candidates: ScoredCandidate[] = [
      makeScoredCandidate({ id: "a", score: 0.9, tokenCount: 50 }),
      makeScoredCandidate({ id: "b", score: 0.7, tokenCount: 50 }),
      makeScoredCandidate({ id: "c", score: 0.5, tokenCount: 50 }),
    ];
    const result = pack(candidates, 100);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  it("skips large items and fills with smaller ones", () => {
    const candidates: ScoredCandidate[] = [
      makeScoredCandidate({ id: "big", score: 0.9, tokenCount: 200 }),
      makeScoredCandidate({ id: "small1", score: 0.5, tokenCount: 40 }),
      makeScoredCandidate({ id: "small2", score: 0.3, tokenCount: 40 }),
    ];
    const result = pack(candidates, 100);
    // big doesn't fit, so both smalls should be selected
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["small1", "small2"]);
  });

  it("returns empty array for zero budget", () => {
    const candidates: ScoredCandidate[] = [
      makeScoredCandidate({ id: "a", score: 0.9, tokenCount: 50 }),
    ];
    const result = pack(candidates, 0);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty candidates", () => {
    const result = pack([], 1000);
    expect(result).toHaveLength(0);
  });

  it("handles exact budget match", () => {
    const candidates: ScoredCandidate[] = [
      makeScoredCandidate({ id: "a", score: 0.9, tokenCount: 100 }),
    ];
    const result = pack(candidates, 100);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("preserves score-descending order in output", () => {
    const candidates: ScoredCandidate[] = [
      makeScoredCandidate({ id: "low", score: 0.1, tokenCount: 10 }),
      makeScoredCandidate({ id: "high", score: 0.9, tokenCount: 10 }),
      makeScoredCandidate({ id: "mid", score: 0.5, tokenCount: 10 }),
    ];
    const result = pack(candidates, 1000);
    expect(result[0].id).toBe("high");
    expect(result[1].id).toBe("mid");
    expect(result[2].id).toBe("low");
  });
});

// ── Scoring Tests ────────────────────────────────────────────

describe("scoreCandidates", () => {
  it("assigns higher score to more similar candidates", () => {
    const query = [1, 0, 0];
    const similar = makeCandidate({ id: "sim", embedding: [0.9, 0.1, 0] });
    const dissimilar = makeCandidate({ id: "dis", embedding: [0, 0, 1] });

    const [scoredSim, scoredDis] = scoreCandidates([similar, dissimilar], query);
    expect(scoredSim.score).toBeGreaterThan(scoredDis.score);
  });

  it("uses skill weights when tier is skills and teachability is set", () => {
    const query = [1, 0, 0];
    const skill = makeCandidate({
      id: "skill1",
      tier: "skills",
      embedding: [1, 0, 0],
      teachability: 10,
      accessCount: 10,
      lastAccessed: new Date(),
    });

    const [scored] = scoreCandidates([skill], query);
    expect(scored.scoreBreakdown.teachability).toBeDefined();
    expect(scored.scoreBreakdown.teachability).toBeCloseTo(1.0); // 10/10
  });

  it("does not include teachability for non-skill tiers", () => {
    const query = [1, 0, 0];
    const concept = makeCandidate({ id: "c1", tier: "concepts", embedding: [1, 0, 0] });

    const [scored] = scoreCandidates([concept], query);
    expect(scored.scoreBreakdown.teachability).toBeUndefined();
  });
});

// ── Cosine Similarity Tests ──────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });
});
