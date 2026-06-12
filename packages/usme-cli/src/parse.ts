/**
 * Shared CLI option parsing built on Node's built-in util.parseArgs.
 * No hand-rolled flag scanning, no extra dependency.
 */

import { parseArgs } from "node:util";
import type { MemoryTier } from "@usme/core";

export const ALL_TIERS: MemoryTier[] = [
  "sensory_trace",
  "episodes",
  "concepts",
  "skills",
  "entities",
];

/** Superset of options accepted across commands (strict parsing, shared spec). */
const OPTION_SPEC = {
  mode: { type: "string" },
  tiers: { type: "string" },
  "top-k-per-tier": { type: "string" },
  "tier-timeout-ms": { type: "string" },
  "tier-limit": { type: "string", multiple: true },
  limit: { type: "string" },
  "min-score": { type: "string" },
  "min-similarity": { type: "string" },
  "min-confidence": { type: "string" },
  "token-budget": { type: "string" },
  "spreading-depth": { type: "string" },
  "include-constraints": { type: "boolean" },
  "show-scores": { type: "boolean" },
  "show-rejected": { type: "boolean" },
  preview: { type: "string" },
  full: { type: "boolean" },
  json: { type: "boolean" },
  debug: { type: "boolean" },
  all: { type: "boolean" },
  "ignore-case": { type: "boolean" },
  i: { type: "boolean" },
  "database-url": { type: "string" },
  help: { type: "boolean" },
  h: { type: "boolean" },
} as const;

export interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | boolean | string[] | undefined>;
}

export function parse(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTION_SPEC,
    allowPositionals: true,
    strict: true,
  });
  return { positionals, values: values as ParsedArgs["values"] };
}

// ── Typed accessors ──────────────────────────────────────────────

export function str(v: ParsedArgs["values"], key: string): string | undefined {
  const val = v[key];
  return typeof val === "string" ? val : undefined;
}

export function bool(v: ParsedArgs["values"], ...keys: string[]): boolean {
  return keys.some((k) => v[k] === true);
}

export function num(
  v: ParsedArgs["values"],
  key: string,
  fallback?: number,
): number | undefined {
  const raw = str(v, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`--${key} must be a number, got "${raw}"`);
  }
  return n;
}

/** Resolve --tiers "a,b" into a validated MemoryTier[] (defaults to all). */
export function resolveTiers(
  v: ParsedArgs["values"],
  defaults: MemoryTier[] = ALL_TIERS,
): MemoryTier[] {
  const raw = str(v, "tiers");
  if (!raw) return defaults;
  const requested = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const invalid = requested.filter(
    (t) => !ALL_TIERS.includes(t as MemoryTier),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown tier(s): ${invalid.join(", ")}. Valid: ${ALL_TIERS.join(", ")}`,
    );
  }
  return requested as MemoryTier[];
}

/** Parse repeatable --tier-limit tier=N into a map. */
export function resolveTierLimits(
  v: ParsedArgs["values"],
): Partial<Record<MemoryTier, number>> {
  const raw = v["tier-limit"];
  const entries = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const out: Partial<Record<MemoryTier, number>> = {};
  for (const e of entries) {
    const [tier, nStr] = String(e).split("=");
    if (!tier || nStr === undefined) {
      throw new Error(`--tier-limit must be tier=N, got "${e}"`);
    }
    if (!ALL_TIERS.includes(tier as MemoryTier)) {
      throw new Error(`--tier-limit unknown tier "${tier}"`);
    }
    const n = Number(nStr);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`--tier-limit value must be a non-negative number, got "${nStr}"`);
    }
    out[tier as MemoryTier] = n;
  }
  return out;
}

/** Apply per-tier caps then a global cap to an ordered list. */
export function applyTierAndGlobalLimits<T extends { tier: MemoryTier }>(
  items: T[],
  tierLimits: Partial<Record<MemoryTier, number>>,
  globalLimit?: number,
): T[] {
  return applyTierAndGlobalLimitsDetailed(items, tierLimits, globalLimit).items;
}

export function applyTierAndGlobalLimitsDetailed<T extends { tier: MemoryTier }>(
  items: T[],
  tierLimits: Partial<Record<MemoryTier, number>>,
  globalLimit?: number,
): { items: T[]; before: number; afterTierLimits: number; afterGlobalLimit: number } {
  const perTierCount: Partial<Record<MemoryTier, number>> = {};
  let out = items.filter((item) => {
    const cap = tierLimits[item.tier];
    if (cap === undefined) return true;
    const seen = perTierCount[item.tier] ?? 0;
    if (seen >= cap) return false;
    perTierCount[item.tier] = seen + 1;
    return true;
  });
  const afterTierLimits = out.length;
  if (globalLimit !== undefined) out = out.slice(0, globalLimit);
  return {
    items: out,
    before: items.length,
    afterTierLimits,
    afterGlobalLimit: out.length,
  };
}
