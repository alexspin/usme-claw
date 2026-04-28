/**
 * Cron scheduler for periodic consolidation.
 * Default schedule: "0 3 * * *" (periodic consolidation (default: 3am UTC, configure as needed)).
 * Uses pg-boss for persistent, DB-backed scheduling.
 */

import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { runNightlyConsolidation, stepEpisodify } from "./nightly.js";
import type { NightlyConfig, NightlyResult } from "./nightly.js";
import { getPgBoss } from "../extract/pgboss.js";
import { runReflection } from "./reflect.js";
import {
  getPromoteCandidates,
  buildPromoteCard,
  markCandidatesPrompted,
} from "./promote.js";
import { logger } from "../logger.js";
import { DEFAULT_REASONING_MODEL } from "../config/models.js";

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
  /** Stop the scheduled job (unregisters pg-boss schedules). */
  stop: () => Promise<void>;
  /** Run the nightly job immediately (outside schedule). */
  runNow: () => Promise<NightlyResult>;
  /** Run mini-consolidation (sensory_trace → episodes) immediately. */
  runMiniNow: () => Promise<number>;
}

// ── Logger ─────────────────────────────────────────────────

const log = logger.child({ module: "scheduler" });

// ── Scheduler ──────────────────────────────────────────────

/**
 * Start the nightly consolidation scheduler using pg-boss.
 */
export async function startScheduler(
  client: Anthropic,
  pool: pg.Pool,
  config: SchedulerConfig = {},
): Promise<SchedulerHandle> {
  const cronExpr = config.cronExpression ?? "0 3 * * *";

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

  const boss = await getPgBoss();

  // pg-boss v12+ requires queues to exist before scheduling
  const queues = ["usme-nightly", "usme-reflection-morning", "usme-reflection-evening", "usme-skill-delivery", "usme-mini-consolidation"];
  for (const q of queues) {
    await boss.createQueue(q).catch(() => { /* already exists — idempotent */ });
  }

  // Register persistent cron schedules (idempotent upserts)
  await boss.schedule("usme-nightly", cronExpr, {}, { tz: "UTC" });
  await boss.schedule("usme-reflection-morning", "0 16 * * *", {}, { tz: "UTC" });
  await boss.schedule("usme-reflection-evening", "0 4 * * *", {}, { tz: "UTC" });
  await boss.schedule("usme-skill-delivery", "0 17 * * *", {}, { tz: "UTC" });
  await boss.schedule("usme-mini-consolidation", "*/30 * * * *", {}, { tz: "UTC" });

  log.info({ expr: cronExpr }, "nightly consolidation scheduler started (pg-boss)");

  // Register workers for each scheduled queue
  await boss.work("usme-nightly", { localConcurrency: 1 }, async () => {
    try {
      await runJob();
    } catch (err: unknown) {
      log.error({ err }, "nightly consolidation job failed");
    }
  });

  await boss.work("usme-reflection-morning", { localConcurrency: 1 }, async () => {
    log.info("Starting scheduled reflection (08:00 Pacific)");
    try {
      const result = await runReflection({ triggerSource: "scheduler-morning", model: DEFAULT_REASONING_MODEL });
      if (result.candidatesCreated > 0) {
        log.info({ candidatesCreated: result.candidatesCreated }, "reflection produced candidates — delivering now");
        await deliverSkillCandidates(pool, config.sendFn);
      }
    } catch (err) {
      log.error({ err }, "scheduled reflection (morning) failed");
    }
  });

  await boss.work("usme-reflection-evening", { localConcurrency: 1 }, async () => {
    log.info("Starting scheduled reflection (20:00 Pacific)");
    try {
      const result = await runReflection({ triggerSource: "scheduler-evening", model: DEFAULT_REASONING_MODEL });
      if (result.candidatesCreated > 0) {
        log.info({ candidatesCreated: result.candidatesCreated }, "reflection produced candidates — scheduling morning delivery via flag");
      }
    } catch (err) {
      log.error({ err }, "scheduled reflection (evening) failed");
    }
  });

  await boss.work("usme-skill-delivery", { localConcurrency: 1 }, async () => {
    log.info("Running skill candidate delivery");
    try {
      await deliverSkillCandidates(pool, config.sendFn);
    } catch (err) {
      log.error({ err }, "skill candidate delivery failed");
    }
  });

  await boss.work("usme-mini-consolidation", { localConcurrency: 1 }, async () => {
    await runMini().catch((err: unknown) => log.error({ err }, "mini-consolidation job failed"));
  });

  // Optionally run on start
  if (config.runOnStart) {
    setImmediate(() => runJob().catch((err: unknown) => log.error({ err }, "nightly consolidation job failed")));
  }

  return {
    stop: async () => {
      await boss.unschedule("usme-nightly");
      await boss.unschedule("usme-reflection-morning");
      await boss.unschedule("usme-reflection-evening");
      await boss.unschedule("usme-skill-delivery");
      await boss.unschedule("usme-mini-consolidation");
      log.info("Scheduler stopped (schedules unregistered)");
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
  log2.info(
    { count: candidates.length, candidates: candidates.map((c) => ({ id: c.id, name: c.name, confidence: c.confidence })) },
    "fetched promote candidates",
  );

  if (candidates.length === 0) {
    log2.info("No skill candidates ready for morning delivery");
    return;
  }

  // Mark candidates as prompted so they won't appear again tomorrow
  await markCandidatesPrompted(candidates.map((c) => c.id), pool);
  log2.info({ count: candidates.length }, "marked N candidates as prompted");

  // Deliver the card via sendFn if provided, otherwise fire a system event
  const card = buildPromoteCard(candidates);
  log2.info({ card }, "built promote card");

  if (sendFn) {
    log2.info("delivering via sendFn");
    await sendFn(card);
  } else {
    log2.info("no sendFn — falling back to execSync openclaw system event");
    const eventText = `[USME-MORNING] ${candidates.length} skill candidate(s) ready for review. Run: npx tsx list-candidates.ts --force`;
    try {
      execFileSync("openclaw", ["system", "event", "--text", eventText, "--mode", "now"], {
        stdio: "inherit",
      });
    } catch (execErr) {
      log2.warn({ execErr }, "[usme] deliverSkillCandidates: openclaw system event failed, falling back to console.log");
      console.log(card);
    }
  }

  log2.info({ count: candidates.length }, "skill candidates delivered for review");
}
