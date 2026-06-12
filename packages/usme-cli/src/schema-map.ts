/**
 * Per-tier table metadata for the SQL-backed commands (grep, inspect, stats).
 * The relevance path (search/assemble) does NOT use this — it reuses core's
 * retrieve(). This map only covers capabilities core does not provide.
 *
 * SECURITY: `table`, `textCols`, `contentExpr`, and `activePredicate` are
 * interpolated directly into SQL by the commands that use them. They MUST remain
 * hardcoded, trusted constants — never wire user input into these fields. All
 * user-supplied values (search phrases, ids, limits) are passed as bound
 * parameters ($1, $2, …) by the commands, never interpolated.
 */

import type { MemoryTier } from "@usme/core";

export interface TierTable {
  table: string;
  /** Columns to match for literal grep. */
  textCols: string[];
  /** SQL expression that yields the human "content" for display. */
  contentExpr: string;
  /** Predicate for "active" rows, or null if the tier has no active concept. */
  activePredicate: string | null;
}

export const TIER_TABLES: Record<MemoryTier, TierTable> = {
  sensory_trace: {
    table: "sensory_trace",
    textCols: ["content"],
    contentExpr: "content",
    activePredicate: null,
  },
  episodes: {
    table: "episodes",
    textCols: ["summary"],
    contentExpr: "summary",
    activePredicate: null,
  },
  concepts: {
    table: "concepts",
    textCols: ["content"],
    contentExpr: "content",
    activePredicate: "is_active = true",
  },
  skills: {
    table: "skills",
    textCols: ["name", "description"],
    contentExpr: "name || ': ' || COALESCE(description, '')",
    activePredicate: "status = 'active'",
  },
  entities: {
    table: "entities",
    textCols: ["name", "canonical"],
    contentExpr: "name || ': ' || COALESCE(canonical, '')",
    activePredicate: null,
  },
};
