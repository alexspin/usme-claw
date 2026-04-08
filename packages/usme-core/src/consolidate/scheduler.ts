/**
 * Cron scheduler for periodic consolidation.
 * Default schedule: "0 3 * * *" (periodic consolidation (default: 3am UTC, configure as needed)).
 */

import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import type pg from "pg";
import { runNightlyConsolidation, stepEpisodify } from "./nightly.js";
import type { NightlyConfig, NightlyResult } from "./nightly.js";
import { logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────

export interface SchedulerConfig extends NightlyConfig {
  /** Cron expression. Default: "0 3 * * *" (periodic consolidation (default: 3am UTC, configure as needed)). */
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

const log = logger.child({ module: "scheduler" });

// ── Scheduler ──────────────────────────────────────────────

/**
 * Start the nightly consolidation scheduler using node-cron.
 */
export function startScheduler(
  client: Anthropic,
  pool: pg.Pool,
  config: SchedulerConfig = {},
): SchedulerHandle {
  const cronExpr = config.cronExpression ?? "0 3 * * *";
  const miniIntervalMs = config.miniConsolidationIntervalMs ?? 30 * 60_000; // 30 min
  let miniTimer: ReturnType<typeof setInterval> | null = null;

  const runMini = async (): Promise<number> => {
    log.info("Running mini-consolidation (sensory_trace → episodes)");
    try {
      const count = await stepEpisodify(client, pool, { ...config, tracesPerBatch: 100 });
      log.info(`Mini-consolidation: created ${count} episodes`);
      return count;
    } catch (err) {
      log.error({ err }, "Mini-consolidation failed");
      return 0;
    }
  };

  const runJob = async (): Promise<NightlyResult> => {
    log.info("nightly consolidation starting");
    const result = await runNightlyConsolidation(client, pool, config);
    log.info({ result }, "nightly consolidation complete");
    return result;
  };

  const job = cron.schedule(cronExpr, async () => {
    try {
      await runJob();
    } catch (err: unknown) {
      log.error({ err }, "nightly consolidation job failed");
    }
  }, { timezone: "UTC", scheduled: false });

  job.start();
  log.info({ expr: cronExpr }, "nightly consolidation scheduler started");

  // Optionally run on start
  if (config.runOnStart) {
    setImmediate(() => runJob().catch((err: unknown) => log.error({ err }, "nightly consolidation job failed")));
  }

  // Start mini-consolidation interval
  miniTimer = setInterval(() => {
    runMini().catch((err: unknown) => log.error({ err }, "mini-consolidation job failed"));
  }, miniIntervalMs);

  return {
    stop: () => {
      job.stop();
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
