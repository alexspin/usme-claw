/**
 * Tests for shadow mode comparison logic.
 */

import { describe, it, expect } from "vitest";
import {
  runShadowAssemble,
  computeOverlapScore,
  type ShadowAssembleResult,
} from "../src/shadow.js";
import type { AssembleResult } from "@usme/core/assemble/types.js";

describe("shadow comparison", () => {
  it("runShadowAssemble returns result on success", async () => {
    const mockResult: ShadowAssembleResult = {
      assembleResult: {
        items: [
          {
            id: "item1",
            tier: "concepts",
            content: "test content",
            score: 0.8,
            tokenCount: 50,
          },
        ],
        metadata: {
          itemsConsidered: 10,
          itemsSelected: 1,
          tiersQueried: ["concepts"],
          durationMs: 42,
          mode: "brilliant",
          tokenBudget: 10000,
          tokensUsed: 50,
        },
      },
      latencyMs: 42,
    };

    const result = await runShadowAssemble(async () => mockResult);
    expect(result).toEqual(mockResult);
  });

  it("runShadowAssemble returns null on failure (graceful degradation)", async () => {
    const result = await runShadowAssemble(async () => {
      throw new Error("DB connection failed");
    });
    expect(result).toBeNull();
  });

  it("computeOverlapScore returns 1.0 for identical content", () => {
    const content = ["hello world foo bar"];
    expect(computeOverlapScore(content, content)).toBeCloseTo(1.0);
  });

  it("computeOverlapScore returns 0.0 for completely disjoint content", () => {
    const a = ["alpha beta gamma"];
    const b = ["delta epsilon zeta"];
    expect(computeOverlapScore(a, b)).toBeCloseTo(0.0);
  });

  it("computeOverlapScore returns partial overlap", () => {
    const a = ["hello world foo"];
    const b = ["hello world bar"];
    // Overlap: {hello, world} / Union: {hello, world, foo, bar} = 2/4 = 0.5
    const score = computeOverlapScore(a, b);
    expect(score).toBeCloseTo(0.5);
  });

  it("computeOverlapScore handles empty arrays", () => {
    expect(computeOverlapScore([], [])).toBe(1.0);
    expect(computeOverlapScore(["hello"], [])).toBe(0.0);
    expect(computeOverlapScore([], ["hello"])).toBe(0.0);
  });
});
