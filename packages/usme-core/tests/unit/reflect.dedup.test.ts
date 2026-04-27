/**
 * Tests for dedup / candidate_dismissals / trgm guard behavior in reflect.ts.
 *
 * Covers:
 *   - Candidate corpus fetch (6th pool.query call)
 *   - Prompt injection of "Pending review queue" and candidates section
 *   - candidate_dismissals handling: SAVEPOINT, UPDATE, dismissalsProcessed count
 *   - trgm guard: near-duplicate suppresses INSERT, no near-duplicate allows INSERT
 *   - dry-run: dismissals not written even when LLM proposes them
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

/**
 * Build a full LLM tool_use response.
 * grade defaults to "B+" which passes the quality gate.
 */
function makeReflectionResponse(opts: {
  grade?: string;
  newSkills?: { name: string; description: string; confidence: number }[];
  candidateDismissals?: { candidate_id: number; reason: string }[];
}): unknown {
  const {
    grade = "B+",
    newSkills = [],
    candidateDismissals = [],
  } = opts;
  return {
    content: [
      {
        type: "tool_use",
        name: "reflection_output",
        input: {
          concept_updates: [],
          new_skills: newSkills,
          contradictions: [],
          entity_updates: [],
          overall_assessment: `${grade}: Memory health looks good for test.`,
          candidate_dismissals: candidateDismissals,
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 100 },
  };
}

/**
 * Set up pool.query for the 6 corpus fetch calls:
 * concepts, episodes, traces, entities, existing skills, skill_candidates.
 */
function setupCorpusQueries(opts: {
  candidates?: { id: number; name: string; description: string }[];
} = {}) {
  const { candidates = [] } = opts;
  mockQuery
    .mockResolvedValueOnce({ rows: [] }) // concepts
    .mockResolvedValueOnce({ rows: [] }) // episodes
    .mockResolvedValueOnce({ rows: [] }) // traces
    .mockResolvedValueOnce({ rows: [] }) // entities
    .mockResolvedValueOnce({ rows: [] }) // existing skills
    .mockResolvedValueOnce({ rows: candidates }); // skill_candidates
}

/**
 * Default transaction mock: BEGIN → runId=42 → all else returns {rows:[]}.
 */
function setupDefaultTransaction() {
  mockClient.query
    .mockResolvedValueOnce(undefined) // BEGIN
    .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT reflection_runs
    .mockResolvedValue({ rows: [] }); // all subsequent
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runReflection — dedup / candidate_dismissals / trgm guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";

    mockClient.query.mockReset();
    mockRelease.mockReset();
    mockConnect.mockResolvedValue(mockClient);
  });

  // ── Test 1 ────────────────────────────────────────────────────────────────
  it("Test 1 — fetches skill_candidates with dismissed_at IS NULL", async () => {
    setupCorpusQueries({
      candidates: [{ id: 1, name: "Fix DB errors", description: "desc" }],
    });
    setupDefaultTransaction();

    mockMessagesCreate.mockResolvedValue(makeReflectionResponse({}));

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    const candidatesCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("skill_candidates") &&
        (call[0] as string).includes("dismissed_at IS NULL"),
    );
    expect(candidatesCall).toBeDefined();
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  it("Test 2 — prompt includes Pending review queue section with candidate names", async () => {
    setupCorpusQueries({
      candidates: [{ id: 2, name: "Handle timeouts", description: "retry logic" }],
    });
    setupDefaultTransaction();

    mockMessagesCreate.mockResolvedValue(makeReflectionResponse({}));

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    // The prompt is the content field of the first message
    const createCall = mockMessagesCreate.mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const promptText = createCall.messages[0].content as string;
    expect(promptText).toContain("Pending review queue");
    expect(promptText).toContain("Handle timeouts");
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  it("Test 3 — prompt shows (none yet) when candidates list is empty", async () => {
    setupCorpusQueries({ candidates: [] });
    setupDefaultTransaction();

    mockMessagesCreate.mockResolvedValue(makeReflectionResponse({}));

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    await runReflection({ triggerSource: "test", dryRun: false });

    const createCall = mockMessagesCreate.mock.calls[0]?.[0];
    const promptText = createCall.messages[0].content as string;
    expect(promptText).toContain("(none yet)");
  });

  // ── Test 4 ────────────────────────────────────────────────────────────────
  it("Test 4 — candidate_dismissals triggers SAVEPOINT + UPDATE dismissed_at, dismissalsProcessed===1", async () => {
    setupCorpusQueries({});
    setupDefaultTransaction();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse({
        grade: "B+",
        candidateDismissals: [
          { candidate_id: 5, reason: "too specific: single incident, will not recur" },
        ],
      }),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    // SAVEPOINT candidate_dismissals should be set
    const savepointCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string) === "SAVEPOINT candidate_dismissals",
    );
    expect(savepointCall).toBeDefined();

    // UPDATE skill_candidates SET dismissed_at
    const updateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("UPDATE skill_candidates") &&
        (call[0] as string).includes("dismissed_at"),
    );
    expect(updateCall).toBeDefined();

    expect(result.dismissalsProcessed).toBe(1);
  });

  // ── Test 5 ────────────────────────────────────────────────────────────────
  it("Test 5 — empty candidate_dismissals array → no UPDATE, dismissalsProcessed===0", async () => {
    setupCorpusQueries({});
    setupDefaultTransaction();

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse({ grade: "B+", candidateDismissals: [] }),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    const updateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("UPDATE skill_candidates"),
    );
    expect(updateCall).toBeUndefined();
    expect(result.dismissalsProcessed).toBe(0);
  });

  // ── Test 6 ────────────────────────────────────────────────────────────────
  it("Test 6 — candidate_dismissals missing from response → no crash, dismissalsProcessed===0", async () => {
    setupCorpusQueries({});
    setupDefaultTransaction();

    // Return a response without candidate_dismissals field at all
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "reflection_output",
          input: {
            concept_updates: [],
            new_skills: [],
            contradictions: [],
            entity_updates: [],
            overall_assessment: "B+: all good",
            // candidate_dismissals intentionally omitted
          },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 100 },
    });

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    const updateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("UPDATE skill_candidates"),
    );
    expect(updateCall).toBeUndefined();
    expect(result.dismissalsProcessed).toBe(0);
  });

  // ── Test 7 ────────────────────────────────────────────────────────────────
  it("Test 7 — trgm guard: near-duplicate found → INSERT INTO skill_candidates NOT called", async () => {
    setupCorpusQueries({});

    // Custom transaction mock: handles trgm query returning a near-duplicate
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT reflection_runs
      .mockImplementation((sql: string) => {
        if (typeof sql === "string" && sql.includes("similarity(name")) {
          // trgm guard: near-duplicate found
          return Promise.resolve({ rows: [{ id: 10, name: "Existing similar skill" }] });
        }
        return Promise.resolve({ rows: [] });
      });

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse({
        grade: "A",
        newSkills: [{ name: "Handle DB Timeouts", description: "Retry on timeout", confidence: 0.8 }],
      }),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    const insertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCall).toBeUndefined();
    expect(result.changes.skillsCreated).toBe(0);
  });

  // ── Test 8 ────────────────────────────────────────────────────────────────
  it("Test 8 — trgm guard: no near-duplicate → INSERT INTO skill_candidates IS called", async () => {
    setupCorpusQueries({});

    // Custom transaction mock: trgm returns no rows (no near-duplicate)
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT reflection_runs
      .mockImplementation((sql: string) => {
        if (typeof sql === "string" && sql.includes("similarity(name")) {
          // trgm guard: no near-duplicate
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse({
        grade: "A",
        newSkills: [{ name: "Diagnose Silent DB Failure", description: "Check connection pool", confidence: 0.75 }],
      }),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: false });

    const insertCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("INSERT INTO skill_candidates"),
    );
    expect(insertCall).toBeDefined();
    expect(result.changes.skillsCreated).toBe(1);
  });

  // ── Test 9 ────────────────────────────────────────────────────────────────
  it("Test 9 — dry-run: dismissals not written even when LLM proposes them, runId===-1", async () => {
    setupCorpusQueries({});
    // pool.connect should NOT be called in dry-run mode

    mockMessagesCreate.mockResolvedValue(
      makeReflectionResponse({
        grade: "B+",
        candidateDismissals: [
          { candidate_id: 3, reason: "too specific: single incident, will not recur" },
        ],
      }),
    );

    const { runReflection } = await import("../../src/consolidate/reflect.js");
    const result = await runReflection({ triggerSource: "test", dryRun: true });

    expect(result.runId).toBe(-1);

    // pool.connect should NOT have been called
    expect(mockConnect).not.toHaveBeenCalled();

    // mockClient.query should NOT have any UPDATE skill_candidates call
    const updateCall = mockClient.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("UPDATE skill_candidates"),
    );
    expect(updateCall).toBeUndefined();
  });
});
