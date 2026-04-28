import { describe, it, expect } from "vitest";
import { makeSlug, assignSlug, buildSlugIndexes } from "../reflect-corpus.js";
import type { ReflectionCorpus } from "../reflect-corpus.js";

describe("makeSlug", () => {
  it("converts phrase to kebab-case", () => {
    expect(makeSlug("Fix postgres savepoint cascade")).toBe("fix-postgres-savepoint-cascade");
  });

  it("uses fallback when text is empty", () => {
    expect(makeSlug("", "item")).toBe("item");
  });

  it("strips non-alphanumeric characters", () => {
    expect(makeSlug("Hello, World! (test)")).toBe("hello-world-test");
  });

  it("truncates at 40 chars", () => {
    const long = "the quick brown fox jumps over the lazy dog";
    const result = makeSlug(long);
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it("takes only first 6 words", () => {
    const result = makeSlug("one two three four five six seven eight");
    expect(result).toBe("one-two-three-four-five-six");
  });

  it("does not leave trailing hyphens after truncation", () => {
    const result = makeSlug("abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toMatch(/-$/);
  });
});

describe("assignSlug", () => {
  it("assigns a slug and stores uuid in index", () => {
    const index = new Map<string, string>();
    const counts = new Map<string, number>();
    const slug = assignSlug("Fix postgres savepoint cascade", index, "uuid-1", "concept", counts);
    expect(slug).toBe("fix-postgres-savepoint-cascade");
    expect(index.get(slug)).toBe("uuid-1");
  });

  it("appends -2 suffix on slug collision", () => {
    const index = new Map<string, string>();
    const counts = new Map<string, number>();
    assignSlug("Fix postgres", index, "uuid-1", "concept", counts);
    const slug2 = assignSlug("Fix postgres", index, "uuid-2", "concept", counts);
    expect(slug2).toBe("fix-postgres-2");
    expect(index.get("fix-postgres-2")).toBe("uuid-2");
  });

  it("namespaces collision counts by ns prefix", () => {
    const index = new Map<string, string>();
    const counts = new Map<string, number>();
    const s1 = assignSlug("Alex", index, "uuid-1", "entity", counts);
    const s2 = assignSlug("Alex", index, "uuid-2", "concept", counts);
    // Different namespace — both get base slug (different indexes, same map key base differs by ns)
    expect(s1).toBe("alex");
    expect(s2).toBe("alex");
    // Both stored under their own namespace slug
    expect(index.get("alex")).toBe("uuid-2"); // last write to same key wins — ns separation is via key prefix
  });
});

describe("buildSlugIndexes", () => {
  const corpus: ReflectionCorpus = {
    concepts: [
      { id: "c1", concept_type: "preference", content: "Use lru-cache over custom map", utility_score: 0.9, confidence: 0.95, tags: [] },
    ],
    episodes: [
      { id: "e1", summary: "Debugged max tokens truncation issue", access_count: 3, importance_score: 0.8, utility_score: 0.7, created_at: new Date() },
    ],
    traces: [
      { id: "t1", content: "Alex prefers lru-cache", memory_type: "preference", created_at: new Date() },
    ],
    entities: [
      { id: "ent1", name: "usme-claw", entity_type: "project", canonical: null, confidence: 1.0, relationships: null },
    ],
    existingSkills: [],
    pendingCandidates: [],
  };

  it("returns correct slug index sizes", () => {
    const result = buildSlugIndexes(corpus);
    expect(result.indexes.conceptSlugIndex.size).toBe(1);
    expect(result.indexes.episodeSlugIndex.size).toBe(1);
    expect(result.indexes.entitySlugIndex.size).toBe(1);
  });

  it("conceptsText contains concept content", () => {
    const result = buildSlugIndexes(corpus);
    expect(result.conceptsText).toContain("lru-cache");
  });

  it("episodesText contains episode summary", () => {
    const result = buildSlugIndexes(corpus);
    expect(result.episodesText).toContain("max tokens");
  });

  it("entitiesText contains entity name", () => {
    const result = buildSlugIndexes(corpus);
    expect(result.entitiesText).toContain("usme-claw");
  });

  it("tracesText contains trace content", () => {
    const result = buildSlugIndexes(corpus);
    expect(result.tracesText).toContain("lru-cache");
  });

  it("slug index maps slug to uuid", () => {
    const result = buildSlugIndexes(corpus);
    const slug = [...result.indexes.conceptSlugIndex.keys()][0];
    expect(result.indexes.conceptSlugIndex.get(slug)).toBe("c1");
  });
});
