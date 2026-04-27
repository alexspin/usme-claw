#!/usr/bin/env node
/**
 * patch-claude-flow-oauth.mjs
 *
 * Patches @claude-flow/cli's headless worker executor to strip ANTHROPIC_API_KEY
 * from child process environments before spawning `claude --print` workers.
 *
 * Without this patch, claude-flow inherits ANTHROPIC_API_KEY from the shell and
 * all headless claude invocations bill against the API key rather than the
 * CLAUDE_CODE_OAUTH_TOKEN subscription. With this patch applied, workers use
 * OAuth (subscription) billing.
 *
 * Run automatically as a postbuild step. Safe to re-run (idempotent).
 * Must be re-applied whenever @claude-flow/cli is reinstalled/upgraded.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXECUTOR = resolve(
  __dirname,
  "../../../../../node_modules/@claude-flow/cli/dist/src/services/headless-worker-executor.js"
);

const MARKER = "// [usme-patch] strip-api-key-for-oauth";

const ORIGINAL = `            const env = {
                ...process.env,
                CLAUDE_CODE_HEADLESS: 'true',`;

const PATCHED = `            ${MARKER}
            const { ANTHROPIC_API_KEY: _stripped, ...parentEnv } = process.env;
            const env = {
                ...parentEnv,
                CLAUDE_CODE_HEADLESS: 'true',`;

let src;
try {
  src = readFileSync(EXECUTOR, "utf8");
} catch {
  console.warn(`[patch-claude-flow-oauth] @claude-flow/cli not found at ${EXECUTOR} — skipping`);
  process.exit(0);
}

if (src.includes(MARKER)) {
  console.log("[patch-claude-flow-oauth] already patched — skipping");
  process.exit(0);
}

if (!src.includes(ORIGINAL)) {
  console.warn("[patch-claude-flow-oauth] expected anchor not found — @claude-flow/cli may have changed; skipping");
  process.exit(0);
}

const patched = src.replace(ORIGINAL, PATCHED);
writeFileSync(EXECUTOR, patched, "utf8");
console.log("[patch-claude-flow-oauth] patched", EXECUTOR);
