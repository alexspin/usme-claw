/**
 * pg-boss backed extraction queue.
 *
 * Jobs are closures (functions) and cannot be serialised, so we keep them in
 * an in-process registry keyed by UUID.  pg-boss stores the UUID as the job
 * payload and provides durable audit records, dead-letter routing, and
 * backpressure.  The actual function is dispatched by an in-process worker.
 *
 * Dead-letter queue name: usme-extraction-failed
 * Jobs that fail after RETRY_LIMIT attempts are routed there automatically.
 */

import crypto from "node:crypto";
import type { Job as PgBossJob } from "pg-boss";
import { getPgBoss } from "./pgboss.js";
import { logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────

export type Job = () => Promise<void>;

export interface QueueStats {
  pending: number;
  completed: number;
  failed: number;
  processing: boolean;
}

// ── Constants ──────────────────────────────────────────────

const QUEUE_NAME = "usme-extraction";
const DLQ_NAME = "usme-extraction-failed";
const RETRY_LIMIT = 3;

// ── Logger ─────────────────────────────────────────────────

const log = logger.child({ module: "queue" });

// ── In-process job registry ────────────────────────────────
// Maps jobId → { fn, attempts }. Kept alive as long as the job may be retried.

interface RegistryEntry {
  fn: Job;
  attempts: number;
}

const registry = new Map<string, RegistryEntry>();

// ── Queue Implementation ───────────────────────────────────

export class ExtractionQueue {
  private _pending = 0;
  private _completed = 0;
  private _failed = 0;
  private _processing = false;
  private _drainResolvers: Array<() => void> = [];
  private _initPromise: Promise<void> | null = null;

  /**
   * Enqueue a job for async processing.
   * Returns a promise that resolves once the job has been persisted in pg-boss.
   * The job itself runs asynchronously via the in-process worker.
   */
  async enqueue(job: Job): Promise<void> {
    await this._init();
    const jobId = crypto.randomUUID();
    registry.set(jobId, { fn: job, attempts: 0 });
    this._pending++;
    const boss = await getPgBoss();
    await boss.send(QUEUE_NAME, { jobId }, { retryLimit: RETRY_LIMIT, deadLetter: DLQ_NAME });
  }

  /**
   * Resolves when the queue is empty and no job is currently running.
   */
  drain(): Promise<void> {
    if (this._pending === 0 && !this._processing) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._drainResolvers.push(resolve);
    });
  }

  /** Queue statistics (resolved asynchronously for API consistency). */
  async stats(): Promise<QueueStats> {
    return {
      pending: this._pending,
      completed: this._completed,
      failed: this._failed,
      processing: this._processing,
    };
  }

  // ── Internal ───────────────────────────────────────────

  /**
   * Lazy-init: connect to pg-boss and register the in-process worker.
   * Called on the first enqueue.
   */
  private async _init(): Promise<void> {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      const boss = await getPgBoss();

      // pg-boss v12+ requires queues to exist before work()/send().
      // Guard with typeof check so test mocks without createQueue don't throw.
      if (typeof (boss as any).createQueue === "function") {
        await boss.createQueue(QUEUE_NAME).catch(() => {});
        await boss.createQueue(DLQ_NAME).catch(() => {});
      }

      await boss.work<{ jobId: string }>(
        QUEUE_NAME,
        { localConcurrency: 1 },
        async (pgJobs: PgBossJob<{ jobId: string }>[]) => {
          // localConcurrency=1 means we get exactly one job per batch.
          const pgJob = pgJobs[0];
          if (!pgJob) return;
          const { jobId } = pgJob.data;
          const entry = registry.get(jobId);

          if (!entry) {
            // Process restarted — function is gone, count as failed and give up.
            log.warn({ jobId }, "job function not found in registry (process may have restarted)");
            this._pending = Math.max(0, this._pending - 1);
            this._failed++;
            this._notifyDrain();
            // Do NOT throw — avoids pointless pg-boss retries when the fn is gone.
            return;
          }

          entry.attempts++;
          this._processing = true;

          try {
            await entry.fn();
            this._completed++;
            registry.delete(jobId);
          } catch (err) {
            log.error({ err, jobId, attempt: entry.attempts }, "Job failed");
            if (entry.attempts >= RETRY_LIMIT) {
              // Exhausted retries; route to DLQ and clean up.
              this._failed++;
              registry.delete(jobId);
              try {
                await boss.send(DLQ_NAME, { jobId, error: String(err) });
              } catch (dlqErr) {
                log.error({ dlqErr }, "Failed to send job to dead-letter queue");
              }
            } else {
              // Throw so pg-boss retries the job.
              this._processing = false;
              this._notifyDrain();
              throw err;
            }
          } finally {
            this._pending = Math.max(0, this._pending - 1);
            this._processing = false;
            this._notifyDrain();
          }
        },
      );
    })();

    return this._initPromise;
  }

  private _notifyDrain(): void {
    if (this._pending === 0 && !this._processing) {
      const resolvers = this._drainResolvers;
      this._drainResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }
}

// ── Singleton ──────────────────────────────────────────────

let defaultQueue: ExtractionQueue | null = null;

export function getExtractionQueue(): ExtractionQueue {
  if (!defaultQueue) {
    defaultQueue = new ExtractionQueue();
  }
  return defaultQueue;
}

export function resetExtractionQueue(): void {
  defaultQueue = null;
  registry.clear();
}
