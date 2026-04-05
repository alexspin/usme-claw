/**
 * Tests for graceful degradation when assemble() fails.
 */

import { describe, it, expect } from "vitest";
import { runShadowAssemble } from "../src/shadow.js";

describe("graceful degradation", () => {
  it("returns null when assemble throws a generic error", async () => {
    const result = await runShadowAssemble(async () => {
      throw new Error("Generic failure");
    });
    expect(result).toBeNull();
  });

  it("returns null when assemble throws a connection error", async () => {
    const result = await runShadowAssemble(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result).toBeNull();
  });

  it("returns null when assemble throws a timeout error", async () => {
    const result = await runShadowAssemble(async () => {
      throw new Error("Query timed out after 30000ms");
    });
    expect(result).toBeNull();
  });

  it("returns null when assemble throws a non-Error value", async () => {
    const result = await runShadowAssemble(async () => {
      throw "string error";
    });
    expect(result).toBeNull();
  });

  it("does not throw -- errors are caught internally", async () => {
    await expect(
      runShadowAssemble(async () => {
        throw new Error("should not propagate");
      }),
    ).resolves.toBeNull();
  });

  it("returns valid result when assemble succeeds", async () => {
    const mockResult = {
      assembleResult: {
        items: [],
        metadata: {
          itemsConsidered: 0,
          itemsSelected: 0,
          tiersQueried: [] as string[],
          durationMs: 5,
          mode: "brilliant" as const,
          tokenBudget: 10000,
          tokensUsed: 0,
        },
      },
      latencyMs: 5,
    };

    const result = await runShadowAssemble(async () => mockResult);
    expect(result).toEqual(mockResult);
  });
});
