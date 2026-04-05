/**
 * Unit tests for assembly mode resolution.
 */

import { describe, it, expect } from "vitest";
import { resolveMode, MODE_PROFILES } from "../../src/assemble/modes.js";

describe("resolveMode", () => {
  it("returns correct profile for psycho-genius", () => {
    const profile = resolveMode("psycho-genius");
    expect(profile.tokenBudgetFraction).toBe(0.45);
    expect(profile.candidatesPerTier).toBe(30);
    expect(profile.tiersEnabled).toContain("entities");
    expect(profile.includeSpeculative).toBe(true);
  });

  it("returns correct profile for brilliant", () => {
    const profile = resolveMode("brilliant");
    expect(profile.tokenBudgetFraction).toBe(0.35);
    expect(profile.candidatesPerTier).toBe(20);
    expect(profile.tiersEnabled).not.toContain("entities");
  });

  it("returns correct profile for smart-efficient", () => {
    const profile = resolveMode("smart-efficient");
    expect(profile.tokenBudgetFraction).toBe(0.25);
    expect(profile.minInclusionScore).toBe(0.50);
    expect(profile.tiersEnabled).toEqual(["concepts", "skills"]);
  });

  it("applies overrides", () => {
    const profile = resolveMode("brilliant", { candidatesPerTier: 50 });
    expect(profile.candidatesPerTier).toBe(50);
    // Other fields unchanged
    expect(profile.tokenBudgetFraction).toBe(0.35);
  });

  it("throws for unknown mode", () => {
    expect(() => resolveMode("unknown" as any)).toThrow("Unknown assembly mode");
  });
});
