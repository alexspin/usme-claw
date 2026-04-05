#!/usr/bin/env npx tsx
/**
 * shadow-report.ts — Per-session and global shadow comparison report.
 *
 * Usage: npx tsx scripts/shadow-report.ts [sessionId]
 */

import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://usme:usme_dev@localhost:5432/usme";

async function main() {
  const sessionFilter = process.argv[2] ?? null;
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    const whereClause = sessionFilter
      ? "WHERE session_id = $1"
      : "";
    const params = sessionFilter ? [sessionFilter] : [];

    // Global stats
    const { rows: stats } = await pool.query(
      `SELECT
         COUNT(*)::int AS turn_count,
         ROUND(AVG(token_delta)::numeric, 1) AS avg_token_delta,
         ROUND(AVG(usme_latency_ms)::numeric, 1) AS avg_usme_latency_ms,
         ROUND(AVG(lcm_latency_ms)::numeric, 1) AS avg_lcm_latency_ms,
         ROUND(AVG(overlap_score)::numeric, 3) AS avg_overlap_score,
         ROUND(AVG(usme_relevance_score)::numeric, 3) AS avg_relevance_score,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY usme_latency_ms)::numeric, 1) AS p95_latency_ms
       FROM shadow_comparisons
       ${whereClause}`,
      params,
    );

    const s = stats[0];
    console.log("=== USME Shadow Report ===");
    if (sessionFilter) console.log(`Session: ${sessionFilter}`);
    console.log(`Turns:              ${s.turn_count}`);
    console.log(`Avg token delta:    ${s.avg_token_delta}`);
    console.log(`Avg USME latency:   ${s.avg_usme_latency_ms}ms`);
    console.log(`Avg LCM latency:    ${s.avg_lcm_latency_ms}ms`);
    console.log(`P95 USME latency:   ${s.p95_latency_ms}ms`);
    console.log(`Avg overlap score:  ${s.avg_overlap_score}`);
    console.log(`Avg relevance:      ${s.avg_relevance_score}`);

    // Tiers contributed breakdown
    const { rows: tiers } = await pool.query(
      `SELECT unnest(usme_tiers_contributed) AS tier, COUNT(*)::int AS cnt
       FROM shadow_comparisons
       ${whereClause}
       GROUP BY tier
       ORDER BY cnt DESC`,
      params,
    );

    if (tiers.length > 0) {
      console.log("\nTiers contributed:");
      for (const t of tiers) {
        console.log(`  ${t.tier}: ${t.cnt} turns`);
      }
    }

    // Per-session summary (when no filter)
    if (!sessionFilter) {
      const { rows: sessions } = await pool.query(
        `SELECT
           session_id,
           COUNT(*)::int AS turns,
           ROUND(AVG(usme_latency_ms)::numeric, 1) AS avg_latency,
           ROUND(AVG(overlap_score)::numeric, 3) AS avg_overlap
         FROM shadow_comparisons
         GROUP BY session_id
         ORDER BY MAX(created_at) DESC
         LIMIT 20`,
      );

      if (sessions.length > 0) {
        console.log("\nPer-session (latest 20):");
        console.log(
          "  " +
            "session_id".padEnd(40) +
            "turns".padStart(8) +
            "avg_lat".padStart(10) +
            "overlap".padStart(10),
        );
        for (const r of sessions) {
          console.log(
            "  " +
              r.session_id.padEnd(40) +
              String(r.turns).padStart(8) +
              String(r.avg_latency).padStart(10) +
              String(r.avg_overlap).padStart(10),
          );
        }
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
