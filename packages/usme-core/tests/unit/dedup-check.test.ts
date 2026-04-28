/**
 * Unit tests for dedup logic in persistExtractedItems (extractor.ts).
 * Verifies that findSimilarTraces (batch) controls whether insertSensoryTrace is called.
 *
 * NOTE: The source uses findSimilarTraces (plural, batch API) and embedBatch,
 * not the singular findSimilarTrace/embedText. Mocks match the real call sites.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ── Mocks must be declared before imports that use them ──────

vi.mock("../../src/db/queries.js", () => ({
  insertSensoryTrace: vi.fn().mockResolvedValue("mock-id-123"),
  findSimilarTrace: vi.fn().mockResolvedValue(false),   // kept for completeness
  findSimilarTraces: vi.fn().mockResolvedValue([false]), // batch API used by extractor
}));

vi.mock("../../src/embed/index.js", () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
}));

import { persistExtractedItems } from "../../src/extract/extractor.js";
import { insertSensoryTrace, findSimilarTraces } from "../../src/db/queries.js";
import { embedBatch } from "../../src/embed/index.js";
import type { FactExtractionResult, ExtractionContext } from "../../src/extract/extractor.js";

const mockPool = {} as any;

const baseCtx: ExtractionContext = {
  sessionId: "test-session",
  turnIndex: 1,
  serializedTurn: "test turn",
};

function makeResult(content = "User prefers dark mode"): FactExtractionResult {
  return {
    items: [
      {
        type: "preference",
        content,
        utility: "high",
        provenance_kind: "user",
        tags: ["ui"],
        ephemeral_ttl_hours: null,
      },
    ],
  };
}

describe("persistExtractedItems dedup logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (insertSensoryTrace as Mock).mockResolvedValue("mock-id-123");
    (findSimilarTraces as Mock).mockResolvedValue([false]); // batch: [false] = no duplicate
    (embedBatch as Mock).mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  it("skips insert when findSimilarTraces returns [true] (duplicate found)", async () => {
    (findSimilarTraces as Mock).mockResolvedValue([true]); // batch result: duplicate detected

    const ids = await persistExtractedItems(mockPool, baseCtx, makeResult(), "fake-api-key");

    expect(findSimilarTraces).toHaveBeenCalledOnce();
    expect(insertSensoryTrace).not.toHaveBeenCalled();
    expect(ids).toHaveLength(0);
  });

  it("proceeds with insert when findSimilarTraces returns [false] (no duplicate)", async () => {
    (findSimilarTraces as Mock).mockResolvedValue([false]); // batch result: no duplicate

    const ids = await persistExtractedItems(mockPool, baseCtx, makeResult(), "fake-api-key");

    expect(findSimilarTraces).toHaveBeenCalledOnce();
    expect(insertSensoryTrace).toHaveBeenCalledOnce();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe("mock-id-123");
  });

  it("skips dedup check and inserts when no embedding (no API key)", async () => {
    // No embeddingApiKey → embedBatch not called → findSimilarTraces still called
    // but with null embeddings → result is all-false (no dedup) → insert proceeds
    const ids = await persistExtractedItems(mockPool, baseCtx, makeResult());
    expect(embedBatch).not.toHaveBeenCalled();
    expect(insertSensoryTrace).toHaveBeenCalledOnce();
    expect(ids).toHaveLength(1);
  });
});
