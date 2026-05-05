/**
 * Standalone graph-builder runner — sweeps full entity table, orphans first.
 * Usage: npx tsx run-graph-builder-now.mts [--dry-run]
 */
import { runGraphBuilder } from "./packages/usme-core/src/consolidate/graph-builder.js";

const dryRun = process.argv.includes("--dry-run");

console.log(`[graph-builder] Starting run (dry-run=${dryRun})...`);
const result = await runGraphBuilder({
  triggerSource: "on-demand",
  dryRun,
});

console.log("[graph-builder] Done:", JSON.stringify(result, null, 2));
