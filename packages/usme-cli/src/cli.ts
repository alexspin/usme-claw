#!/usr/bin/env -S npx tsx
/**
 * usme — read-only CLI / workbench for inspecting USME memory.
 *
 * Command surface: `usme [memory] <subcommand> ...`
 * The leading `memory` token is optional when invoking the binary directly.
 *
 * Subcommands: assemble, search, grep, constraints, inspect, stats
 *
 * Run: npx tsx packages/usme-cli/src/cli.ts <subcommand> [args] [flags]
 */

import { closePool } from "@usme/core";
import { parse } from "./parse.js";
import { runAssemble } from "./commands/assemble.js";
import { runSearch } from "./commands/search.js";
import { runGrep } from "./commands/grep.js";
import { runConstraints } from "./commands/constraints.js";
import { runInspect } from "./commands/inspect.js";
import { runStats } from "./commands/stats.js";

const USAGE = `usme — USME memory workbench (read-only)

Usage: usme [memory] <command> [args] [flags]

Commands:
  assemble "query"        Simulate runtime injection (retrieve→score→critic→pack + constraints)
  search "query"          Semantic ANN search across tiers with relevance metadata
  grep "literal phrase"   Literal ILIKE search for paths/commands/versions/config keys
  constraints list|search Active constraints (always injected separately)
  inspect <uuid>          Full detail for one memory item
  stats                   Counts, freshness, embedding health, recent injections

Common flags:
  --json                  Stable machine-readable output
  --debug                 Write debug timing/count logs to stderr (or USME_CLI_DEBUG=1)
  --tiers a,b,c           Tiers: sensory_trace,episodes,concepts,skills,entities
  --top-k-per-tier N      DB retrieval depth per tier before scoring
  --tier-timeout-ms N     Per-tier semantic retrieval timeout (CLI default 500ms)
  --tier-limit tier=N     Final cap per tier (repeatable)
  --limit N               Global final cap
  --min-score N           Composite-score threshold (minInclusionScore)
  --min-similarity N      Raw embedding-similarity threshold
  --preview N | --full    Content preview length / full content
  --database-url URL      Override DATABASE_URL

assemble-only flags:
  --mode brilliant|smart-efficient|psycho-genius   Preset (default brilliant; flags override)
  --token-budget N        Request token budget for packing
  --spreading-depth 0|1|2 Entity-graph spreading activation (default 2)
  --min-confidence N      Critic confidence threshold
  --include-constraints   Show active constraints as a separate section
  --show-scores           Per-item score breakdown
  --show-rejected         Also list filtered/rejected candidates with reason

Env: OPENAI_API_KEY (search/assemble only), DATABASE_URL.
`;

type Handler = (args: ReturnType<typeof parse>) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  assemble: runAssemble,
  search: runSearch,
  grep: runGrep,
  constraints: runConstraints,
  inspect: runInspect,
  stats: runStats,
};

async function main(): Promise<number> {
  // argv: node tsx cli.ts <command> ...   → drop the first two
  let argv = process.argv.slice(2);

  // Accept an optional leading `memory` token (usme memory <cmd>)
  if (argv[0] === "memory") argv = argv.slice(1);

  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  const args = parse(argv.slice(1));
  if (args.values.help || args.values.h) {
    process.stdout.write(USAGE);
    return 0;
  }

  await handler(args);
  return 0;
}

main()
  .then(async (code) => {
    await closePool().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    await closePool().catch(() => {});
    process.exit(1);
  });
