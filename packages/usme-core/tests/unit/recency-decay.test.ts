/**
 * Unit tests for recency decay function.
 * The recency decay is an internal function in score.ts,
 * tested indirectly through scoreCandidates.
 */

import { describe, it, expect } from "vitest";
import { scoreCandidates } from "../../src/assemble/score.js";
import type { RetrievalCandidate } from "../../src/assemble/types.js";

const QUERY = [1, 0, 0];

function makeCandidate(
  tier: "episodes" | "concepts" | "skills" | "entities",
  ageDays: number,
  now: Date,
): RetrievalCandidate {
  const createdAt = new Date(now.getTime() - ageDays * 86_400_000);
  return {
    id: `decay-${tier}-${ageDays}`,
    tier,
    content: "test",
    embedding: [1, 0, 0],
    tokenCount: 50,
    createdAt,
    provenanceKind: "user",
    utilityPrior: "medium",
    confidence: 1.0,
    isActive: true,
    accessCount: 0,
    lastAccessed: null,
    teachability: null,
  };
}

describe("recency decay", () => {
  const now = new Date("2026-04-05T00:00:00Z");

  it("returns recency ~1.0 at t=0 (just created)", () => {
    const candidate = makeCandidate("episodes", 0, now);
    const [scored] = scoreCandidates([candidate], QUERY, now);
    // recency component should be near 1.0
    expect(scored.scoreBreakdown.recency).toBeCloseTo(1.0, 2);
  });

  it("returns recency ~0.5 at t=half_life (episodes half_life=7d)", () => {
    const candidate = makeCandidate("episodes", 7, now);
    const [scored] = scoreCandidates([candidate], QUERY, now);
    expect(scored.scoreBreakdown.recency).toBeCloseTo(0.5, 2);
  });

  it("returns recency ~0.125 at t=3*half_life (episodes, 21d)", () => {
    const candidate = makeCandidate("episodes", 21, now);
    const [scored] = scoreCandidates([candidate], QUERY, now);
    expect(scored.scoreBreakdown.recency).toBeCloseTo(0.125, 2);
  });

  it("returns recency 1.0 always for skills (infinite half_life)", () => {
    // Skills have Infinity half-life, so recency should always be 1.0
    const candidate = makeCandidate("skills", 365, now);
    // Skills need teachability for skill weights
    candidate.teachability = 5;
    const [scored] = scoreCandidates([candidate], QUERY, now);
    expect(scored.scoreBreakdown.recency).toBeCloseTo(1.0, 5);
  });

  it("concepts decay slower than episodes (half_life=90d)", () => {
    const episodeCandidate = makeCandidate("episodes", 14, now);
    const conceptCandidate = makeCandidate("concepts", 14, now);

    const [scoredEpisode] = scoreCandidates([episodeCandidate], QUERY, now);
    const [scoredConcept] = scoreCandidates([conceptCandidate], QUERY, now);

    // At 14 days: episodes (half_life=7) should be ~0.25, concepts (half_life=90) should be ~0.90
    expect(scoredConcept.scoreBreakdown.recency).toBeGreaterThan(
      scoredEpisode.scoreBreakdown.recency,
    );
  });

  it("entities have 30-day half_life", () => {
    const candidate = makeCandidate("entities", 30, now);
    const [scored] = scoreCandidates([candidate], QUERY, now);
    expect(scored.scoreBreakdown.recency).toBeCloseTo(0.5, 2);
  });
});
