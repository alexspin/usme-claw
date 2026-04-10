/**
 * Unit tests for promote.ts
 *
 * Tests:
 *   - getPromoteCandidates() filtering
 *   - buildPromoteCard() formatting
 *   - deferCandidate() SQL
 *   - markCandidatesPrompted() SQL
 *   - isPassing() pure function
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PromoteSkillCandidate } from "../../src/consolidate/promote.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<PromoteSkillCandidate> = {}): PromoteSkillCandidate {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? "Test Skill",
    description: overrides.description ?? "A test skill description",
    confidence: overrides.confidence ?? 0.8,
    approval_status: overrides.approval_status ?? "pending",
    created_at: overrides.created_at ?? new Date("2026-04-01T00:00:00Z"),
    updated_at: overrides.updated_at ?? new Date("2026-04-01T00:00:00Z"),
    quality_tier: overrides.quality_tier ?? "candidate",
    source: overrides.source ?? "reflect",
    prompted_at: overrides.prompted_at,
    defer_until: overrides.defer_until,
    dismissed_at: overrides.dismissed_at,
    source_episode_ids: overrides.source_episode_ids ?? [],
    ...overrides,
  };
}

// ── isPassing ─────────────────────────────────────────────────────────────────

describe("isPassing()", () => {
  it("'A' → true", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("A")).toBe(true);
  });

  it("'A-' → true", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("A-")).toBe(true);
  });

  it("'B+' → true", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("B+")).toBe(true);
  });

  it("'B' → false", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("B")).toBe(false);
  });

  it("'B-' → false", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("B-")).toBe(false);
  });

  it("'C' → false", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("C")).toBe(false);
  });

  it("'C+' → false", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("C+")).toBe(false);
  });

  it("empty string → false", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("")).toBe(false);
  });

  it("'A+' → true", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("A+")).toBe(true);
  });

  it("lowercase 'a-' → true (case-insensitive)", async () => {
    const { isPassing } = await import("../../src/consolidate/promote.js");
    expect(isPassing("a-")).toBe(true);
  });
});

// ── buildPromoteCard ──────────────────────────────────────────────────────────

describe("buildPromoteCard()", () => {
  it("returns 'no candidates' message for empty array", async () => {
    const { buildPromoteCard } = await import("../../src/consolidate/promote.js");
    const result = buildPromoteCard([]);
    expect(result).toContain("No skill candidates");
  });

  it("includes ☀️ header", async () => {
    const { buildPromoteCard } = await import("../../src/consolidate/promote.js");
    const candidates = [makeCandidate()];
    const result = buildPromoteCard(candidates);
    expect(result).toContain("☀️");
  });

  it("formats numbered list: '{n}. {name} ({confidence}) — {description}'", async () => {
    const { buildPromoteCard } = await import("../../src/consolidate/promote.js");
    const candidates = [
      makeCandidate({ name: "Deploy Plugin", confidence: 0.85, description: "How to deploy an OpenClaw plugin" }),
    ];
    const result = buildPromoteCard(candidates);
    expect(result).toMatch(/1\. Deploy Plugin.*0\.85.*How to deploy/);
  });

  it("formats second candidate as '2. ...'", async () => {
    const { buildPromoteCard } = await import("../../src/consolidate/promote.js");
    const candidates = [
      makeCandidate({ id: 1, name: "Skill A", confidence: 0.9 }),
      makeCandidate({ id: 2, name: "Skill B", confidence: 0.75 }),
    ];
    const result = buildPromoteCard(candidates);
    expect(result).toContain("1. Skill A");
    expect(result).toContain("2. Skill B");
  });

  it("includes source line: 'Source: N episodes · Xd old · {quality_tier}'", async () => {
    const { buildPromoteCard } = await import("../../src/consolidate/promote.js");
    const candidates = [
      makeCandidate({
        source_episode_ids: [1, 2, 3],
        quality_tier: "candidate",
        created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      }),
    ];
    const result = buildPromoteCard(candidates);
    expect(result).toContain("Source:");
    expect(result).toContain("episode");
    expect(result).toContain("candidate");
  });

  it("includes footer with reply instructions", async () => {
    const { buildPromoteCard } = await import("../../src/consolidate/promote.js");
    const candidates = [makeCandidate()];
    const result = buildPromoteCard(candidates);
    expect(result).toContain("Reply with numbers");
  });
});

// ── getPromoteCandidates ──────────────────────────────────────────────────────

describe("getPromoteCandidates()", () => {
  it("SQL includes dismissed_at IS NULL filter", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { getPromoteCandidates } = await import("../../src/consolidate/promote.js");
    await getPromoteCandidates({}, mockPool);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("dismissed_at IS NULL");
  });

  it("SQL includes defer_until filter by default", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { getPromoteCandidates } = await import("../../src/consolidate/promote.js");
    await getPromoteCandidates({}, mockPool);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("defer_until");
  });

  it("SQL includes prompted_at IS NULL by default", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { getPromoteCandidates } = await import("../../src/consolidate/promote.js");
    await getPromoteCandidates({}, mockPool);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("prompted_at IS NULL");
  });

  it("forceAll=true omits prompted_at IS NULL filter", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { getPromoteCandidates } = await import("../../src/consolidate/promote.js");
    await getPromoteCandidates({ forceAll: true }, mockPool);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain("prompted_at IS NULL");
  });

  it("default excludes draft tier (quality_tier = 'candidate')", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { getPromoteCandidates } = await import("../../src/consolidate/promote.js");
    await getPromoteCandidates({}, mockPool);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("quality_tier = 'candidate'");
  });

  it("includeDrafts=true does not filter by quality_tier='candidate'", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { getPromoteCandidates } = await import("../../src/consolidate/promote.js");
    await getPromoteCandidates({ includeDrafts: true }, mockPool);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain("quality_tier = 'candidate'");
  });

  it("id filter adds id = $N condition", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { getPromoteCandidates } = await import("../../src/consolidate/promote.js");
    await getPromoteCandidates({ id: 42 }, mockPool);

    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("id = $");
    expect(params).toContain(42);
  });

  it("returns rows from pool query", async () => {
    const fakeRow = makeCandidate({ id: 5, name: "Returned Skill" });
    const mockQuery = vi.fn().mockResolvedValue({ rows: [fakeRow] });
    const mockPool = { query: mockQuery } as any;

    const { getPromoteCandidates } = await import("../../src/consolidate/promote.js");
    const result = await getPromoteCandidates({}, mockPool);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Returned Skill");
  });
});

// ── deferCandidate ────────────────────────────────────────────────────────────

describe("deferCandidate()", () => {
  it("calls UPDATE with defer_until = NOW() + INTERVAL '24 hours'", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { deferCandidate } = await import("../../src/consolidate/promote.js");
    await deferCandidate(99, mockPool);

    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("defer_until");
    expect(sql).toContain("24 hours");
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain(99);
  });
});

// ── markCandidatesPrompted ────────────────────────────────────────────────────

describe("markCandidatesPrompted()", () => {
  it("calls UPDATE with prompted_at = NOW()", async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const { markCandidatesPrompted } = await import("../../src/consolidate/promote.js");
    await markCandidatesPrompted([1, 2, 3], mockPool);

    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("prompted_at");
    expect(sql).toContain("NOW()");
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[0]).toEqual([1, 2, 3]);
  });

  it("handles empty array gracefully (no DB call)", async () => {
    const mockQuery = vi.fn();
    const mockPool = { query: mockQuery } as any;

    const { markCandidatesPrompted } = await import("../../src/consolidate/promote.js");
    await markCandidatesPrompted([], mockPool);

    expect(mockQuery).not.toHaveBeenCalled();
  });
});
