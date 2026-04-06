/**
 * Unit tests for dedup logic in persistExtractedItems (extractor.ts).
 * Verifies that findSimilarTrace controls whether insertSensoryTrace is called.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ── Mocks must be declared before imports that use them ──────

vi.mock("../../src/db/queries.js", () => ({
  insertSensoryTrace: vi.fn().mockResolvedValue("mock-id-123"),
  findSimilarTrace: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../src/embed/index.js", () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

import { persistExtractedItems } from "../../src/extract/extractor.js";
import { insertSensoryTrace, findSimilarTrace } from "../../src/db/queries.js";
import { embedText } from "../../src/embed/index.js";
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
    (findSimilarTrace as Mock).mockResolvedValue(false);
    (embedText as Mock).mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it("skips insert when findSimilarTrace returns true (duplicate found)", async () => {
    (findSimilarTrace as Mock).mockResolvedValue(true);

    const ids = await persistExtractedItems(mockPool, baseCtx, makeResult(), "fake-api-key");

    expect(findSimilarTrace).toHaveBeenCalledOnce();
    expect(insertSensoryTrace).not.toHaveBeenCalled();
    expect(ids).toHaveLength(0);
  });

  it("proceeds with insert when findSimilarTrace returns false (no duplicate)", async () => {
    (findSimilarTrace as Mock).mockResolvedValue(false);

    const ids = await persistExtractedItems(mockPool, baseCtx, makeResult(), "fake-api-key");

    expect(findSimilarTrace).toHaveBeenCalledOnce();
    expect(insertSensoryTrace).toHaveBeenCalledOnce();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe("mock-id-123");
  });

  it("skips dedup check and inserts when no embedding (no API key)", async () => {
    const ids = await persistExtractedItems(mockPool, baseCtx, makeResult());
    // No embeddingApiKey → no embedding → no dedup check → insert proceeds
    expect(embedText).not.toHaveBeenCalled();
    expect(findSimilarTrace).not.toHaveBeenCalled();
    expect(insertSensoryTrace).toHaveBeenCalledOnce();
    expect(ids).toHaveLength(1);
  });
});
