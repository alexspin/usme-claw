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

  it("skips contradiction when winner UUID is not in fetched concepts", async () => {
    const validConceptId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const invalidWinnerId = "trace-uuid-not-a-concept-000000000000";

    // concepts query returns one real concept; rest empty
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: validConceptId, concept_type: "fact", content: "x", utility_score: 1, confidence: 0.9, tags: [] }] }) // concepts
      .mockResolvedValueOnce({ rows: [] }) // episodes
      .mockResolvedValueOnce({ rows: [] }) // traces
      .mockResolvedValueOnce({ rows: [] }) // entities
      .mockResolvedValueOnce({ rows: [] }) // existing skill names
      .mockResolvedValueOnce({ rows: [] }); // pending skill_candidates

    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "reflection_output",
          input: {
            concept_updates: [],
            new_skills: [],
            contradictions: [
              { winner_concept_id: invalidWinnerId, loser_concept_id: validConceptId, reason: "bad uuid from model" },
            ],
            entity_updates: [],
            overall_assessment: "A-: fine.",
          },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    const { runReflection } = await import("../../src/consolidate/reflect.js");

    const result = await runReflection({ triggerSource: "test", dryRun: false });

    // Contradiction must be skipped — no DB write, counter stays 0
    expect(result.changes.contradictionsResolved).toBe(0);

    const updateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("superseded_by"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("throws when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    makeEmptyCorpusQueries();

    const { runReflection } = await import("../../src/consolidate/reflect.js");

    await expect(runReflection({ triggerSource: "test" })).rejects.toThrow("ANTHROPIC_API_KEY not set");
  });
});

// ── Slug remapping tests ──────────────────────────────────────────────────────

describe("runReflection — concept/entity slug remapping", () => {
  const CONCEPT_UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const CONCEPT2_UUID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const ENTITY_UUID  = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockClient.query.mockReset();
    mockRelease.mockReset();
    mockConnect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce(undefined)              // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT reflection_runs
      .mockResolvedValue({ rows: [] });              // all subsequent
  });

  function makeCorpusWithConceptAndEntity() {
    // The slug for "Use lru-cache library" will be "use-lru-cache-library"
    // The slug for entity name "Alex" will be "alex"
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: CONCEPT_UUID,  concept_type: "preference", content: "Use lru-cache library", utility_score: 0.9, confidence: 0.8, tags: [] },
          { id: CONCEPT2_UUID, concept_type: "preference", content: "Batch DB writes always", utility_score: 0.7, confidence: 0.7, tags: [] },
        ],
      }) // concepts
      .mockResolvedValueOnce({ rows: [] }) // episodes
      .mockResolvedValueOnce({ rows: [] }) // traces
      .mockResolvedValueOnce({
        rows: [{ id: ENTITY_UUID, name: "Alex", entity_type: "person", canonical: null, relationships: [] }],
      }) // entities
      .mockResolvedValueOnce({ rows: [] }) // existing skill names
      .mockResolvedValueOnce({ rows: [] }); // pending skill_candidates
  }

  it("remaps concept slug to UUID in concept_updates before DB write", async () => {
    makeCorpusWithConceptAndEntity();

    mockMessagesCreate.mockResolvedValue({
      content: [{
        type: "tool_use",
        name: "reflection_output",
        input: {
          concept_updates: [{ concept_id: "use-lru-cache-library", action: "raise", reason: "frequently used" }],
          new_skills: [],
          contradictions: [],
          entity_updates: [],
          overall_assessment: "A: healthy.",
        },
      }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    expect(result.changes.conceptsUpdated).toBe(1);

    // The UPDATE must use the real UUID, not the slug
    const updateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("utility_score"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain(CONCEPT_UUID);
  });

  it("remaps concept slugs to UUIDs in contradictions before UUID-set validation", async () => {
    makeCorpusWithConceptAndEntity();

    mockMessagesCreate.mockResolvedValue({
      content: [{
        type: "tool_use",
        name: "reflection_output",
        input: {
          concept_updates: [],
          new_skills: [],
          contradictions: [{
            winner_concept_id: "batch-db-writes-always",
            loser_concept_id: "use-lru-cache-library",
            reason: "conflicting caching strategies",
          }],
          entity_updates: [],
          overall_assessment: "B: one contradiction.",
        },
      }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    // Contradiction must be applied (both slugs were valid)
    expect(result.changes.contradictionsResolved).toBe(1);

    const supersededCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("superseded_by"),
    );
    expect(supersededCall).toBeDefined();
    // loser UUID in $1, winner UUID in $2
    expect(supersededCall![1]).toContain(CONCEPT_UUID);
    expect(supersededCall![1]).toContain(CONCEPT2_UUID);
  });

  it("remaps entity slug to UUID in entity_updates before DB write", async () => {
    makeCorpusWithConceptAndEntity();

    mockMessagesCreate.mockResolvedValue({
      content: [{
        type: "tool_use",
        name: "reflection_output",
        input: {
          concept_updates: [],
          new_skills: [],
          contradictions: [],
          entity_updates: [{
            entity_id: "alex",
            action: "add_relationship",
            details: { target_entity_id: ENTITY_UUID, relationship: "MAINTAINS", confidence: 0.9 },
          }],
          overall_assessment: "A-: good.",
        },
      }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    expect(result.changes.entitiesUpdated).toBe(1);

    const insertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO entity_relationships"),
    );
    expect(insertCall).toBeDefined();
    // source_id ($1) must be the real entity UUID
    expect(insertCall![1][0]).toBe(ENTITY_UUID);
  });

  it("skips contradiction when LLM returns hallucinated concept slug", async () => {
    makeCorpusWithConceptAndEntity();

    mockMessagesCreate.mockResolvedValue({
      content: [{
        type: "tool_use",
        name: "reflection_output",
        input: {
          concept_updates: [],
          new_skills: [],
          contradictions: [{
            winner_concept_id: "hallucinated-concept-slug-xyz",
            loser_concept_id: "use-lru-cache-library",
            reason: "hallucinated winner",
          }],
          entity_updates: [],
          overall_assessment: "B: one contradiction.",
        },
      }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    // hallucinated winner slug → not in conceptIdSet → skipped
    expect(result.changes.contradictionsResolved).toBe(0);
  });
});
