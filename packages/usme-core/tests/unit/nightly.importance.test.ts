/**
 * Tests for stepEpisodify importance_score assignment.
 *
 * Verifies:
 *   - fast-model tool_call result populates importance_score in the DB insert
 *   - fast-model call failure defaults importance_score to 5
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ── Mock openai ────────────────────────────────────────────────────────────

const mockChatCompletionsCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: { completions: { create: mockChatCompletionsCreate } },
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

/** Build a mock OpenAI response that looks like a plain-text completion. */
function makeSummaryResponse(text: string): unknown {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
}

function makeImportanceResponse(score: number): unknown {
  return {
    choices: [{
      message: {
        tool_calls: [{
          type: "function",
          function: {
            name: "assign_importance",
            arguments: JSON.stringify({ importance_score: score }),
          },
        }],
      },
    }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("stepEpisodify — importance_score", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertEpisode.mockResolvedValue("episode-123");
    mockMarkTracesEpisodified.mockResolvedValue(undefined);
  });

  it("writes importance_score=8 when the fast model returns 8", async () => {
    mockGetUnepisodifiedTraces.mockResolvedValue([makeTrace("t1")]);

    // First call: episode summary (reasoning model) → plain text response
    mockChatCompletionsCreate
      .mockResolvedValueOnce(makeSummaryResponse("Test episode summary"))
      // Second call: importance scoring (fast model) → tool call with score 8
      .mockResolvedValueOnce(makeImportanceResponse(8));

    // Import after mocks are set up
    const OpenAI = (await import("openai")).default;
    const { stepEpisodify } = await import("../../src/consolidate/nightly.js");

    const client = new OpenAI({ apiKey: "test" });
    const mockPool = {
      query: vi.fn(),
    } as any;

    await stepEpisodify(client, mockPool, {});

    // insertEpisode should have been called with importance_score = 8
    expect(mockInsertEpisode).toHaveBeenCalledOnce();
    const callArgs = mockInsertEpisode.mock.calls[0][1]; // second arg is the episode object
    expect(callArgs.importance_score).toBe(8);
  });

  it("defaults to importance_score=5 when the fast model call throws", async () => {
    mockGetUnepisodifiedTraces.mockResolvedValue([makeTrace("t2")]);

    // First call: summary succeeds
    mockChatCompletionsCreate
      .mockResolvedValueOnce(makeSummaryResponse("Another episode"))
      // Second call: fast model throws
      .mockRejectedValueOnce(new Error("fast model API error"));

    const OpenAI = (await import("openai")).default;
    const { stepEpisodify } = await import("../../src/consolidate/nightly.js");

    const client = new OpenAI({ apiKey: "test" });
    const mockPool = { query: vi.fn() } as any;

    await stepEpisodify(client, mockPool, {});

    expect(mockInsertEpisode).toHaveBeenCalledOnce();
    const callArgs = mockInsertEpisode.mock.calls[0][1];
    expect(callArgs.importance_score).toBe(5);
  });

  it("returns 0 when no un-episodified traces exist", async () => {
    mockGetUnepisodifiedTraces.mockResolvedValue([]);

    const OpenAI = (await import("openai")).default;
    const { stepEpisodify } = await import("../../src/consolidate/nightly.js");

    const client = new OpenAI({ apiKey: "test" });
    const mockPool = { query: vi.fn() } as any;

    const result = await stepEpisodify(client, mockPool, {});

    expect(result).toBe(0);
    expect(mockInsertEpisode).not.toHaveBeenCalled();
    expect(mockChatCompletionsCreate).not.toHaveBeenCalled();
  });
});
