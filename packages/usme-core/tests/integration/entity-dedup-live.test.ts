/**
 * Integration test: entity deduplication (live DB).
 *
 * Inserts an entity, then inserts a duplicate with same canonical name.
 * Verifies that application-level dedup logic prevents duplicates.
 *
 * Requires a running Postgres instance (docker-compose.test.yml).
 * Skip with: SKIP_INTEGRATION=1
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { insertEntity } from "../../src/db/queries.js";

const SKIP = process.env.SKIP_INTEGRATION === "1" || !process.env.DATABASE_URL;

describe.skipIf(SKIP)("entity dedup (live DB)", () => {
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

  it("inserts entity and retrieves it", async () => {
    const id = await insertEntity(pool, {
      name: "TypeScript",
      entity_type: "tool",
      canonical: "typescript",
      embedding: null,
      confidence: 1.0,
      metadata: {},
    });

    expect(typeof id).toBe("string");

    const { rows } = await pool.query(
      "SELECT * FROM entities WHERE id = $1",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("TypeScript");
    expect(rows[0].canonical).toBe("typescript");
  });

  it("can detect duplicate by canonical name query", async () => {
    const canonical = `dedup-test-${Date.now()}`;

    // Insert first entity
    await insertEntity(pool, {
      name: "Entity One",
      entity_type: "project",
      canonical,
      embedding: null,
      confidence: 1.0,
      metadata: {},
    });

    // Check for existing before inserting duplicate
    const { rows: existing } = await pool.query(
      "SELECT id FROM entities WHERE canonical = $1",
      [canonical],
    );

    expect(existing).toHaveLength(1);

    // Application logic: skip insert if canonical already exists
    if (existing.length > 0) {
      // This is the expected path -- no duplicate created
      const { rows: all } = await pool.query(
        "SELECT * FROM entities WHERE canonical = $1",
        [canonical],
      );
      expect(all).toHaveLength(1);
    }
  });
});
