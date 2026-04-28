#!/usr/bin/env npx tsx
/**
 * Backfill importance scores for episodes stuck at the default value of 5.
 * Uses the same Haiku tool_use call as stepEpisodify in nightly.ts.
 *
 * Usage:
 *   npx tsx scripts/backfill-importance.mts
 *   npx tsx scripts/backfill-importance.mts --dry-run   # preview only, no writes
 */

import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import { z } from "zod";

const DRY_RUN = process.argv.includes("--dry-run");

const pool = new pg.Pool({
  host: process.env.USME_DB_HOST ?? "localhost",
  port: Number(process.env.USME_DB_PORT ?? 5432),
  database: process.env.USME_DB_NAME ?? "usme",
  user: process.env.USME_DB_USER ?? "usme",
  password: process.env.USME_DB_PASSWORD ?? "usme_dev",
});

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const FAST_MODEL = process.env.USME_FAST_MODEL ?? "claude-haiku-4-5";

const ImportanceSchema = z.object({
  importance_score: z.number().min(1).max(10),
});

function extractToolInput(response: Anthropic.Message, toolName: string): unknown {
  const block = response.content.find(
    (b) => b.type === "tool_use" && b.name === toolName,
  );
  return block && block.type === "tool_use" ? block.input : undefined;
}

async function scoreEpisode(summary: string): Promise<number> {
  const response = await client.messages.create({
    model: FAST_MODEL,
    max_tokens: 256,
    tools: [
      {
        name: "assign_importance",
        description: "Assign an importance score to a memory episode",
        input_schema: {
          type: "object" as const,
          properties: {
            importance_score: {
              type: "number",
              description:
                "Score 1-10: 1=trivial, 10=critical. Consider specificity, actionability, uniqueness, future relevance.",
            },
          },
          required: ["importance_score"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "assign_importance" },
    messages: [
      {
        role: "user",
        content: `Assign an importance score (1-10) to this memory episode:\n\n${summary}`,
      },
    ],
  });

  const result = ImportanceSchema.safeParse(
    extractToolInput(response, "assign_importance"),
  );
  if (!result.success) {
    throw new Error(`Schema validation failed: ${result.error.message}`);
  }
  return Math.round(result.data.importance_score);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);

  const { rows } = await pool.query<{ id: string; summary: string; created_at: Date }>(
    "SELECT id, summary, created_at FROM episodes WHERE importance_score = 5 ORDER BY created_at ASC",
  );

  console.log(`Found ${rows.length} episodes with importance_score = 5\n`);

  if (rows.length === 0) {
    console.log("Nothing to backfill.");
    await pool.end();
    return;
  }

  let updated = 0;
  let failed = 0;
  const results: Array<{ id: string; score: number; preview: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const episode = rows[i];
    const preview = episode.summary.slice(0, 80).replace(/\n/g, " ");
    process.stdout.write(`[${i + 1}/${rows.length}] Scoring... ${preview}...`);

    try {
      const score = await scoreEpisode(episode.summary);
      results.push({ id: episode.id, score, preview });

      if (!DRY_RUN) {
        await pool.query(
          "UPDATE episodes SET importance_score = $1 WHERE id = $2",
          [score, episode.id],
        );
        updated++;
      }

      process.stdout.write(` → ${score}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(` → ERROR: ${err}\n`);
    }

    // Small delay to avoid rate limiting
    if (i < rows.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log("\n--- Summary ---");
  if (DRY_RUN) {
    console.log("Proposed scores (not written):");
    for (const r of results) {
      console.log(`  [${r.score}] ${r.preview}...`);
    }
  } else {
    console.log(`Updated: ${updated}`);
    console.log(`Failed:  ${failed}`);
  }

  // Final distribution
  const { rows: dist } = await pool.query(
    "SELECT importance_score, COUNT(*) FROM episodes GROUP BY importance_score ORDER BY importance_score",
  );
  console.log("\nFinal distribution:");
  for (const row of dist) {
    console.log(`  score ${row.importance_score}: ${row.count} episodes`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
