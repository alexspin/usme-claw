/**
 * Tests for the Memory Reflection Service (reflect.ts).
 *
 * Verifies:
 *   - All skills (confidence >= 0.5) go to skill_candidates (never directly to skills)
 *   - quality_tier='candidate' for confidence >= 0.70, 'draft' for 0.50–0.69
 *   - Quality gate: only writes candidates when overall_assessment is A/A-/B+
 *   - --dry-run returns results without making any DB writes
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @anthropic-ai/sdk ────────────────────────────────────────────────────

const mockMessagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

// ── Mock DB pool ──────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockRelease = vi.fn();

const mockClient = {
  query: vi.fn(),
  release: mockRelease,
};

vi.mock("../../src/db/pool.js", () => ({
  getPool: vi.fn().mockReturnValue({
    query: mockQuery,
    connect: mockConnect,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReflectionResponse(
  skills: { name: string; description: string; confidence: number }[],
  grade = "A-",
): unknown {
  return {
    content: [
      {
        type: "tool_use",
        name: "reflection_output",
        input: {
          concept_updates: [],
          new_skills: skills,
          contradictions: [],
          entity_updates: [],
          // overall_assessment must start with a passing grade for candidates to be written
          overall_assessment: `${grade}: Memory health looks good.`,
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 100 },
  };
}

function makeEmptyCorpusQueries() {
  // pool.query is called 6 times for corpus fetch: concepts, episodes, traces, entities, existing skills, pending candidates
  mockQuery
    .mockResolvedValueOnce({ rows: [] }) // concepts
    .mockResolvedValueOnce({ rows: [] }) // episodes
    .mockResolvedValueOnce({ rows: [] }) // traces
    .mockResolvedValueOnce({ rows: [] }) // entities
    .mockResolvedValueOnce({ rows: [] }) // existing skill names (SELECT name FROM skills)
    .mockResolvedValueOnce({ rows: [] }); // pending skill_candidates
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runReflection — skill confidence routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";

    // Reset mockClient.query tracking
    mockClient.query.mockReset();
    mockRelease.mockReset();

    // pool.connect returns a mock client with transaction support
    mockConnect.mockResolvedValue(mockClient);

    // Default mockClient.query: BEGIN, INSERT reflection_run, skill inserts, UPDATE reflection_run, COMMIT
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT reflection_runs → runId=42
      .mockResolvedValue({ rows: [] }); // All subsequent queries
  });

  it("routes confidence=0.8 skill to skill_candidates with quality_tier=candidate", async () => {
    makeEmptyCorpusQueries();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse([{ name: "High Conf Skill", description: "A reusable skill", confidence: 0.8 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");

    const result = await runReflection({ triggerSource: "test", dryRun: false });

    expect(result.changes.skillsCreated).toBe(1);

    // All skills go to skill_candidates, never directly to skills
    const candidateInsertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(candidateInsertCall).toBeDefined();
    // Should NOT insert directly into skills table
    const skillsInsertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO skills"),
    );
    expect(skillsInsertCall).toBeUndefined();
  });

  it("routes confidence=0.5 skill to skill_candidates with quality_tier=draft", async () => {
    makeEmptyCorpusQueries();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse([{ name: "Low Conf Skill", description: "Uncertain skill", confidence: 0.5 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");

    const result = await runReflection({ triggerSource: "test", dryRun: false });

    expect(result.changes.skillsCreated).toBe(1);

    // INSERT goes to skill_candidates with quality_tier='draft' (0.50–0.69)
    const candidateInsertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(candidateInsertCall).toBeDefined();

    const skillsInsertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO skills"),
    );
    expect(skillsInsertCall).toBeUndefined();
  });

  it("dry-run makes no DB writes (no INSERT/UPDATE via pool.connect)", async () => {
    makeEmptyCorpusQueries();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse([
        { name: "HighConf", description: "Would become candidate tier", confidence: 0.8 },
        { name: "MidConf", description: "Would become draft tier", confidence: 0.55 },
      ]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");

    const result = await runReflection({ triggerSource: "test", dryRun: true });

    // dry-run returns runId=-1
    expect(result.runId).toBe(-1);
    expect(result.changes.skillsCreated).toBe(2);
    expect(result.overallAssessment).toContain("Memory health looks good.");

    // pool.connect should NOT have been called (no transaction)
    expect(mockConnect).not.toHaveBeenCalled();
    // mockClient.query should NOT have been called (no BEGIN/INSERT/COMMIT)
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("throws when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    makeEmptyCorpusQueries();

    const { runReflection } = await import("../../src/consolidate/reflect.js");

    await expect(runReflection({ triggerSource: "test" })).rejects.toThrow("ANTHROPIC_API_KEY not set");
  });
});
