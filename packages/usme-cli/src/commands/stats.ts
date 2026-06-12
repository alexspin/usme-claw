/**
 * `usme memory stats`
 *
 * Per-tier counts (total / embedded / active), constraint counts, freshness, and
 * embedding health. If a runtime injection log is present (USME_INJECTION_LOG or
 * /tmp/usme/injection.jsonl) its most recent entries are summarized. READ-ONLY.
 */

import { readFileSync, existsSync } from "node:fs";
import type { MemoryTier } from "@usme/core";
import type { ParsedArgs } from "../parse.js";
import { str, num, bool } from "../parse.js";
import { resolveDb, redactConnString } from "../db.js";
import { createDebugLogger } from "../debug.js";
import { TIER_TABLES } from "../schema-map.js";
import { isoDate, emitJson, line, meta } from "../format.js";

interface TierStat {
  tier: string;
  total: number;
  embedded: number;
  missingEmbedding: number;
  active: number | null;
  newest: string | null;
  last24h: number;
  last7d: number;
}

export async function runStats(args: ParsedArgs): Promise<void> {
  const json = bool(args.values, "json");
  const debug = createDebugLogger(args);
  const db = resolveDb(str(args.values, "database-url"));
  debug.log("db.resolved", {
    source: db.source,
    connectionString: redactConnString(db.connectionString),
  });
  if (!json) meta(`DB: ${redactConnString(db.connectionString)} (source: ${db.source})`);

  const tierStats: TierStat[] = [];
  let queryCount = 0;
  for (const [tier, t] of Object.entries(TIER_TABLES) as [MemoryTier, (typeof TIER_TABLES)[MemoryTier]][]) {
    const activeSelect = t.activePredicate
      ? `count(*) FILTER (WHERE ${t.activePredicate})`
      : `NULL`;
    const { rows } = await debug.duration(
      "stats.query",
      () =>
        db.pool.query(
          `SELECT
             count(*)::int AS total,
             count(embedding)::int AS embedded,
             ${activeSelect}::int AS active,
             max(created_at) AS newest,
             count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24,
             count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7
           FROM ${t.table}`,
        ),
      { tier },
    );
    queryCount += 1;
    const r = rows[0] as {
      total: number;
      embedded: number;
      active: number | null;
      newest: string | null;
      last24: number;
      last7: number;
    };
    tierStats.push({
      tier,
      total: r.total,
      embedded: r.embedded,
      missingEmbedding: r.total - r.embedded,
      active: r.active,
      newest: r.newest,
      last24h: r.last24,
      last7d: r.last7,
    });
  }

  const { rows: cRows } = await debug.duration(
    "stats.query",
    () =>
      db.pool.query(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE dismissed_at IS NULL)::int AS active
         FROM constraints`,
      ),
    { tier: "constraints" },
  );
  queryCount += 1;
  const constraints = cRows[0] as { total: number; active: number };
  debug.log("stats.queries.end", { queries: queryCount, tiers: tierStats.length, constraints: 1 });

  const injection = summarizeInjectionLog(num(args.values, "limit") ?? 5);

  if (json) {
    emitJson({
      command: "stats",
      db: { source: db.source },
      tiers: tierStats,
      constraints: { total: constraints.total, active: constraints.active, dismissed: constraints.total - constraints.active },
      recentInjections: injection,
    });
    return;
  }

  line();
  line(`USME memory stats`);
  line();
  line(
    `  ${"tier".padEnd(14)}${"total".padStart(8)}${"embed".padStart(8)}${"active".padStart(8)}${"24h".padStart(6)}${"7d".padStart(6)}  newest`,
  );
  for (const s of tierStats) {
    line(
      `  ${s.tier.padEnd(14)}${String(s.total).padStart(8)}${String(s.embedded).padStart(8)}` +
        `${(s.active === null ? "—" : String(s.active)).padStart(8)}${String(s.last24h).padStart(6)}${String(s.last7d).padStart(6)}  ${isoDate(s.newest)}`,
    );
    if (s.missingEmbedding > 0) {
      meta(`      ⚠ ${s.tier}: ${s.missingEmbedding} row(s) missing embeddings`);
    }
  }
  line();
  line(`  constraints: ${constraints.active} active / ${constraints.total} total`);
  line();
  if (injection.found) {
    line(`  recent injections (${injection.source}):`);
    for (const e of injection.entries) {
      line(`    ${e.itemsSelected ?? "?"} selected / ${e.itemsConsidered ?? "?"} considered  ${e.tokensInjected ?? "?"} tok  [${(e.tiersQueried ?? []).join(",")}]`);
    }
  } else {
    line(`  recent injections: ${injection.note}`);
  }
  line();
}

interface InjectionEntry {
  itemsSelected?: number;
  itemsConsidered?: number;
  tokensInjected?: number;
  tiersQueried?: string[];
}

function summarizeInjectionLog(n: number):
  | { found: true; source: string; entries: InjectionEntry[] }
  | { found: false; note: string } {
  const path = process.env.USME_INJECTION_LOG || "/tmp/usme/injection.jsonl";
  if (!existsSync(path)) {
    return { found: false, note: `no log at ${path}` };
  }
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const entries: InjectionEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < n; i--) {
      try {
        const obj = JSON.parse(lines[i]) as Record<string, unknown>;
        if (obj.type === "injection" || obj.phase === "injection_result") {
          entries.push({
            itemsSelected: numOrUndef(obj.itemsSelected),
            itemsConsidered: numOrUndef(obj.itemsConsidered),
            tokensInjected: numOrUndef(obj.tokensInjected),
            tiersQueried: Array.isArray(obj.tiersQueried) ? (obj.tiersQueried as string[]) : undefined,
          });
        }
      } catch {
        /* skip malformed line */
      }
    }
    if (entries.length === 0) return { found: false, note: `log at ${path} has no injection entries` };
    return { found: true, source: path, entries };
  } catch (err) {
    return { found: false, note: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
