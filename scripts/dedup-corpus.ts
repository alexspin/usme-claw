/**
 * dedup-corpus.ts — Remove near-duplicate sensory_trace rows from the corpus.
 *
 * Strategy:
 *   1. Load all sensory_trace rows that have embeddings, ordered by created_at ASC
 *      (oldest first = keep earliest, delete later duplicates)
 *   2. For each row (in order), find all newer rows with cosine similarity > 0.95
 *      and delete them.
 *   3. Print: "N rows before, N deleted, N remaining"
 *
 * Usage:
 *   DATABASE_URL=postgres://usme:usme_dev@localhost:5432/usme npx tsx scripts/dedup-corpus.ts
 */

import pg from "pg";

const SIMILARITY_THRESHOLD = 0.95;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://usme:usme_dev@localhost:5432/usme";

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // Count total rows before
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS n FROM sensory_trace WHERE embedding IS NOT NULL`
    );
    const totalBefore = parseInt(countRows[0].n, 10);
    console.log(`Rows before: ${totalBefore}`);

    // Load all rows with embeddings ordered oldest-first
    const { rows } = await pool.query(
      `SELECT id, embedding::text AS embedding_text
       FROM sensory_trace
       WHERE embedding IS NOT NULL
       ORDER BY created_at ASC`
    );

    console.log(`Loaded ${rows.length} rows with embeddings`);

    const deletedIds = new Set<string>();
    let deleteCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (deletedIds.has(row.id)) continue; // already marked for deletion

      // Find all later rows with cosine similarity > threshold
      const laterIds = rows
        .slice(i + 1)
        .filter((r) => !deletedIds.has(r.id))
        .map((r) => r.id);

      if (laterIds.length === 0) continue;

      const { rows: similarRows } = await pool.query(
        `SELECT id
         FROM sensory_trace
         WHERE id = ANY($1::uuid[])
           AND 1 - (embedding <=> $2::vector) > $3`,
        [laterIds, row.embedding_text, SIMILARITY_THRESHOLD]
      );

      for (const sim of similarRows) {
        deletedIds.add(sim.id);
      }
    }

    // Delete all identified duplicates
    if (deletedIds.size > 0) {
      const idsArray = Array.from(deletedIds);
      await pool.query(
        `DELETE FROM sensory_trace WHERE id = ANY($1::uuid[])`,
        [idsArray]
      );
      deleteCount = idsArray.length;
    }

    const remaining = totalBefore - deleteCount;
    console.log(
      `${totalBefore} rows before, ${deleteCount} deleted, ${remaining} remaining`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("dedup-corpus failed:", err);
  process.exit(1);
});
