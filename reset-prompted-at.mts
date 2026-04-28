#!/usr/bin/env npx tsx
/**
 * Reset prompted_at to NULL for all pending skill candidates
 * so they will be delivered at the next 17:00 UTC delivery window.
 */
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://usme:usme_dev@localhost:5432/usme";

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const { rows } = await pool.query(`
  UPDATE skill_candidates
  SET prompted_at = NULL
  WHERE prompted_at IS NOT NULL
    AND approval_status = 'pending'
  RETURNING id, name, quality_tier, confidence, prompted_at
`);

if (rows.length === 0) {
  console.log("No candidates had prompted_at set — nothing to reset.");
} else {
  console.log(`Reset ${rows.length} candidate(s):`);
  for (const r of rows) {
    console.log(`  [${r.id}] ${r.name} (${r.quality_tier}, conf=${r.confidence})`);
  }
}

await pool.end();
