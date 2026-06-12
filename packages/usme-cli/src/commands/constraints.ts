/**
 * `usme memory constraints list | search "term"`
 *
 * Constraints are guardrails (NEVER / STOP_DO / PREFER / WARN) that the runtime
 * always injects ahead of scored memory, outside the token budget. They are NOT a
 * normal memory tier, so they get their own command. READ-ONLY.
 */

import type { ParsedArgs } from "../parse.js";
import { str, num, bool } from "../parse.js";
import { resolveDb, redactConnString } from "../db.js";
import { createDebugLogger } from "../debug.js";
import { isoDate, emitJson, line, meta } from "../format.js";

interface ConstraintRow {
  id: string;
  pattern: string;
  content: string;
  created_at: string;
  dismissed_at: string | null;
}

export async function runConstraints(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0] ?? "list";
  if (sub !== "list" && sub !== "search") {
    throw new Error(`constraints subcommand must be "list" or "search", got "${sub}"`);
  }
  const term = sub === "search" ? args.positionals[1] : undefined;
  if (sub === "search" && !term) {
    throw new Error('constraints search requires a term: usme memory constraints search "term"');
  }

  const json = bool(args.values, "json");
  const includeDismissed = bool(args.values, "all");
  const limit = num(args.values, "limit") ?? 100;
  const debug = createDebugLogger(args);

  const db = resolveDb(str(args.values, "database-url"));
  debug.log("db.resolved", {
    source: db.source,
    connectionString: redactConnString(db.connectionString),
  });
  if (!json) meta(`DB: ${redactConnString(db.connectionString)} (source: ${db.source})`);

  const where: string[] = [];
  const params: unknown[] = [];
  if (!includeDismissed) where.push("dismissed_at IS NULL");
  if (term) {
    params.push(`%${term}%`);
    where.push(`(pattern ILIKE $${params.length} OR content ILIKE $${params.length})`);
  }
  params.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { rows } = await debug.duration(
    "constraints.fetch",
    () =>
      db.pool.query<ConstraintRow>(
        `SELECT id, pattern, content, created_at, dismissed_at
         FROM constraints
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params,
      ),
    { sub, includeDismissed, limit },
  );
  debug.log("constraints.count", { count: rows.length });

  if (json) {
    emitJson({
      command: "constraints",
      sub,
      term,
      includeDismissed,
      count: rows.length,
      constraints: rows.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        content: r.content,
        createdAt: r.created_at,
        dismissedAt: r.dismissed_at,
        active: r.dismissed_at === null,
      })),
    });
    return;
  }

  line();
  line(
    `USME constraints — ${sub}${term ? ` "${term}"` : ""}` +
      `${includeDismissed ? " (incl. dismissed)" : " (active only)"}`,
  );
  line(`  ${rows.length} constraint(s)`);
  line();
  if (rows.length === 0) line(`  (none)`);
  for (const r of rows) {
    const status = r.dismissed_at ? `dismissed ${isoDate(r.dismissed_at)}` : "active";
    line(`  • ${r.pattern}  [${status}]  ${r.id}  ${isoDate(r.created_at)}`);
    line(`      ${r.content}`);
  }
  line();
}
