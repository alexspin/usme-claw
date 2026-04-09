/**
 * Tests for stepEpisodify importance_score assignment.
 *
 * Verifies:
 *   - Haiku tool_use result populates importance_score in the DB insert
 *   - Haiku call failure defaults importance_score to 5
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ── Mock @anthropic-ai/sdk ────────────────────────────────────────────────────

const mockMessagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockMessagesCreate },
    })),
  };
});

// ── Mock usme-core DB helpers ─────────────────────────────────────────────────

const mockGetUnepisodifiedTraces = vi.fn();
const mockInsertEpisode = vi.fn().mockResolvedValue("episode-123");
const mockMarkTracesEpisodified = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/db/queries.js", () => ({
  getUnepisodifiedTraces: mockGetUnepisodifiedTraces,
  insertEpisode: mockInsertEpisode,
  markTracesEpisodified: mockMarkTracesEpisodified,
  insertConcept: vi.fn(),
  deactivateConcept: vi.fn(),
  insertSkill: vi.fn(),
}));

vi.mock("../../src/embed/index.js", () => ({
  embedText: vi.fn(),
}));

vi.mock("../../src/tokenize.js", () => ({
  countTokens: vi.fn().mockReturnValue(10),
}));

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeTrace(id: string, sessionId = "sess-1") {
  return {
    id,
    session_id: sessionId,
    turn_index: 1,
    item_type: "extracted" as const,
    memory_type: "fact" as const,
    content: `Trace content for ${id}`,
    embedding: null,
    provenance_kind: "model" as const,
    provenance_ref: null,
    utility_prior: "medium" as const,
    tags: [],
    extractor_ver: null,
    metadata: {},
    episodified_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    expires_at: null,
  };
}

/** Build a mock Anthropic response that looks like a successful tool_use block. */
function makeSummaryResponse(text: string): unknown {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function makeImportanceResponse(score: number): unknown {
  return {
    content: [
      {
        type: "tool_use",
        name: "assign_importance",
        input: { importance_score: score },
      },
    ],
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("stepEpisodify — importance_score", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertEpisode.mockResolvedValue("episode-123");
    mockMarkTracesEpisodified.mockResolvedValue(undefined);
  });

  it("writes importance_score=8 when Haiku returns 8", async () => {
    mockGetUnepisodifiedTraces.mockResolvedValue([makeTrace("t1")]);

    // First call: episode summary (Sonnet) → plain text response
    mockMessagesCreate
      .mockResolvedValueOnce(makeSummaryResponse("Test episode summary"))
      // Second call: importance scoring (Haiku) → tool_use with score 8
      .mockResolvedValueOnce(makeImportanceResponse(8));

    // Import after mocks are set up
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepEpisodify } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = {
      query: vi.fn(),
    } as any;

    await stepEpisodify(client, mockPool, {});

    // insertEpisode should have been called with importance_score = 8
    expect(mockInsertEpisode).toHaveBeenCalledOnce();
    const callArgs = mockInsertEpisode.mock.calls[0][1]; // second arg is the episode object
    expect(callArgs.importance_score).toBe(8);
  });

  it("defaults to importance_score=5 when Haiku call throws", async () => {
    mockGetUnepisodifiedTraces.mockResolvedValue([makeTrace("t2")]);

    // First call: summary succeeds
    mockMessagesCreate
      .mockResolvedValueOnce(makeSummaryResponse("Another episode"))
      // Second call: Haiku throws
      .mockRejectedValueOnce(new Error("Haiku API error"));

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepEpisodify } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = { query: vi.fn() } as any;

    await stepEpisodify(client, mockPool, {});

    expect(mockInsertEpisode).toHaveBeenCalledOnce();
    const callArgs = mockInsertEpisode.mock.calls[0][1];
    expect(callArgs.importance_score).toBe(5);
  });

  it("returns 0 when no un-episodified traces exist", async () => {
    mockGetUnepisodifiedTraces.mockResolvedValue([]);

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { stepEpisodify } = await import("../../src/consolidate/nightly.js");

    const client = new Anthropic({ apiKey: "test" });
    const mockPool = { query: vi.fn() } as any;

    const result = await stepEpisodify(client, mockPool, {});

    expect(result).toBe(0);
    expect(mockInsertEpisode).not.toHaveBeenCalled();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});
