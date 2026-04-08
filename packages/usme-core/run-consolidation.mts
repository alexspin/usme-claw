import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import { runNightlyConsolidation } from "/home/alex/ai/projects/rufus-projects/usme-claw/packages/usme-core/src/consolidate/nightly.js";

async function main() {
  const pool = new pg.Pool({
    host: "localhost", port: 5432, database: "usme",
    user: "usme", password: "usme_dev", max: 5,
  });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const config = {
    sonnetModel: "claude-sonnet-4-6",
    opusModel: "claude-sonnet-4-6",
    embeddingApiKey: process.env.OPENAI_API_KEY,
  };

  console.log("[manual] Starting nightly consolidation...");
  try {
    const result = await runNightlyConsolidation(client, pool, config);
    console.log("[manual] DONE:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("[manual] FAILED:", err);
  } finally {
    await pool.end();
  }
}

main();
