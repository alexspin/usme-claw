/**
 * Unit tests for the pg-boss backed extraction queue.
 * pg-boss (via ./pgboss.ts) is mocked — no real DB required.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { ExtractionQueue, resetExtractionQueue } from "../../src/extract/queue.js";

// ── pg-boss mock ───────────────────────────────────────────
//
// The mock captures the worker handler registered via boss.work() and invokes
// it synchronously when boss.send() is called for that queue name.  This
// simulates in-process job dispatch without network or DB involvement.

// Worker handler type: pg-boss passes an array of jobs.
type WorkerHandler = (jobs: Array<{ data: Record<string, unknown> }>) => Promise<void>;

function makeMockBoss() {
  const handlers = new Map<string, WorkerHandler>();
  const dlqJobs: Array<{ name: string; data: Record<string, unknown> }> = [];

  const boss = {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    work: vi.fn(async (_name: string, _opts: unknown, handler: WorkerHandler) => {
      handlers.set(_name, handler);
    }),
    send: vi.fn(async (name: string, data: Record<string, unknown>) => {
      const handler = handlers.get(name);
      if (handler) {
        // Run the handler in a microtask; simulate pg-boss retry by re-invoking on throw.
        await Promise.resolve();
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            await handler([{ data }]);
            break; // success
          } catch {
            if (attempt === MAX_RETRIES - 1) {
              // Exhausted retries — swallow (pg-boss would dead-letter it).
            }
            // else retry
          }
        }
      } else {
        // DLQ or unknown queue — just record it.
        dlqJobs.push({ name, data });
      }
    }),
    _handlers: handlers,
    _dlqJobs: dlqJobs,
  };

  return boss;
}

let mockBoss: ReturnType<typeof makeMockBoss>;

vi.mock("../../src/extract/pgboss.js", () => ({
  getPgBoss: vi.fn(),
  closePgBoss: vi.fn().mockResolvedValue(undefined),
}));

// Import after mock declaration so vitest can hoist correctly.
import { getPgBoss } from "../../src/extract/pgboss.js";

beforeEach(() => {
  mockBoss = makeMockBoss();
  (getPgBoss as Mock).mockResolvedValue(mockBoss);
  resetExtractionQueue();
  vi.clearAllMocks();
  // Restore mock after clearAllMocks (clearAllMocks resets call counts but keeps impl).
  (getPgBoss as Mock).mockResolvedValue(mockBoss);
});

// ── Helpers ────────────────────────────────────────────────

/** Wait for all pending setImmediate callbacks and microtasks. */
async function flushJobs(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

// ── Tests ──────────────────────────────────────────────────

describe("ExtractionQueue (pg-boss backed)", () => {
  it("executes enqueued jobs", async () => {
    const queue = new ExtractionQueue();
    const order: number[] = [];

    await queue.enqueue(async () => { order.push(1); });
    await queue.enqueue(async () => { order.push(2); });
    await queue.enqueue(async () => { order.push(3); });

    await queue.drain();

    expect(order).toEqual([1, 2, 3]);
  });

  it("reports correct stats after completion", async () => {
    const queue = new ExtractionQueue();

    await queue.enqueue(async () => {});
    await queue.enqueue(async () => {});

    await queue.drain();

    const stats = await queue.stats();
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(false);
  });

  it("continues processing after a failed job and increments failed count", async () => {
    const queue = new ExtractionQueue();
    const results: string[] = [];

    await queue.enqueue(async () => { results.push("a"); });
    await queue.enqueue(async () => { throw new Error("boom"); });
    await queue.enqueue(async () => { results.push("c"); });

    await queue.drain();

    expect(results).toContain("a");
    expect(results).toContain("c");
    const stats = await queue.stats();
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    expect(stats.completed).toBeGreaterThanOrEqual(2);
  });

  it("drain resolves immediately when queue is empty", async () => {
    const queue = new ExtractionQueue();
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it("handles multiple concurrent drain() calls", async () => {
    const queue = new ExtractionQueue();

    await queue.enqueue(async () => {});
    await queue.enqueue(async () => {});

    const [r1, r2] = await Promise.all([queue.drain(), queue.drain()]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
  });

  it("stats() returns the expected shape", async () => {
    const queue = new ExtractionQueue();
    const stats = await queue.stats();
    expect(stats).toMatchObject({
      pending: expect.any(Number),
      completed: expect.any(Number),
      failed: expect.any(Number),
      processing: expect.any(Boolean),
    });
  });

  it("sends failed jobs to dead-letter queue after retry limit", async () => {
    // Make the mock boss's send also route DLQ jobs to dlqJobs.
    const queue = new ExtractionQueue();
    const dlqSends: string[] = [];

    // Intercept boss.send to track DLQ submissions.
    const originalSend = mockBoss.send;
    mockBoss.send = vi.fn(async (name: string, data: Record<string, unknown>) => {
      if (name === "usme-extraction-failed") {
        dlqSends.push(name);
      }
      return originalSend(name, data);
    });

    await queue.enqueue(async () => { throw new Error("always fails"); });
    await queue.drain();

    const stats = await queue.stats();
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    // DLQ send should have been attempted.
    expect(dlqSends.length).toBeGreaterThanOrEqual(1);
  });

  it("processes jobs serially (teamConcurrency=1)", async () => {
    const queue = new ExtractionQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeJob = () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((r) => setTimeout(r, 5));
      concurrent--;
    };

    await queue.enqueue(makeJob());
    await queue.enqueue(makeJob());
    await queue.enqueue(makeJob());

    await queue.drain();

    expect(maxConcurrent).toBe(1);
  });

  it("resetExtractionQueue() returns a fresh instance", async () => {
    const q1 = new ExtractionQueue();
    await q1.enqueue(async () => {});
    await q1.drain();

    resetExtractionQueue();

    const q2 = new ExtractionQueue();
    const stats = await q2.stats();
    expect(stats.completed).toBe(0);
  });
});
