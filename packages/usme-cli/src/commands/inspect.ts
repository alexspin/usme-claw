/**
 * `usme memory inspect <id>`
 *
 * Full detail for one memory item, located by UUID across all tiers + constraints.
 * READ-ONLY. Embeddings are summarized (dimension only), not dumped.
 */

import type { MemoryTier } from "@usme/core";
import type { ParsedArgs } from "../parse.js";
import { str, bool } from "../parse.js";
import { resolveDb, redactConnString } from "../db.js";
import { TIER_TABLES } from "../schema-map.js";
import { emitJson, line, meta } from "../format.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runInspect(args: ParsedArgs): Promise<void> {
  const id = args.positionals[0];
  if (!id) throw new Error("inspect requires an id: usme memory inspect <uuid>");
  if (!UUID_RE.test(id)) throw new Error(`"${id}" is not a valid UUID`);

  const json = bool(args.values, "json");
  const db = resolveDb(str(args.values, "database-url"));
  if (!json) meta(`DB: ${redactConnString(db.connectionString)} (source: ${db.source})`);

  const sources: { name: string; table: string }[] = [
    ...(Object.entries(TIER_TABLES) as [MemoryTier, (typeof TIER_TABLES)[MemoryTier]][]).map(
      ([tier, t]) => ({ name: tier, table: t.table }),
    ),
    { name: "constraints", table: "constraints" },
  ];

  for (const src of sources) {
    const { rows } = await db.pool.query(`SELECT * FROM ${src.table} WHERE id = $1 LIMIT 1`, [id]);
    if (rows.length === 0) continue;

    const row = summarizeRow(rows[0] as Record<string, unknown>);
    if (json) {
      emitJson({ command: "inspect", id, found: true, source: src.name, item: row });
      return;
    }
    line();
    line(`USME inspect — ${src.name}  ${id}`);
    line();
    for (const [k, v] of Object.entries(row)) {
      line(`  ${k.padEnd(22)} ${formatValue(v)}`);
    }
    line();
    return;
  }

  if (json) {
    emitJson({ command: "inspect", id, found: false });
  } else {
    line();
    line(`No memory item found with id ${id} in any tier or constraints.`);
    line();
  }
}

/** Replace embedding vectors with a dimension summary; keep everything else. */
function summarizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "embedding") {
      out[k] = summarizeEmbedding(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function summarizeEmbedding(v: unknown): string {
  if (v == null) return "(null)";
  if (Array.isArray(v)) return `[vector dim=${v.length}]`;
  if (typeof v === "string") {
    const commas = (v.match(/,/g) ?? []).length;
    return `[vector dim≈${commas + 1}]`;
  }
  return "[vector]";
}

function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
