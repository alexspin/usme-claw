/**
 * Unit tests for the pure CLI helpers: tier resolution, tier/global limits,
 * tier-limit parsing, and content preview. These lock in the cap semantics the
 * tester-verifier flagged (per-tier caps + global limit actually clamp).
 */

import { describe, it, expect } from "vitest";
import {
  resolveTiers,
  resolveTierLimits,
  applyTierAndGlobalLimits,
  applyTierAndGlobalLimitsDetailed,
  ALL_TIERS,
} from "../../src/parse.js";
import { preview, relevanceLabel } from "../../src/format.js";

describe("resolveTiers", () => {
  it("defaults to all five tiers", () => {
    expect(resolveTiers({})).toEqual(ALL_TIERS);
  });
  it("parses a comma list", () => {
    expect(resolveTiers({ tiers: "concepts,episodes" })).toEqual(["concepts", "episodes"]);
  });
  it("rejects unknown tiers", () => {
    expect(() => resolveTiers({ tiers: "concepts,bogus" })).toThrow(/Unknown tier/);
  });
});

describe("resolveTierLimits", () => {
  it("parses repeated tier=N into a map", () => {
    expect(resolveTierLimits({ "tier-limit": ["concepts=3", "episodes=2"] })).toEqual({
      concepts: 3,
      episodes: 2,
    });
  });
  it("rejects malformed entries", () => {
    expect(() => resolveTierLimits({ "tier-limit": ["concepts"] })).toThrow(/tier=N/);
  });
  it("rejects unknown tier", () => {
    expect(() => resolveTierLimits({ "tier-limit": ["bogus=1"] })).toThrow(/unknown tier/);
  });
});

describe("applyTierAndGlobalLimits", () => {
  const items = [
    { tier: "concepts" as const },
    { tier: "concepts" as const },
    { tier: "concepts" as const },
    { tier: "concepts" as const },
    { tier: "concepts" as const },
    { tier: "episodes" as const },
    { tier: "episodes" as const },
    { tier: "episodes" as const },
    { tier: "entities" as const },
  ];

  it("clamps per tier and leaves uncapped tiers untouched", () => {
    const out = applyTierAndGlobalLimits(items, { concepts: 3, episodes: 2 });
    expect(out.filter((i) => i.tier === "concepts")).toHaveLength(3);
    expect(out.filter((i) => i.tier === "episodes")).toHaveLength(2);
    expect(out.filter((i) => i.tier === "entities")).toHaveLength(1);
  });

  it("applies a global limit after per-tier caps", () => {
    const out = applyTierAndGlobalLimits(items, { concepts: 3 }, 4);
    expect(out).toHaveLength(4);
  });

  it("is a no-op without limits", () => {
    expect(applyTierAndGlobalLimits(items, {})).toHaveLength(items.length);
  });

  it("reports before/after counts for debug logging", () => {
    const out = applyTierAndGlobalLimitsDetailed(items, { concepts: 2 }, 3);
    expect(out.before).toBe(9);
    expect(out.afterTierLimits).toBe(6);
    expect(out.afterGlobalLimit).toBe(3);
    expect(out.items).toHaveLength(3);
  });
});

describe("preview", () => {
  it("truncates to the preview length with an ellipsis", () => {
    const out = preview("a".repeat(300), { previewLen: 50 });
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns full content when full=true", () => {
    const content = "a".repeat(300);
    expect(preview(content, { full: true })).toBe(content);
  });
});

describe("relevanceLabel", () => {
  it("buckets scores into high/med/low", () => {
    expect(relevanceLabel(0.9)).toBe("high");
    expect(relevanceLabel(0.6)).toBe("med");
    expect(relevanceLabel(0.2)).toBe("low");
  });
});
