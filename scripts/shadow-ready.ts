#!/usr/bin/env npx tsx
/**
 * shadow-ready.ts — Promotion readiness check.
 *
 * Checks all criteria for promoting from shadow to active mode:
 *   - >=500 turns observed
 *   - P95 latency <= 150ms
 *   - Extraction success >= 95%
 *   - Quality (overlap) >= 60%
 *   - Relevance score >= 50%
 *   - Zero unhandled exceptions
 *
 * Usage: npx tsx scripts/shadow-ready.ts
 */

import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://usme:usme_dev@localhost:5432/usme";

interface Criterion {
  name: string;
  pass: boolean;
  value: string;
  threshold: string;
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const criteria: Criterion[] = [];

  try {
    // Basic stats
    const { rows: stats } = await pool.query(
      `SELECT
         COUNT(*)::int AS turn_count,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY usme_latency_ms)::numeric, 1) AS p95_latency,
         ROUND(AVG(overlap_score)::numeric, 4) AS avg_overlap,
         ROUND(AVG(usme_relevance_score) FILTER (WHERE relevance_analysis_done)::numeric, 4) AS avg_relevance,
         COUNT(*) FILTER (WHERE usme_latency_ms IS NULL)::int AS exception_count
       FROM shadow_comparisons`,
    );

    const s = stats[0];
    const turnCount = s.turn_count ?? 0;
    const p95 = parseFloat(s.p95_latency) || 0;
    const avgOverlap = parseFloat(s.avg_overlap) || 0;
    const avgRelevance = parseFloat(s.avg_relevance) || 0;
    const exceptions = s.exception_count ?? 0;

    // Extraction rate: traces with extracted items / total verbatim traces
    const { rows: extractionStats } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE item_type = 'verbatim')::int AS verbatim,
         COUNT(*) FILTER (WHERE item_type = 'extracted')::int AS extracted
       FROM sensory_trace`,
    );
    const verbatim = extractionStats[0].verbatim ?? 0;
    const extracted = extractionStats[0].extracted ?? 0;
    const extractionRate = verbatim > 0 ? extracted / verbatim : 0;

    criteria.push({
      name: "Turns observed",
      pass: turnCount >= 500,
      value: String(turnCount),
      threshold: ">=500",
    });

    criteria.push({
      name: "P95 latency",
      pass: p95 <= 150,
      value: `${p95}ms`,
      threshold: "<=150ms",
    });

    criteria.push({
      name: "Extraction rate",
      pass: extractionRate >= 0.95,
      value: `${(extractionRate * 100).toFixed(1)}%`,
      threshold: ">=95%",
    });

    criteria.push({
      name: "Quality (overlap)",
      pass: avgOverlap >= 0.6,
      value: `${(avgOverlap * 100).toFixed(1)}%`,
      threshold: ">=60%",
    });

    criteria.push({
      name: "Relevance score",
      pass: avgRelevance >= 0.5,
      value: `${(avgRelevance * 100).toFixed(1)}%`,
      threshold: ">=50%",
    });

    criteria.push({
      name: "Exceptions",
      pass: exceptions === 0,
      value: String(exceptions),
      threshold: "0",
    });

    // Output
    console.log("=== USME Shadow -> Active Promotion Readiness ===\n");

    let allPass = true;
    for (const c of criteria) {
      const icon = c.pass ? "PASS" : "FAIL";
      console.log(
        `  [${icon}] ${c.name.padEnd(22)} ${c.value.padStart(10)} (threshold: ${c.threshold})`,
      );
      if (!c.pass) allPass = false;
    }

    console.log("");
    if (allPass) {
      console.log("RESULT: READY for promotion to active mode.");
    } else {
      const failing = criteria.filter((c) => !c.pass).map((c) => c.name);
      console.log(`RESULT: NOT READY. Failing: ${failing.join(", ")}`);
    }

    process.exit(allPass ? 0 : 1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
