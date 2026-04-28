import { describe, it, expect } from "vitest";
import { extractGrade, isPassing } from "../../src/consolidate/promote.js";

describe("extractGrade", () => {
  it("handles markdown bold wrapper", () =>
    expect(extractGrade("**Corpus Health: B+**\n\n...")).toBe("B+"));
  it("handles inline text", () =>
    expect(extractGrade("B+ — memory health is good")).toBe("B+"));
  it("handles prefix text", () =>
    expect(extractGrade("Grade A- for overall quality")).toBe("A-"));
  it("returns first match on A-/B+", () =>
    expect(extractGrade("A-/B+")).toBe("A-"));
  it("handles grade followed by period", () =>
    expect(extractGrade("B+. The corpus is large")).toBe("B+"));
  it("returns empty string for empty input", () =>
    expect(extractGrade("")).toBe(""));
});

describe("isPassing", () => {
  it.each(["B+", "A", "A-", "A+"])("passes %s", (g) =>
    expect(isPassing(g)).toBe(true));
  it.each(["B", "B-", "C", "D", ""])("fails %s", (g) =>
    expect(isPassing(g)).toBe(false));
});
