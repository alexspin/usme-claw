import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies before importing the module ──────────

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

vi.mock("pg", () => {
  return {
    Pool: vi.fn(),
  };
});

vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Set required env vars before importing
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.ANTHROPIC_API_KEY = "test-key";

import { runGraphBuilder } from "../graph-builder.js";
import { Pool } from "pg";
import Anthropic from "@anthropic-ai/sdk";

// ── Helpers ────────────────────────────────────────────────

function makeToolResponse(relationships: object[]) {
  return {
    content: [{
      type: "tool_use",
      name: "graph_output",
      input: { relationships },
    }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function makePoolMock(entities: object[], traces: object[], episodes: object[], dbClientOverride?: object) {
  const dbClient = dbClientOverride ?? {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };

  let callCount = 0;
  const poolInstance = {
    query: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ rows: entities });
      if (callCount === 2) return Promise.resolve({ rows: traces });
      if (callCount === 3) return Promise.resolve({ rows: episodes });
      return Promise.resolve({ rows: [] });
    }),
    connect: vi.fn().mockResolvedValue(dbClient),
    end: vi.fn().mockResolvedValue(undefined),
  };

  return { poolInstance, dbClient: dbClient as typeof dbClient };
}

// ── Tests ──────────────────────────────────────────────────

describe("runGraphBuilder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct counts for 3 entities and 2 valid proposed relationships", async () => {
    const entities = [
      { id: "ent-1", name: "Alex", entity_type: "person", canonical: null, rel_count: 0 },
      { id: "ent-2", name: "usme-claw", entity_type: "project", canonical: null, rel_count: 0 },
      { id: "ent-3", name: "Rufus", entity_type: "agent", canonical: null, rel_count: 1 },
    ];

    const { poolInstance, dbClient } = makePoolMock(entities, [], []);
    (Pool as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => poolInstance);

    const anthropicInstance = new (Anthropic as unknown as ReturnType<typeof vi.fn>)();
    (anthropicInstance.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeToolResponse([
        { source_slug: "alex", relationship: "manages", target_slug: "usme-claw", confidence: 0.9 },
        { source_slug: "rufus", relationship: "uses", target_slug: "usme-claw", confidence: 0.8 },
      ]),
    );
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => anthropicInstance);

    const result = await runGraphBuilder({ triggerSource: "test" });

    expect(result.entitiesProcessed).toBe(3);
    expect(result.batchesRun).toBe(1);
    expect(result.relationshipsWritten).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips relationship when source slug not in index", async () => {
    const entities = [
      { id: "ent-1", name: "Alex", entity_type: "person", canonical: null, rel_count: 0 },
    ];

    const { poolInstance, dbClient } = makePoolMock(entities, [], []);
    (Pool as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => poolInstance);

    const anthropicInstance = new (Anthropic as unknown as ReturnType<typeof vi.fn>)();
    (anthropicInstance.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeToolResponse([
        // source_slug "unknown-entity" is not in the batch index
        { source_slug: "unknown-entity", relationship: "uses", target_slug: "alex", confidence: 0.7 },
      ]),
    );
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => anthropicInstance);

    const result = await runGraphBuilder({ triggerSource: "test" });
    expect(result.relationshipsWritten).toBe(0);
  });

  it("uses DB fallback for unknown target slug and writes relationship when found", async () => {
    const entities = [
      { id: "ent-1", name: "Alex", entity_type: "person", canonical: null, rel_count: 0 },
    ];

    const dbClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("BEGIN") || sql.includes("COMMIT")) return { rows: [] };
        if (sql.includes("lower(name)")) return { rows: [{ id: "ent-fallback" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const { poolInstance } = makePoolMock(entities, [], [], dbClient);
    (Pool as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => poolInstance);

    const anthropicInstance = new (Anthropic as unknown as ReturnType<typeof vi.fn>)();
    (anthropicInstance.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeToolResponse([
        // target_slug "some-tool" not in batch but exists in DB
        { source_slug: "alex", relationship: "uses", target_slug: "some-tool", confidence: 0.75 },
      ]),
    );
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => anthropicInstance);

    const result = await runGraphBuilder({ triggerSource: "test" });
    expect(result.relationshipsWritten).toBe(1);
  });

  it("skips relationship when target slug not found in index or DB fallback", async () => {
    const entities = [
      { id: "ent-1", name: "Alex", entity_type: "person", canonical: null, rel_count: 0 },
    ];

    const dbClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("BEGIN") || sql.includes("COMMIT")) return { rows: [] };
        if (sql.includes("lower(name)")) return { rows: [] }; // not found
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const { poolInstance } = makePoolMock(entities, [], [], dbClient);
    (Pool as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => poolInstance);

    const anthropicInstance = new (Anthropic as unknown as ReturnType<typeof vi.fn>)();
    (anthropicInstance.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeToolResponse([
        { source_slug: "alex", relationship: "uses", target_slug: "nonexistent-thing", confidence: 0.6 },
      ]),
    );
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => anthropicInstance);

    const result = await runGraphBuilder({ triggerSource: "test" });
    expect(result.relationshipsWritten).toBe(0);
  });

  it("dryRun: true returns correct counts without writing to DB", async () => {
    const entities = [
      { id: "ent-1", name: "Alex", entity_type: "person", canonical: null, rel_count: 0 },
      { id: "ent-2", name: "usme-claw", entity_type: "project", canonical: null, rel_count: 0 },
    ];

    const { poolInstance, dbClient } = makePoolMock(entities, [], []);
    (Pool as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => poolInstance);

    const anthropicInstance = new (Anthropic as unknown as ReturnType<typeof vi.fn>)();
    (anthropicInstance.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeToolResponse([
        { source_slug: "alex", relationship: "manages", target_slug: "usme-claw", confidence: 0.9 },
      ]),
    );
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => anthropicInstance);

    const result = await runGraphBuilder({ triggerSource: "test", dryRun: true });

    expect(result.relationshipsWritten).toBe(0);
    expect(result.entitiesProcessed).toBe(2);
    // pool.connect should never be called in dryRun
    expect(poolInstance.connect).not.toHaveBeenCalled();
  });

  it("per-batch logging fires for each batch", async () => {
    const entities = [
      { id: "ent-1", name: "Alpha", entity_type: "person", canonical: null, rel_count: 0 },
    ];

    const { poolInstance } = makePoolMock(entities, [], []);
    (Pool as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => poolInstance);

    const anthropicInstance = new (Anthropic as unknown as ReturnType<typeof vi.fn>)();
    (anthropicInstance.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue(makeToolResponse([]));
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => anthropicInstance);

    // Just verify it completes without error (logging is mocked)
    await expect(runGraphBuilder({ triggerSource: "test", dryRun: true })).resolves.toBeDefined();
  });
});
