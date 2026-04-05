/**
 * Integration test: extraction pipeline writes sensory_trace rows.
 *
 * Requires a running Postgres instance (docker-compose.test.yml).
 * Skip with: SKIP_INTEGRATION=1
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { insertSensoryTrace, getUnepisodifiedTraces } from "../../src/db/queries.js";

const SKIP = process.env.SKIP_INTEGRATION === "1" || !process.env.DATABASE_URL;

describe.skipIf(SKIP)("extraction pipeline", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString:
        process.env.DATABASE_URL ??
        "postgres://usme:usme_test@localhost:5433/usme_test",
    });
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("writes sensory_trace rows with correct types", async () => {
    const id = await insertSensoryTrace(pool, {
      session_id: "extract-test-session",
      turn_index: 1,
      item_type: "extracted",
      memory_type: "fact",
      content: "The user prefers TypeScript over JavaScript",
      embedding: null,
      provenance_kind: "model",
      provenance_ref: null,
      utility_prior: "high",
      tags: ["preference", "language"],
      extractor_ver: "fact_extraction_v1",
      metadata: { source: "test" },
      episodified_at: null,
      expires_at: null,
    });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    // Verify it shows up in un-episodified traces
    const traces = await getUnepisodifiedTraces(pool, 100);
    const found = traces.find((t) => t.id === id);
    expect(found).toBeDefined();
    expect(found!.item_type).toBe("extracted");
    expect(found!.memory_type).toBe("fact");
    expect(found!.utility_prior).toBe("high");
    expect(found!.tags).toEqual(["preference", "language"]);
  });

  it("writes verbatim sensory_trace rows", async () => {
    const id = await insertSensoryTrace(pool, {
      session_id: "extract-test-session",
      turn_index: 0,
      item_type: "verbatim",
      memory_type: null,
      content: "Hello, how can I help you today?",
      embedding: null,
      provenance_kind: "user",
      provenance_ref: null,
      utility_prior: "medium",
      tags: [],
      extractor_ver: null,
      metadata: {},
      episodified_at: null,
      expires_at: null,
    });

    expect(typeof id).toBe("string");
  });
});
