/**
 * Tests for stepSkillDraft importance_score gate.
 *
 * Verifies:
 *   - Only episodes with importance_score >= 7 are selected for skill drafting
 *   - Episodes with importance_score < 7 are excluded
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @anthropic-ai/sdk ────────────────────────────────────────────────────

const mockMessagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

// ── Mock DB helpers ───────────────────────────────────────────────────────────

const mockInsertSkill = vi.fn().mockResolvedValue("skill-1");

vi.mock("../../src/db/queries.js", () => ({
  getUnepisodifiedTraces: vi.fn(),
  insertEpisode: vi.fn(),
  markTracesEpisodified: vi.fn(),
  insertConcept: vi.fn(),
  deactivateConcept: vi.fn(),
  insertSkill: mockInsertSkill,
}));

vi.mock("../../src/embed/index.js", () => ({
  embedText: vi.fn(),
}));

vi.mock("../../src/tokenize.js", () => ({
  countTokens: vi.fn().mockReturnValue(10),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSkillDraftResponse(skills: { name: string; description: string; teachability: number }[]): unknown {
  return {
    content: [
      {
        type: "tool_use",
        name: "draft_skill",
        input: { skills },
      },
    ],
    usage: { input_tokens: 20, output_tokens: 20 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("stepSkillDraft — importance_score gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects only episodes with importance_score >= 7 via DB query", async () => {
    // Mock pool.query: first call returns episodes, second call is the UPDATE
    const mockQueryFn = vi.fn()
      .mockResolvedValueOnce({
        // Only episode with score=8 returned (score=6 was filtered by DB WHERE clause)
        rows: [{ id: "ep-high", summary: "High importance episode", session_ids: ["s1"] }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE skill_checked_at

    mockMessagesCreate.mockResolvedValue(
      makeSkillDraftResponse([{ name: "Test Skill", description: "A skill", teachability: 0.8 }]),
    );

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepSkillDraft } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = { query: mockQueryFn } as any;

    const result = await stepSkillDraft(client, mockPool, {});

    expect(result).toBe(1);

    // Verify the SQL WHERE clause used importance_score >= 7
    const sqlCalled = mockQueryFn.mock.calls[0][0] as string;
    expect(sqlCalled).toContain("importance_score >= 7");
    expect(sqlCalled).not.toContain("utility_score >= 0.6");
  });

  it("returns 0 when no episodes have importance_score >= 7", async () => {
    const mockQueryFn = vi.fn().mockResolvedValueOnce({ rows: [] });

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepSkillDraft } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = { query: mockQueryFn } as any;

    const result = await stepSkillDraft(client, mockPool, {});

    expect(result).toBe(0);
    // LLM should not be called if no episodes qualify
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("does not call LLM when zero qualifying episodes found", async () => {
    const mockQueryFn = vi.fn().mockResolvedValueOnce({ rows: [] });

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepSkillDraft } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = { query: mockQueryFn } as any;

    await stepSkillDraft(client, mockPool, {});

    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});
