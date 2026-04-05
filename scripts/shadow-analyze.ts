#!/usr/bin/env npx tsx
/**
 * shadow-analyze.ts — Run relevance analysis on completed turns.
 *
 * Computes embedding similarity between USME-selected items and model responses
 * for shadow_comparisons rows where relevance_analysis_done = false.
 *
 * Usage: npx tsx scripts/shadow-analyze.ts [batchSize]
 */

import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://usme:usme_dev@localhost:5432/usme";

/**
 * Simple cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

async function main() {
  const batchSize = parseInt(process.argv[2] ?? "100", 10);
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // Fetch unanalyzed comparisons
    const { rows: pending } = await pool.query(
      `SELECT id, session_id, turn_index
       FROM shadow_comparisons
       WHERE relevance_analysis_done = false
       ORDER BY created_at ASC
       LIMIT $1`,
      [batchSize],
    );

    if (pending.length === 0) {
      console.log("No pending comparisons to analyze.");
      return;
    }

    console.log(`Analyzing ${pending.length} shadow comparisons...\n`);
    let analyzed = 0;
    let totalRelevance = 0;

    for (const cmp of pending) {
      // Get USME items for this turn (extracted traces with embeddings)
      const { rows: usmeItems } = await pool.query(
        `SELECT content, embedding
         FROM sensory_trace
         WHERE session_id = $1 AND turn_index <= $2
           AND embedding IS NOT NULL AND item_type = 'extracted'
         ORDER BY turn_index DESC
         LIMIT 10`,
        [cmp.session_id, cmp.turn_index],
      );

      // Get the model response for this turn (next assistant message)
      const { rows: modelResp } = await pool.query(
        `SELECT content, embedding
         FROM sensory_trace
         WHERE session_id = $1 AND turn_index = $2
           AND embedding IS NOT NULL
           AND metadata->>'role' = 'assistant'
         LIMIT 1`,
        [cmp.session_id, cmp.turn_index],
      );

      let relevanceScore = 0;

      if (usmeItems.length > 0 && modelResp.length > 0 && modelResp[0].embedding) {
        const respEmb = modelResp[0].embedding;
        const similarities = usmeItems
          .filter((item) => item.embedding != null)
          .map((item) => cosineSimilarity(item.embedding, respEmb));

        if (similarities.length > 0) {
          relevanceScore =
            similarities.reduce((a, b) => a + b, 0) / similarities.length;
        }
      }

      // Check if the model response references USME content
      const modelContent = modelResp[0]?.content ?? "";
      const usmeContents = usmeItems.map((i) => i.content);
      const memoryCited = usmeContents.some((uc) => {
        // Check if key phrases from USME items appear in the response
        const words = uc.split(/\s+/).filter((w) => w.length > 4);
        const matchCount = words.filter((w) =>
          modelContent.toLowerCase().includes(w.toLowerCase()),
        ).length;
        return words.length > 0 && matchCount / words.length > 0.3;
      });

      // Update the comparison row
      await pool.query(
        `UPDATE shadow_comparisons
         SET usme_relevance_score = $1,
             usme_memory_cited = $2,
             relevance_analysis_done = true
         WHERE id = $3`,
        [relevanceScore, memoryCited, cmp.id],
      );

      totalRelevance += relevanceScore;
      analyzed++;
    }

    console.log(`Analyzed ${analyzed} comparisons.`);
    console.log(
      `Average relevance score: ${(totalRelevance / analyzed).toFixed(4)}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
