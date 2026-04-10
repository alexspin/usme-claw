#!/usr/bin/env node
/**
 * Lists pending skill candidates from the skill_candidates table.
 * Runnable directly via: npx tsx packages/usme-core/src/scripts/list-candidates.ts
 *
 * Args:
 *   --include-drafts   Show draft-tier (confidence < 0.7)
 *   --force            Show all, ignoring prompted_at/defer filters
 *   --json             Output raw JSON to stdout instead of formatted table
 */

import { getPool, getPromoteCandidates, buildPromoteCard, closePool } from "../index.js";

async function main() {
  const args = process.argv.slice(2);
  const includeDrafts = args.includes("--include-drafts");
  const forceAll = args.includes("--force");
  const jsonMode = args.includes("--json");

  const pool = getPool();

  try {
    const candidates = await getPromoteCandidates({ includeDrafts, forceAll }, pool);

    if (jsonMode) {
      process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
    } else if (candidates.length === 0) {
      process.stdout.write(
        "No candidates ready for review.\n(Use --force to see previously prompted candidates, --include-drafts for lower-confidence items.)\n",
      );
    } else {
      process.stdout.write(buildPromoteCard(candidates) + "\n");
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
