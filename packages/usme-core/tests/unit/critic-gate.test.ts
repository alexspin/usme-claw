/**
 * Unit tests for the critic gate (rule-based filter).
 */

import { describe, it, expect } from "vitest";
import { criticFilter } from "../../src/assemble/critic.js";
import type { ScoredCandidate } from "../../src/assemble/types.js";

function makeScoredCandidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    id: overrides.id ?? "c1",
    tier: overrides.tier ?? "concepts",
    content: overrides.content ?? "test content",
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

describe("criticFilter", () => {
  // ── Hard rules ─────────────────────────────────────────────

  it("excludes items with utility_prior='discard'", () => {
    const items = [
      makeScoredCandidate({ id: "keep", utilityPrior: "medium" }),
      makeScoredCandidate({ id: "drop", utilityPrior: "discard" }),
    ];

    const result = criticFilter(items);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("keep");
  });

  it("excludes items with confidence < 0.3", () => {
    const items = [
      makeScoredCandidate({ id: "keep", confidence: 0.5 }),
      makeScoredCandidate({ id: "drop", confidence: 0.2 }),
    ];

    const result = criticFilter(items);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("keep");
  });

  it("excludes items with confidence exactly 0.3 (boundary: not excluded)", () => {
    const items = [
      makeScoredCandidate({ id: "boundary", confidence: 0.3 }),
    ];
    // confidence < 0.3 is excluded, so 0.3 should pass
    const result = criticFilter(items);
    expect(result).toHaveLength(1);
  });

  it("excludes soft-deleted items (is_active=false)", () => {
    const items = [
      makeScoredCandidate({ id: "active", isActive: true }),
      makeScoredCandidate({ id: "deleted", isActive: false }),
    ];

    const result = criticFilter(items);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("active");
  });

  // ── Soft rules ─────────────────────────────────────────────

  it("excludes model-provenance items with confidence < 0.6", () => {
    const items = [
      makeScoredCandidate({
        id: "model-low",
        provenanceKind: "model",
        confidence: 0.4,
        embedding: [1, 0, 0],
      }),
      makeScoredCandidate({
        id: "model-high",
        provenanceKind: "model",
        confidence: 0.8,
        embedding: [0, 1, 0],
      }),
      makeScoredCandidate({
        id: "user-low",
        provenanceKind: "user",
        confidence: 0.4,
        embedding: [0, 0, 1],
      }),
    ];

    const result = criticFilter(items);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("model-high");
    expect(ids).toContain("user-low");
    expect(ids).not.toContain("model-low");
  });

  // ── Keep valid items ───────────────────────────────────────

  it("keeps valid items through all gates", () => {
    const items = [
      makeScoredCandidate({
        id: "valid1",
        utilityPrior: "high",
        confidence: 0.9,
        isActive: true,
        provenanceKind: "user",
        embedding: [1, 0, 0],
      }),
      makeScoredCandidate({
        id: "valid2",
        utilityPrior: "low",
        confidence: 0.8,
        isActive: true,
        provenanceKind: "tool",
        embedding: [0, 1, 0],
      }),
    ];

    const result = criticFilter(items);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when all items are filtered", () => {
    const items = [
      makeScoredCandidate({ id: "d1", utilityPrior: "discard" }),
      makeScoredCandidate({ id: "d2", confidence: 0.1 }),
      makeScoredCandidate({ id: "d3", isActive: false }),
    ];

    const result = criticFilter(items);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    const result = criticFilter([]);
    expect(result).toHaveLength(0);
  });

  // ── Custom minConfidence option ────────────────────────────

  it("respects custom minConfidence option", () => {
    const items = [
      makeScoredCandidate({ id: "ok", confidence: 0.6 }),
      makeScoredCandidate({ id: "low", confidence: 0.4 }),
    ];

    const result = criticFilter(items, { minConfidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ok");
  });
});
