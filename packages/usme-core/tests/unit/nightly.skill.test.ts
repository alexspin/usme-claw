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

describe("stepSkillDraft — no-op stub (superseded by reflect.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 (no-op stub — skill candidate production moved to reflect.ts)", async () => {
    const mockQueryFn = vi.fn();

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepSkillDraft } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = { query: mockQueryFn } as any;

    const result = await stepSkillDraft(client, mockPool, {});

    expect(result).toBe(0);
  });

  it("makes no DB calls (no-op stub)", async () => {
    const mockQueryFn = vi.fn();

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepSkillDraft } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = { query: mockQueryFn } as any;

    await stepSkillDraft(client, mockPool, {});

    expect(mockQueryFn).not.toHaveBeenCalled();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("does not call LLM (no-op stub)", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepSkillDraft } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = { query: vi.fn() } as any;

    await stepSkillDraft(client, mockPool, {});

    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});
