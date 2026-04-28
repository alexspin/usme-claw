/**
 * Tests for spreading activation (spread.ts).
 *
 * Verifies:
 *   - maxDepth=0 is a pure no-op: returns input candidates unchanged, episodesAdded=0
 *   - maxDepth=2 with matching entities adds connected episodes
 */

import { describe, it, expect, vi } from "vitest";
import { spreadingActivation } from "../src/spread.js";
import type { RetrievalCandidate } from "@usme/core";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCandidate(id: string, content: string): RetrievalCandidate {
  return {
    id,
    tier: "episodes",
    content,
    embedding: [],
    tokenCount: 10,
    createdAt: new Date("2026-01-01"),
    provenanceKind: "model",
    utilityPrior: "medium",
    confidence: 1.0,
    isActive: true,
    accessCount: 3,
    lastAccessed: null,
    teachability: null,
    tags: [],
    similarity: 0.8,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("spreadingActivation", () => {
  describe("maxDepth=0 — no-op", () => {
    it("returns input candidates unchanged", async () => {
      const input = [makeCandidate("a", "foo"), makeCandidate("b", "bar")];
      const mockPool = { query: vi.fn() } as any;

      const result = await spreadingActivation(input, mockPool, { maxDepth: 0, maxAdditional: 10 });

      expect(result.candidates).toBe(input); // strict reference equality — same array
      expect(result.candidates).toHaveLength(2);
    });

    it("returns episodesAdded=0 in metrics", async () => {
      const input = [makeCandidate("a", "content about Alex")];
      const mockPool = { query: vi.fn() } as any;

      const result = await spreadingActivation(input, mockPool, { maxDepth: 0, maxAdditional: 10 });

      expect(result.metrics.episodesAdded).toBe(0);
      expect(result.metrics.entitiesMatched).toBe(0);
      expect(result.metrics.connectedEntities).toBe(0);
      expect(result.metrics.spreadDepth).toBe(0);
    });

    it("does not query the database at all", async () => {
      const input = [makeCandidate("a", "some content")];
      const mockPool = { query: vi.fn() } as any;

      await spreadingActivation(input, mockPool, { maxDepth: 0, maxAdditional: 10 });

      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe("maxDepth=2 — graph walk", () => {
    it("returns original candidates when no entities match candidate text", async () => {
      const input = [makeCandidate("ep-1", "some generic content with no entity names")];

      const mockPool = {
        query: vi.fn()
          // 1. Exact entity match: tokens don't match any entity → empty
          .mockResolvedValueOnce({ rows: [] })
          // 2. Fuzzy fallback: also no match
          .mockResolvedValueOnce({ rows: [] }),
      } as any;

      const result = await spreadingActivation(input, mockPool, { maxDepth: 2, maxAdditional: 10 });

      // No match → same candidates returned
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].id).toBe("ep-1");
      expect(result.metrics.episodesAdded).toBe(0);
      expect(result.metrics.entitiesMatched).toBe(0);
    });

    it("adds connected episodes when entities match at depth=2", async () => {
      // Candidate content mentions "alex" and "usme" — both match entity canonicals
      const input = [makeCandidate("ep-1", "alex worked on the usme refactor today")];

      const mockPool = {
        query: vi.fn()
          // 1. Exact entity match: tokens ["alex", "usme"] → both hit
          .mockResolvedValueOnce({
            rows: [
              { id: "entity-alex" },
              { id: "entity-usme" },
            ],
          })
          // 2. Walk relationships depth=1: no new entities (loop exits early at depth=2 check)
          .mockResolvedValueOnce({ rows: [] })
          // 3. Episode fetch via entity_ids GIN overlap
          //    (depth=2 loop iteration is skipped because currentIds is empty after depth=1)
          .mockResolvedValueOnce({
            rows: [
              {
                id: "ep-2",
                content: "usme memory system discussion",
                importance_score: 7,
                utility_score: 0.6,
                access_count: 5,
                created_at: new Date("2026-01-02"),
                embedding: null,
              },
            ],
          }),
      } as any;

      const result = await spreadingActivation(input, mockPool, { maxDepth: 2, maxAdditional: 10 });

      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[1].id).toBe("ep-2");
      expect(result.metrics.episodesAdded).toBe(1);
      expect(result.metrics.entitiesMatched).toBeGreaterThan(0);
      expect(result.metrics.spreadDepth).toBeGreaterThan(0);
    });

    it("caps added episodes at maxAdditional", async () => {
      const input = [makeCandidate("ep-1", "alex mentioned the project plan")];

      // Build 2 episodes (DB respects LIMIT $3 = maxAdditional=2)
      const extraEpisodes = Array.from({ length: 2 }, (_, i) => ({
        id: `extra-ep-${i}`,
        content: `extra content ${i}`,
        importance_score: 6,
        utility_score: 0.5,
        access_count: 1,
        created_at: new Date(),
        embedding: null,
      }));

      const mockPool = {
        query: vi.fn()
          // 1. Exact entity match: "alex" matches
          .mockResolvedValueOnce({ rows: [{ id: "entity-alex" }] })
          // 2. Walk relationships depth=1 → no new ids, loop exits
          .mockResolvedValueOnce({ rows: [] })
          // 3. Walk relationships depth=2 → skipped (currentIds empty)
          // 4. Episode fetch returns 2 rows (LIMIT=maxAdditional enforced by DB)
          .mockResolvedValueOnce({ rows: extraEpisodes }),
      } as any;

      const result = await spreadingActivation(input, mockPool, { maxDepth: 2, maxAdditional: 2 });

      expect(result.candidates).toHaveLength(3); // 1 original + 2 added
      expect(result.metrics.episodesAdded).toBe(2);

      // Verify the SQL LIMIT was passed as maxAdditional
      const episodeFetchCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
      expect(episodeFetchCall[1]).toContain(2); // limit param
    });

    it("never includes already-existing candidates in the added set", async () => {
      // ep-1 and ep-2 already in candidates
      const input = [
        makeCandidate("ep-1", "alex does things"),
        makeCandidate("ep-2", "more alex content"),
      ];

      const mockPool = {
        query: vi.fn()
          // 1. Exact entity match: "alex" matches
          .mockResolvedValueOnce({ rows: [{ id: "entity-alex" }] })
          // 2. Walk relationships depth=1 → no new ids
          .mockResolvedValueOnce({ rows: [] })
          // 3. Episode fetch: DB returns ep-3 only (ep-1 and ep-2 excluded via != ALL($2))
          .mockResolvedValueOnce({
            rows: [{ id: "ep-3", content: "alex result", importance_score: 8, utility_score: 0.7, access_count: 2, created_at: new Date(), embedding: null }],
          }),
      } as any;

      const result = await spreadingActivation(input, mockPool, { maxDepth: 1, maxAdditional: 10 });

      const ids = result.candidates.map((c) => c.id);
      expect(ids).toContain("ep-1");
      expect(ids).toContain("ep-2");
      expect(ids).toContain("ep-3");
      expect(ids).toHaveLength(3);
    });
  });
});
