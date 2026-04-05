/**
 * Unit tests for entity deduplication via the critic gate.
 * The critic gate deduplicates items with cosine similarity > 0.95.
 */

import { describe, it, expect } from "vitest";
import { criticFilter } from "../../src/assemble/critic.js";
import type { ScoredCandidate } from "../../src/assemble/types.js";

function makeScoredCandidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    id: overrides.id ?? "e1",
    tier: overrides.tier ?? "entities",
    content: overrides.content ?? "test entity",
    embedding: overrides.embedding ?? [1, 0, 0],
    tokenCount: overrides.tokenCount ?? 50,
    createdAt: overrides.createdAt ?? new Date(),
    provenanceKind: overrides.provenanceKind ?? "user",
    utilityPrior: overrides.utilityPrior ?? "medium",
    confidence: overrides.confidence ?? 1.0,
    isActive: overrides.isActive ?? true,
    accessCount: overrides.accessCount ?? 0,
    lastAccessed: overrides.lastAccessed ?? null,
    teachability: overrides.teachability ?? null,
    score: overrides.score ?? 0.8,
    scoreBreakdown: overrides.scoreBreakdown ?? {
      similarity: 0.8,
      recency: 0.8,
      provenance: 1.0,
      accessFrequency: 0,
    },
  };
}

describe("entity dedup (via critic gate)", () => {
  it("merges exact canonical match (identical embeddings)", () => {
    const original = makeScoredCandidate({
      id: "e1",
      embedding: [1, 0, 0],
      score: 0.9,
    });
    const duplicate = makeScoredCandidate({
      id: "e2",
      embedding: [1, 0, 0],
      score: 0.8,
    });

    const result = criticFilter([original, duplicate]);
    // Only the higher-scored one should survive
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("e1");
  });

  it("keeps near-miss entities (similar but different)", () => {
    const entity1 = makeScoredCandidate({
      id: "e1",
      embedding: [1, 0, 0],
      score: 0.9,
    });
    // Cosine similarity ~0.87, below 0.95 threshold
    const entity2 = makeScoredCandidate({
      id: "e2",
      embedding: [0.8, 0.5, 0.1],
      score: 0.8,
    });

    const result = criticFilter([entity1, entity2]);
    expect(result).toHaveLength(2);
  });

  it("prevents false positives: keeps genuinely different items", () => {
    const items = [
      makeScoredCandidate({ id: "a", embedding: [1, 0, 0], score: 0.9 }),
      makeScoredCandidate({ id: "b", embedding: [0, 1, 0], score: 0.8 }),
      makeScoredCandidate({ id: "c", embedding: [0, 0, 1], score: 0.7 }),
    ];

    const result = criticFilter(items);
    expect(result).toHaveLength(3);
  });

  it("deduplicates only when cosine similarity > 0.95", () => {
    // Two vectors with cosine similarity = ~0.96 (above threshold)
    const v1 = [1, 0, 0];
    const v2 = [0.99, 0.05, 0]; // cos ~0.9987

    const items = [
      makeScoredCandidate({ id: "a", embedding: v1, score: 0.9 }),
      makeScoredCandidate({ id: "b", embedding: v2, score: 0.8 }),
    ];

    const result = criticFilter(items);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("handles items with empty embeddings (no dedup)", () => {
    const items = [
      makeScoredCandidate({ id: "a", embedding: [], score: 0.9 }),
      makeScoredCandidate({ id: "b", embedding: [], score: 0.8 }),
    ];

    const result = criticFilter(items);
    expect(result).toHaveLength(2);
  });
});
