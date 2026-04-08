/**
 * USME pipeline telemetry — JSON-lines logging with flag-file hot toggle.
 *
 * Enabled when /tmp/usme/telemetry.enabled exists (create/delete at runtime).
 * Log destination: USME_TELEMETRY_LOG env var || /tmp/usme/telemetry.jsonl
 *
 * Each record is one JSON line containing:
 *   - Timing breakdown for every pipeline stage
 *   - Full context block (retrieved items + metadata)
 *   - Injection decision and reason
 */

import fs from "node:fs";
import path from "node:path";
import type { InjectedMemory, MemoryTier } from "@usme/core";

// ── Configuration ─────────────────────────────────────────────────────────────

const FLAG_FILE = "/tmp/usme/telemetry.enabled";
const DEFAULT_LOG_FILE = "/tmp/usme/telemetry.jsonl";

const LOG_FILE = process.env.USME_TELEMETRY_LOG ?? DEFAULT_LOG_FILE;

// ── Hot toggle ────────────────────────────────────────────────────────────────

/**
 * Check whether telemetry is currently enabled by testing for the flag file.
 * This is a synchronous stat — cheap enough to call per turn.
 */
export function isTelemetryEnabled(): boolean {
  try {
    fs.accessSync(FLAG_FILE, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineTiming {
  /** Wall time to obtain query embedding (ms). 0 if pre-warmed from cache. */
  queryEmbeddingMs: number;
  /** Wall time for parallel ANN retrieval across all tiers (ms). */
  dbRetrievalMs: number;
  /** Wall time for scoring + critic filter + eligibility filter (ms). */
  scoringAndPackingMs: number;
  /** Wall time to format and return the assembled context block (ms). */
  injectionMs: number;
  /** Total end-to-end wall time for the pipeline (ms). */
  totalMs: number;
}

export interface TelemetryItem {
  id: string;
  tier: MemoryTier;
  similarityScore: number;
  compositeScore: number;
  tokenCount: number;
  /** First 500 chars of content for readability; full content if shorter. */
  contentPreview: string;
}

export type InjectionDecision =
  | { injected: true; reason: "active_mode_items_selected" }
  | { injected: false; reason: "shadow_mode" | "no_items_selected" | "disabled" | "error" | string };

export interface TelemetryRecord {
  ts: string;                   // ISO-8601 wall time
  sessionId: string;
  turnIndex: number;
  mode: string;
  timing: PipelineTiming;
  retrieval: {
    tiersQueried: MemoryTier[];
    itemsConsidered: number;
    itemsSelected: number;
    tokenBudget: number;
    tokensUsed: number;
  };
  items: TelemetryItem[];
  injection: InjectionDecision;
}

// ── Writer ────────────────────────────────────────────────────────────────────

function ensureLogDir(): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append a telemetry record to the log file (fire-and-forget, non-blocking).
 * Silently swallows write errors to preserve graceful degradation.
 */
export function writeTelemetry(record: TelemetryRecord): void {
  if (!isTelemetryEnabled()) return;
  try {
    ensureLogDir();
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // Silently swallow: telemetry must never affect the hot path
  }
}

// ── Builder helpers ───────────────────────────────────────────────────────────

/**
 * Convert InjectedMemory[] into slim TelemetryItem[] for logging.
 * The similarityScore field carries the composite score (InjectedMemory only
 * exposes `score`, not raw similarity separately after pack()).
 */
export function itemsToTelemetry(items: InjectedMemory[]): TelemetryItem[] {
  return items.map((item) => ({
    id: item.id,
    tier: item.tier,
    similarityScore: item.score,  // composite score post-pack
    compositeScore: item.score,
    tokenCount: item.tokenCount,
    contentPreview: item.content.slice(0, 500),
  }));
}

/**
 * Build a TelemetryRecord and write it. Call this once per pipeline run.
 *
 * @param sessionId       Session identifier
 * @param turnIndex       Current turn number
 * @param mode            Assembly mode name
 * @param timing          Broken-down timing object
 * @param assembleResult  Output of assemble() (null if skipped)
 * @param injection       Whether and why injection happened
 */
export function recordTelemetry(params: {
  sessionId: string;
  turnIndex: number;
  mode: string;
  timing: PipelineTiming;
  assembleResult: {
    itemsConsidered: number;
    itemsSelected: number;
    tiersQueried: MemoryTier[];
    tokenBudget: number;
    tokensUsed: number;
    items: InjectedMemory[];
  } | null;
  injection: InjectionDecision;
}): void {
  if (!isTelemetryEnabled()) return;

  const { sessionId, turnIndex, mode, timing, assembleResult, injection } = params;

  const record: TelemetryRecord = {
    ts: new Date().toISOString(),
    sessionId,
    turnIndex,
    mode,
    timing,
    retrieval: assembleResult
      ? {
          tiersQueried: assembleResult.tiersQueried,
          itemsConsidered: assembleResult.itemsConsidered,
          itemsSelected: assembleResult.itemsSelected,
          tokenBudget: assembleResult.tokenBudget,
          tokensUsed: assembleResult.tokensUsed,
        }
      : {
          tiersQueried: [],
          itemsConsidered: 0,
          itemsSelected: 0,
          tokenBudget: 0,
          tokensUsed: 0,
        },
    items: assembleResult ? itemsToTelemetry(assembleResult.items) : [],
    injection,
  };

  writeTelemetry(record);
}
