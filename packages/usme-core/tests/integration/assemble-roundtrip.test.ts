/**
 * Integration test: assemble() roundtrip.
 *
 * Requires a running Postgres instance (docker-compose.test.yml).
 * Skip with: SKIP_INTEGRATION=1
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assemble } from "../../src/assemble/index.js";
import type { AssembleRequest, AssembleOptions } from "../../src/assemble/index.js";

const SKIP = process.env.SKIP_INTEGRATION === "1" || !process.env.DATABASE_URL;

describe.skipIf(SKIP)("assemble() roundtrip", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString:
        process.env.DATABASE_URL ??
        "postgres://usme:usme_test@localhost:5433/usme_test",
    });
    // Verify connection
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns AssembleResult with correct shape", async () => {
    const request: AssembleRequest = {
      query: "What is the project about?",
      sessionId: "test-session-1",
      conversationHistory: [],
      mode: "brilliant",
      tokenBudget: 30000,
      turnIndex: 1,
    };

    const options: AssembleOptions = {
      pool,
      queryEmbedding: new Array(1536).fill(0),
    };

    const result = await assemble(request, options);

    // Verify shape
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("metadata");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.metadata).toHaveProperty("itemsConsidered");
    expect(result.metadata).toHaveProperty("itemsSelected");
    expect(result.metadata).toHaveProperty("tiersQueried");
    expect(result.metadata).toHaveProperty("durationMs");
    expect(result.metadata).toHaveProperty("mode");
    expect(result.metadata).toHaveProperty("tokenBudget");
    expect(result.metadata).toHaveProperty("tokensUsed");
    expect(result.metadata.mode).toBe("brilliant");
    expect(typeof result.metadata.durationMs).toBe("number");
  });

  it("respects token budget", async () => {
    const request: AssembleRequest = {
      query: "test",
      sessionId: "test-session-2",
      conversationHistory: [],
      mode: "smart-efficient",
      tokenBudget: 1000,
      turnIndex: 1,
    };

    const options: AssembleOptions = {
      pool,
      queryEmbedding: new Array(1536).fill(0),
    };

    const result = await assemble(request, options);
    // tokensUsed should not exceed budget fraction
    const maxBudget = Math.floor(1000 * 0.25); // smart-efficient fraction
    expect(result.metadata.tokensUsed).toBeLessThanOrEqual(maxBudget);
  });
});
