#!/usr/bin/env npx tsx
/**
 * shadow-tail.ts — Live tail of shadow_comparisons table.
 *
 * Polls for new rows and displays formatted output.
 * Usage: npx tsx scripts/shadow-tail.ts [pollIntervalMs]
 */

import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://usme:usme_dev@localhost:5432/usme";

async function main() {
  const pollInterval = parseInt(process.argv[2] ?? "2000", 10);
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  let lastSeen: Date | null = null;

  console.log(`[shadow-tail] Polling every ${pollInterval}ms. Ctrl+C to stop.\n`);

  const poll = async () => {
    try {
      const whereClause = lastSeen
        ? "WHERE created_at > $1"
        : "";
      const params = lastSeen ? [lastSeen.toISOString()] : [];

      const { rows } = await pool.query(
        `SELECT * FROM shadow_comparisons
         ${whereClause}
         ORDER BY created_at ASC
         LIMIT 50`,
        params,
      );

      for (const row of rows) {
        const ts = new Date(row.created_at).toISOString().substring(11, 23);
        const mode = (row.usme_mode ?? "?").padEnd(16);
        const latency = row.usme_latency_ms != null
          ? `${Math.round(row.usme_latency_ms)}ms`
          : "  -  ";
        const delta = row.token_delta != null
          ? `${row.token_delta > 0 ? "+" : ""}${row.token_delta}`
          : " - ";
        const overlap = row.overlap_score != null
          ? row.overlap_score.toFixed(3)
          : "  -  ";
        const tiers = (row.usme_tiers_contributed ?? []).join(",") || "-";
        const query = (row.query_preview ?? "").substring(0, 60);

        console.log(
          `${ts} | ${row.session_id.substring(0, 12)}… | ${mode} | lat=${latency.padStart(6)} | Δtok=${delta.toString().padStart(6)} | overlap=${overlap} | tiers=${tiers} | ${query}`,
        );
        lastSeen = new Date(row.created_at);
      }
    } catch (err) {
      console.error("[shadow-tail] poll error:", err);
    }
  };

  // Initial poll
  await poll();

  // Continue polling
  const interval = setInterval(poll, pollInterval);

  process.on("SIGINT", async () => {
    clearInterval(interval);
    await pool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
