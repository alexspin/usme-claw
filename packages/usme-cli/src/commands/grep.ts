/**
 * `usme memory grep "literal phrase"`
 *
 * Literal text search (ILIKE) across memory rows — paths, commands, version
 * strings, config keys, exact phrases. No embeddings required. READ-ONLY.
 * Searches the selected tiers plus the constraints table (shown separately).
 */

import type { MemoryTier } from "@usme/core";
import type { ParsedArgs } from "../parse.js";
import { str, num, bool, resolveTiers } from "../parse.js";
import { resolveDb, redactConnString } from "../db.js";
import { createDebugLogger } from "../debug.js";
import { TIER_TABLES } from "../schema-map.js";
import { preview, isoDate, emitJson, line, meta } from "../format.js";

interface GrepHit {
  id: string;
  tier: string;
  content: string;
  createdAt: Date;
}

export async function runGrep(args: ParsedArgs): Promise<void> {
  const phrase = args.positionals[0];
  if (!phrase) throw new Error('grep requires a phrase: usme memory grep "literal phrase"');

  const json = bool(args.values, "json");
  const full = bool(args.values, "full");
  const previewLen = num(args.values, "preview");
  const limit = num(args.values, "limit") ?? 50;
  const debug = createDebugLogger(args);
  // Literal grep is case-insensitive by default (matches paths/commands/versions
  // regardless of case). -i / --ignore-case are accepted as explicit no-ops.
  const ignoreCase = true;
  const op = "ILIKE";

  const tiers = resolveTiers(args.values);
  const db = resolveDb(str(args.values, "database-url"));
  debug.log("db.resolved", {
    source: db.source,
    connectionString: redactConnString(db.connectionString),
  });
  if (!json) meta(`DB: ${redactConnString(db.connectionString)} (source: ${db.source})`);

  const pattern = `%${phrase}%`;
  const hits: GrepHit[] = [];
  let queryCount = 0;

  for (const tier of tiers) {
    const t = TIER_TABLES[tier];
    const where = t.textCols.map((c) => `${c} ${op} $1`).join(" OR ");
    const { rows } = await debug.duration(
      "grep.query",
      () =>
        db.pool.query(
          `SELECT id, (${t.contentExpr}) AS content, created_at
           FROM ${t.table}
           WHERE ${where}
           ORDER BY created_at DESC
           LIMIT $2`,
          [pattern, limit],
        ),
      { tier, limit },
    );
    queryCount += 1;
    debug.log("grep.query.count", { tier, rows: rows.length });
    for (const r of rows as Array<{ id: string; content: string; created_at: string }>) {
      hits.push({ id: r.id, tier, content: r.content, createdAt: new Date(r.created_at) });
    }
  }

  // Constraints (separate group, always searched).
  const { rows: constraintRows } = await debug.duration(
    "grep.query",
    () =>
      db.pool.query(
        `SELECT id, pattern || ': ' || content AS content, created_at
         FROM constraints
         WHERE (pattern ${op} $1 OR content ${op} $1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [pattern, limit],
      ),
    { tier: "constraints", limit },
  );
  queryCount += 1;
  debug.log("grep.query.count", { tier: "constraints", rows: constraintRows.length });
  const constraintHits: GrepHit[] = (
    constraintRows as Array<{ id: string; content: string; created_at: string }>
  ).map((r) => ({ id: r.id, tier: "constraints", content: r.content, createdAt: new Date(r.created_at) }));
  debug.log("grep.queries.end", {
    queries: queryCount,
    memoryHits: hits.length,
    constraintHits: constraintHits.length,
  });

  if (json) {
    emitJson({
      command: "grep",
      phrase,
      caseInsensitive: ignoreCase,
      tiers,
      counts: { memory: hits.length, constraints: constraintHits.length },
      hits: [...hits, ...constraintHits].map((h) => ({
        id: h.id,
        tier: h.tier,
        createdAt: h.createdAt,
        content: h.content,
      })),
    });
    return;
  }

  line();
  line(`USME grep — literal "${phrase}" (${ignoreCase ? "case-insensitive" : "case-sensitive"})`);
  line(`  memory hits: ${hits.length}   constraint hits: ${constraintHits.length}`);
  line();
  if (hits.length === 0 && constraintHits.length === 0) line(`  (no matches)`);
  for (const h of hits) printHit(h, { full, previewLen });
  if (constraintHits.length > 0) {
    line();
    line(`[constraints]`);
    for (const h of constraintHits) printHit(h, { full, previewLen });
  }
  line();
}

function printHit(h: GrepHit, opts: { full?: boolean; previewLen?: number }): void {
  line(`  • [${h.tier}] ${h.id}  ${isoDate(h.createdAt)}`);
  line(`      ${preview(h.content, opts)}`);
}

/** Exposed for potential reuse/testing. */
export type { MemoryTier };
