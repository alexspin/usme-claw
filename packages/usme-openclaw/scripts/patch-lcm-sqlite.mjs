#!/usr/bin/env node
/**
 * patch-lcm-sqlite.mjs
 *
 * Patches the installed lossless-claw connection.ts to add performance PRAGMAs
 * that are missing from the upstream source:
 *   - mmap_size=256MB  (memory-mapped I/O; eliminates buffer-pool reads for hot data)
 *   - cache_size=64MB  (larger page cache)
 *   - synchronous=NORMAL  (safe with WAL, fewer fsyncs)
 *
 * Run automatically as a postbuild step. Safe to re-run (idempotent).
 * Must be re-applied whenever lossless-claw is reinstalled/upgraded.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve lossless-claw connection.ts relative to this repo root
const LCM_CONNECTION = resolve(
  __dirname,
  "../../../../../.openclaw/extensions/lossless-claw/src/db/connection.ts"
);

const MARKER = "// [usme-patch] sqlite-perf";

const ORIGINAL = `  db.exec("PRAGMA journal_mode = WAL");`;

const PATCHED = `  db.exec("PRAGMA journal_mode = WAL");
  ${MARKER}
  db.exec("PRAGMA mmap_size = 268435456"); // 256 MB memory-mapped I/O
  db.exec("PRAGMA cache_size = -65536");   // 64 MB page cache
  db.exec("PRAGMA synchronous = NORMAL");  // safe with WAL, fewer fsyncs`;

let src;
try {
  src = readFileSync(LCM_CONNECTION, "utf8");
} catch (e) {
  console.warn(`[patch-lcm-sqlite] lossless-claw not found at ${LCM_CONNECTION} — skipping`);
  process.exit(0);
}

if (src.includes(MARKER)) {
  console.log("[patch-lcm-sqlite] already patched — skipping");
  process.exit(0);
}

if (!src.includes(ORIGINAL)) {
  console.warn("[patch-lcm-sqlite] expected anchor line not found — lossless-claw may have changed; skipping");
  process.exit(0);
}

const patched = src.replace(ORIGINAL, PATCHED);
writeFileSync(LCM_CONNECTION, patched, "utf8");
console.log("[patch-lcm-sqlite] patched", LCM_CONNECTION);
