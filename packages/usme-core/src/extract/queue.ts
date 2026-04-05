/**
 * Simple in-process async task queue.
 * FIFO, processes one job at a time.
 * If a job fails, log the error and continue to the next job.
 */

// ── Types ──────────────────────────────────────────────────

export type Job = () => Promise<void>;

export interface QueueStats {
  pending: number;
  completed: number;
  failed: number;
  processing: boolean;
}

// ── Logger ─────────────────────────────────────────────────

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`[usme:queue] ${msg}`, data ?? ""),
  error: (msg: string, err?: unknown) =>
    console.error(`[usme:queue] ERROR ${msg}`, err ?? ""),
};

// ── Queue Implementation ───────────────────────────────────

export class ExtractionQueue {
  private queue: Job[] = [];
  private processing = false;
  private completed = 0;
  private failed = 0;
  private drainResolvers: Array<() => void> = [];

  /**
   * Enqueue a job for async processing.
   * Jobs are processed FIFO, one at a time.
   */
  enqueue(job: Job): void {
    this.queue.push(job);
    this.scheduleProcessing();
  }

  /**
   * Returns a promise that resolves when the queue is empty
   * and all jobs have finished processing.
   */
  drain(): Promise<void> {
    if (this.queue.length === 0 && !this.processing) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  /** Current queue statistics. */
  stats(): QueueStats {
    return {
      pending: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      processing: this.processing,
    };
  }

  // ── Internal ───────────────────────────────────────────

  private scheduleProcessing(): void {
    if (this.processing) return;
    // Use setImmediate for non-blocking scheduling (D8)
    setImmediate(() => this.processNext());
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;

    const job = this.queue.shift();
    if (!job) {
      this.notifyDrain();
      return;
    }

    this.processing = true;

    try {
      await job();
      this.completed++;
    } catch (err) {
      this.failed++;
      log.error("Job failed, continuing to next", err);
    } finally {
      this.processing = false;
    }

    // Schedule next job if queue is not empty
    if (this.queue.length > 0) {
      setImmediate(() => this.processNext());
    } else {
      this.notifyDrain();
    }
  }

  private notifyDrain(): void {
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

/** Singleton extraction queue instance. */
let defaultQueue: ExtractionQueue | null = null;

export function getExtractionQueue(): ExtractionQueue {
  if (!defaultQueue) {
    defaultQueue = new ExtractionQueue();
  }
  return defaultQueue;
}

export function resetExtractionQueue(): void {
  defaultQueue = null;
}
