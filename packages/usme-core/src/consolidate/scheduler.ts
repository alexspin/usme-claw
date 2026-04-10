/**
 * Cron scheduler for periodic consolidation.
 * Default schedule: "0 3 * * *" (periodic consolidation (default: 3am UTC, configure as needed)).
 */

import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import type pg from "pg";
import { runNightlyConsolidation, stepEpisodify } from "./nightly.js";
import type { NightlyConfig, NightlyResult } from "./nightly.js";
import { runReflection } from "./reflect.js";
import {
  getPromoteCandidates,
  buildPromoteCard,
  markCandidatesPrompted,
} from "./promote.js";
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
  /** Optional function to send skill candidate cards to the user's chat session. */
  sendFn?: (message: string) => void | Promise<void>;
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

  // Memory Reflection Service — 08:00 and 20:00 Pacific
  const reflectionMorningJob = cron.schedule('0 16 * * *', async () => {
    log.info('Starting scheduled reflection (08:00 Pacific)');
    try {
      const result = await runReflection({ triggerSource: 'scheduler-morning', model: 'claude-sonnet-4-5' });
      // If candidates were written and we're in daytime, deliver them immediately
      if (result.candidatesCreated > 0) {
        log.info({ candidatesCreated: result.candidatesCreated }, 'reflection produced candidates — delivering now');
        await deliverSkillCandidates(pool, config.sendFn);
      }
    } catch (err) {
      log.error({ err }, 'scheduled reflection (morning) failed');
    }
  }, { timezone: 'UTC', scheduled: true });

  const reflectionEveningJob = cron.schedule('0 4 * * *', async () => {
    log.info('Starting scheduled reflection (20:00 Pacific)');
    try {
      const result = await runReflection({ triggerSource: 'scheduler-evening', model: 'claude-sonnet-4-5' });
      // Evening reflection: if daytime (unlikely at 20:00), deliver; otherwise the morning cron handles it
      if (result.candidatesCreated > 0) {
        log.info({ candidatesCreated: result.candidatesCreated }, 'reflection produced candidates — scheduling morning delivery via flag');
      }
    } catch (err) {
      log.error({ err }, 'scheduled reflection (evening) failed');
    }
  }, { timezone: 'UTC', scheduled: true });

  // Skill candidate delivery — 09:00 Pacific = 17:00 UTC
  const skillDeliveryJob = cron.schedule('0 17 * * *', async () => {
    log.info('Running skill candidate delivery');
    try {
      await deliverSkillCandidates(pool, config.sendFn);
    } catch (err) {
      log.error({ err }, 'skill candidate delivery failed');
    }
  }, { timezone: 'UTC', scheduled: true });

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
      reflectionMorningJob.stop();
      reflectionEveningJob.stop();
      skillDeliveryJob.stop();
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

/**
 * Deliver pending skill candidates.
 * Queries promotable candidates, formats them as a card, marks them prompted,
 * clears any pending_morning_notify flags, then prints the card to stdout
 * (which OpenClaw routes to the active conversation session).
 *
 * Also checks for runs with pending_morning_notify=true that were set
 * when a reflection ran outside daytime hours.
 */
export async function deliverSkillCandidates(
  pool: pg.Pool,
  sendFn?: (message: string) => void | Promise<void>,
): Promise<void> {
  const log2 = logger.child({ module: "skill-delivery" });

  // Clear pending_morning_notify flags from old runs
  const { rows: pendingRuns } = await pool.query(
    `SELECT id FROM reflection_runs
     WHERE pending_morning_notify = TRUE
       AND created_at > NOW() - INTERVAL '7 days'`,
  );

  if (pendingRuns.length > 0) {
    const pendingIds = pendingRuns.map((r: { id: number }) => r.id);
    await pool.query(
      `UPDATE reflection_runs SET pending_morning_notify = FALSE WHERE id = ANY($1)`,
      [pendingIds],
    );
    log2.info({ count: pendingIds.length }, "cleared pending_morning_notify flags");
  }

  // Fetch promotable candidates
  const candidates = await getPromoteCandidates({ includeDrafts: false }, pool);

  if (candidates.length === 0) {
    log2.info("No skill candidates ready for morning delivery");
    return;
  }

  // Mark candidates as prompted so they won't appear again tomorrow
  await markCandidatesPrompted(candidates.map((c) => c.id), pool);

  // Deliver the card via sendFn if provided, otherwise fall back to stdout
  const card = buildPromoteCard(candidates);
  if (sendFn) {
    await sendFn(card);
  } else {
    log2.warn("[usme] deliverSkillCandidates: no sendFn provided, falling back to console.log");
    console.log(card);
  }

  log2.info({ count: candidates.length }, "skill candidates delivered for review");
}
