/**
 * Output helpers: content previews, score breakdowns, JSON emission.
 * JSON output is stable and machine-readable for agents.
 */

import type { ScoreBreakdown } from "@usme/core";

const DEFAULT_PREVIEW = 200;

/** Truncate content to a preview length unless `full` is set. */
export function preview(content: string, opts: { full?: boolean; previewLen?: number }): string {
  const text = (content ?? "").replace(/\s+/g, " ").trim();
  if (opts.full) return content ?? "";
  const len = opts.previewLen ?? DEFAULT_PREVIEW;
  return text.length > len ? text.slice(0, len) + "…" : text;
}

/** Coarse relevance label matching the plugin's injected header semantics. */
export function relevanceLabel(score: number): "high" | "med" | "low" {
  return score >= 0.75 ? "high" : score >= 0.5 ? "med" : "low";
}

/** One-line score breakdown, e.g. "sim:0.82 rec:0.40 prov:1.00 acc:0.10 rq:0.50". */
export function formatBreakdown(b: ScoreBreakdown): string {
  const parts = [
    `sim:${fmt(b.similarity)}`,
    `rec:${fmt(b.recency)}`,
    `prov:${fmt(b.provenance)}`,
    `acc:${fmt(b.accessFrequency)}`,
  ];
  if (b.reflectionQuality !== undefined) parts.push(`rq:${fmt(b.reflectionQuality)}`);
  if (b.teachability !== undefined) parts.push(`teach:${fmt(b.teachability)}`);
  return parts.join(" ");
}

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

export function isoDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

/** Emit stable JSON to stdout. */
export function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, jsonReplacer, 2) + "\n");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function line(s = ""): void {
  process.stdout.write(s + "\n");
}

/** Write a status/meta line to stderr so --json stdout stays pure. */
export function meta(s: string): void {
  process.stderr.write(s + "\n");
}
