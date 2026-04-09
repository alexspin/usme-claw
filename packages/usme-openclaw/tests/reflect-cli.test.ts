/**
 * Tests for the reflect CLI command (commands/reflect.ts).
 *
 * Verifies:
 *   - --dry-run flag is passed through to runReflection, making no DB writes
 *   - --status queries reflection_runs, no INSERT/UPDATE
 *   - --last N queries reflection_runs LIMIT N
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @usme/core ───────────────────────────────────────────────────────────

const mockRunReflection = vi.fn();
const mockPoolQuery = vi.fn();

vi.mock("@usme/core", () => ({
  runReflection: mockRunReflection,
  getPool: vi.fn().mockReturnValue({
    query: mockPoolQuery,
  }),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reflectCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: runReflection returns a successful dry-run result
    mockRunReflection.mockResolvedValue({
      runId: -1,
      changes: { conceptsUpdated: 0, skillsCreated: 0, contradictionsResolved: 0, entitiesUpdated: 0, episodesPromoted: 0 },
      overallAssessment: "All good.",
      durationMs: 100,
    });
  });

  it("--dry-run passes dryRun=true to runReflection and makes no DB writes", async () => {
    const { reflectCommand } = await import("../src/commands/reflect.js");

    await reflectCommand(["--dry-run"]);

    expect(mockRunReflection).toHaveBeenCalledOnce();
    const opts = mockRunReflection.mock.calls[0][0];
    expect(opts.dryRun).toBe(true);

    // Pool.query should not have been called for INSERT/UPDATE
    const writeCalls = mockPoolQuery.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        /INSERT|UPDATE/i.test(call[0] as string),
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("without --dry-run, dryRun=false is passed", async () => {
    const { reflectCommand } = await import("../src/commands/reflect.js");

    await reflectCommand([]);

    expect(mockRunReflection).toHaveBeenCalledOnce();
    const opts = mockRunReflection.mock.calls[0][0];
    expect(opts.dryRun).toBe(false);
  });

  it("--model haiku maps to claude-haiku-4-5", async () => {
    const { reflectCommand } = await import("../src/commands/reflect.js");

    await reflectCommand(["--model", "haiku"]);

    const opts = mockRunReflection.mock.calls[0][0];
    expect(opts.model).toBe("claude-haiku-4-5");
  });

  it("--model sonnet maps to claude-sonnet-4-5", async () => {
    const { reflectCommand } = await import("../src/commands/reflect.js");

    await reflectCommand(["--model", "sonnet"]);

    const opts = mockRunReflection.mock.calls[0][0];
    expect(opts.model).toBe("claude-sonnet-4-5");
  });

  it("--status queries reflection_runs, does not call runReflection", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const { reflectCommand } = await import("../src/commands/reflect.js");

    await reflectCommand(["--status"]);

    // runReflection should NOT be called
    expect(mockRunReflection).not.toHaveBeenCalled();
    // pool.query should be called once for SELECT
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/SELECT.*FROM reflection_runs/i);
    expect(sql).toMatch(/LIMIT 1/i);
  });

  it("--last 5 queries reflection_runs with LIMIT 5", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const { reflectCommand } = await import("../src/commands/reflect.js");

    await reflectCommand(["--last", "5"]);

    expect(mockRunReflection).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT.*FROM reflection_runs/i);
    expect(params).toContain(5);
  });

  it("triggerSource is always 'cli'", async () => {
    const { reflectCommand } = await import("../src/commands/reflect.js");

    await reflectCommand([]);

    const opts = mockRunReflection.mock.calls[0][0];
    expect(opts.triggerSource).toBe("cli");
  });
});
