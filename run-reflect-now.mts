/**
 * Standalone reflect runner — call runReflection() directly without plugin/gateway.
 * Usage: npx tsx run-reflect-now.mts [--dry-run]
 */
import { runReflection } from "./packages/usme-core/src/consolidate/reflect.js";

const dryRun = process.argv.includes("--dry-run");

console.log(`[reflect] Starting reflection run (dry-run=${dryRun})...`);
const result = await runReflection({
  triggerSource: "on-demand",
  model: "claude-sonnet-4-5",
  dryRun,
});

console.log("[reflect] Done:", JSON.stringify(result, null, 2));
