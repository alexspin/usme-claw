/**
 * Cron scheduler for the nightly consolidation job.
 * Default schedule: "0 3 * * *" (3am UTC daily).
 */

import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { runNightlyConsolidation, stepEpisodify } from "./nightly.js";
import type { NightlyConfig, NightlyResult } from "./nightly.js";

// ── Types ──────────────────────────────────────────────────

export interface SchedulerConfig extends NightlyConfig {
  /** Cron expression. Default: "0 3 * * *" (3am UTC). */
  cronExpression?: string;
  /** If true, run immediately on start before scheduling. */
  runOnStart?: boolean;
  /** Interval in ms for mini-consolidation (sensory_trace → episodes). Default: 30 minutes. */
  miniConsolidationIntervalMs?: number;
  /** Number of turns between mini-consolidations. Default: 50. */
  miniConsolidationTurnThreshold?: number;
}

export interface SchedulerHandle {
  /** Stop the scheduled job. */
  stop: () => void;
  /** Run the nightly job immediately (outside schedule). */
  runNow: () => Promise<NightlyResult>;
  /** Run mini-consolidation (sensory_trace → episodes) immediately. */
  runMiniNow: () => Promise<number>;
}

// ── Logger ─────────────────────────────────────────────────

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`[usme:scheduler] ${msg}`, data ?? ""),
  error: (msg: string, err?: unknown) =>
    console.error(`[usme:scheduler] ERROR ${msg}`, err ?? ""),
};

// ── Simple Cron Implementation ─────────────────────────────

/**
 * Parse a simple cron expression and return ms until next run.
 * Supports: "minute hour day-of-month month day-of-week"
 * Only supports exact values and wildcards (*).
 */
function parseCronField(field: string, current: number, max: number): number | null {
  if (field === "*") return null; // wildcard, always matches
  const val = parseInt(field, 10);
  if (isNaN(val) || val < 0 || val > max) return null;
  return val;
}

function getNextCronRun(expression: string): Date {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: ${expression}`);

  const [minField, hourField] = parts;
  const targetMin = parseCronField(minField, 0, 59) ?? 0;
  const targetHour = parseCronField(hourField, 0, 23) ?? 0;

  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(targetHour, targetMin, 0, 0);

  // If target time has passed today, schedule for tomorrow
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next;
}

// ── Scheduler ──────────────────────────────────────────────

/**
 * Start the nightly consolidation scheduler.
 * Uses setTimeout-based scheduling (no external cron library needed for v1).
 */
export function startScheduler(
  client: Anthropic,
  pool: pg.Pool,
  config: SchedulerConfig = {},
): SchedulerHandle {
  const cronExpr = config.cronExpression ?? "0 3 * * *";
  const miniIntervalMs = config.miniConsolidationIntervalMs ?? 30 * 60_000; // 30 min
  let timer: ReturnType<typeof setTimeout> | null = null;
  let miniTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const runMini = async (): Promise<number> => {
    log.info("Running mini-consolidation (sensory_trace → episodes)");
    try {
      const count = await stepEpisodify(client, pool, { ...config, tracesPerBatch: 100 });
      log.info(`Mini-consolidation: created ${count} episodes`);
      return count;
    } catch (err) {
      log.error("Mini-consolidation failed", err);
      return 0;
    }
  };

  const runJob = async (): Promise<NightlyResult> => {
    log.info("Running nightly consolidation job");
    try {
      const result = await runNightlyConsolidation(client, pool, config);
      log.info("Nightly consolidation completed", result);
      return result;
    } catch (err) {
      log.error("Nightly consolidation failed", err);
      throw err;
    }
  };

  const scheduleNext = () => {
    if (stopped) return;

    const next = getNextCronRun(cronExpr);
    const delayMs = next.getTime() - Date.now();

    log.info(`Next nightly job scheduled for ${next.toISOString()} (in ${Math.round(delayMs / 60_000)} minutes)`);

    timer = setTimeout(async () => {
      await runJob().catch(() => {});
      scheduleNext();
    }, delayMs);
  };

  // Optionally run on start
  if (config.runOnStart) {
    setImmediate(() => runJob().catch(() => {}));
  }

  scheduleNext();

  // Start mini-consolidation interval
  miniTimer = setInterval(() => {
    if (!stopped) runMini().catch(() => {});
  }, miniIntervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (miniTimer) {
        clearInterval(miniTimer);
        miniTimer = null;
      }
      log.info("Scheduler stopped");
    },
    runNow: runJob,
    runMiniNow: runMini,
  };
}
