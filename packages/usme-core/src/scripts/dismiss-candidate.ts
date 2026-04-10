#!/usr/bin/env node
/**
 * Permanently dismisses a skill candidate.
 * Runnable directly via: npx tsx packages/usme-core/src/scripts/dismiss-candidate.ts <id>
 *
 * Args:
 *   <id>   Numeric candidate ID (required)
 */

import { getPool, closePool, markCandidateDismissed } from "../index.js";

async function main() {
  const args = process.argv.slice(2);
  const idStr = args[0];

  if (!idStr || isNaN(Number(idStr))) {
    process.stderr.write("Usage: dismiss-candidate.ts <numeric-candidate-id>\n");
    process.exit(1);
  }

  const candidateId = parseInt(idStr, 10);
  const pool = getPool();

  try {
    await markCandidateDismissed(candidateId, pool);
    process.stdout.write(`✓ Candidate ${candidateId} dismissed.\n`);
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
