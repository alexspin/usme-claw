import OpenAI from "openai";
import pg from "pg";
import { runNightlyConsolidation } from "./src/consolidate/nightly.js";
import { DEFAULT_REASONING_MODEL } from "./src/config/models.js";

async function main() {
  const pool = new pg.Pool({
    host: "localhost", port: 5432, database: "usme",
    user: "usme", password: "usme_dev", max: 5,
  });

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const config = {
    sonnetModel: DEFAULT_REASONING_MODEL,
    opusModel: DEFAULT_REASONING_MODEL,
    reconciliationModel: DEFAULT_REASONING_MODEL,
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
