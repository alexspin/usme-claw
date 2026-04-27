/**
 * Tests for the quality gate in reflect.ts.
 *
 * Verifies that skill candidates are only written to DB when the
 * overall_assessment grade is B+ or above (A+, A, A-, B+).
 * Grades B and below → no skill_candidates INSERT.
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

function makeReflectionResponse(grade: string, skills: { name: string; description: string; confidence: number }[]): unknown {
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
          // overall_assessment starts with the grade letter
          overall_assessment: `${grade} — memory health assessment for testing`,
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function setupEmptyCorpus() {
  // Pool.query for corpus fetch: concepts, episodes, traces, entities, skills, pending candidates
  mockQuery
    .mockResolvedValueOnce({ rows: [] }) // concepts
    .mockResolvedValueOnce({ rows: [] }) // episodes
    .mockResolvedValueOnce({ rows: [] }) // traces
    .mockResolvedValueOnce({ rows: [] }) // entities
    .mockResolvedValueOnce({ rows: [] }) // existing skills
    .mockResolvedValueOnce({ rows: [] }); // pending skill_candidates
}

function setupTransactionMocks() {
  mockClient.query
    .mockResolvedValueOnce(undefined) // BEGIN
    .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT reflection_runs → runId
    .mockResolvedValue({ rows: [] }); // all subsequent (SAVEPOINTs, INSERTs, UPDATE, COMMIT)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runReflection — quality gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";

    mockClient.query.mockReset();
    mockRelease.mockReset();
    mockConnect.mockResolvedValue(mockClient);
  });

  it("grade 'B' → skill_candidates INSERT not called", async () => {
    setupEmptyCorpus();
    setupTransactionMocks();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse("B", [{ name: "Test Skill", description: "A skill", confidence: 0.8 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    const insertCandidateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCandidateCall).toBeUndefined();
  });

  it("grade 'A-' → skill_candidates INSERT IS called", async () => {
    setupEmptyCorpus();
    setupTransactionMocks();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse("A-", [{ name: "Passing Skill", description: "A good skill", confidence: 0.8 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    const insertCandidateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCandidateCall).toBeDefined();
  });

  it("grade 'B+' → skill_candidates INSERT IS called", async () => {
    setupEmptyCorpus();
    setupTransactionMocks();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse("B+", [{ name: "B+ Skill", description: "A qualifying skill", confidence: 0.75 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    const insertCandidateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCandidateCall).toBeDefined();
  });

  it("grade 'C' → skill_candidates INSERT not called", async () => {
    setupEmptyCorpus();
    setupTransactionMocks();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse("C", [{ name: "Failing Skill", description: "A low quality skill", confidence: 0.9 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    const insertCandidateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCandidateCall).toBeUndefined();
  });

  it("grade 'A' → skill_candidates INSERT IS called", async () => {
    setupEmptyCorpus();
    setupTransactionMocks();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse("A", [{ name: "A Skill", description: "Excellent skill", confidence: 0.95 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    const insertCandidateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCandidateCall).toBeDefined();
  });

  it("grade 'B-' → skill_candidates INSERT not called", async () => {
    setupEmptyCorpus();
    setupTransactionMocks();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse("B-", [{ name: "Blocked Skill", description: "Below threshold", confidence: 0.7 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    const insertCandidateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCandidateCall).toBeUndefined();
  });

  it("grade passes but confidence < 0.5 → skill skipped", async () => {
    setupEmptyCorpus();
    setupTransactionMocks();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse("A", [{ name: "Low Conf Skill", description: "Too low confidence", confidence: 0.4 }]),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    // Even though grade passes, confidence < 0.5 means no insert
    const insertCandidateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCandidateCall).toBeUndefined();
  });
});
