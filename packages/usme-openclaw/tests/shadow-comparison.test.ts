/**
 * Tests for shadow mode comparison logic.
 */

import { describe, it, expect, vi } from "vitest";
import {
  computeOverlapScore,
} from "../src/shadow.js";

describe("shadow comparison", () => {
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

  it("computeOverlapScore handles single-token arrays", () => {
    expect(computeOverlapScore(["foo"], ["foo"])).toBeCloseTo(1.0);
    expect(computeOverlapScore(["foo"], ["bar"])).toBeCloseTo(0.0);
  });
});
