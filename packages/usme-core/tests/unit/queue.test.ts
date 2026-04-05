/**
 * Unit tests for the in-process extraction queue.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ExtractionQueue } from "../../src/extract/queue.js";

describe("ExtractionQueue", () => {
  let queue: ExtractionQueue;

  beforeEach(() => {
    queue = new ExtractionQueue();
  });

  it("processes jobs in FIFO order", async () => {
    const order: number[] = [];

    queue.enqueue(async () => { order.push(1); });
    queue.enqueue(async () => { order.push(2); });
    queue.enqueue(async () => { order.push(3); });

    await queue.drain();

    expect(order).toEqual([1, 2, 3]);
  });

  it("reports correct stats after completion", async () => {
    queue.enqueue(async () => {});
    queue.enqueue(async () => {});

    await queue.drain();

    const stats = queue.stats();
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(false);
  });

  it("continues processing after a failed job", async () => {
    const results: string[] = [];

    queue.enqueue(async () => { results.push("a"); });
    queue.enqueue(async () => { throw new Error("boom"); });
    queue.enqueue(async () => { results.push("c"); });

    await queue.drain();

    expect(results).toEqual(["a", "c"]);
    const stats = queue.stats();
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
  });

  it("drain resolves immediately when queue is empty", async () => {
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it("handles multiple drain() calls", async () => {
    queue.enqueue(async () => {});
    queue.enqueue(async () => {});

    const [r1, r2] = await Promise.all([queue.drain(), queue.drain()]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
  });

  it("processes one job at a time (no concurrency)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeJob = () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    };

    queue.enqueue(makeJob());
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());

    await queue.drain();

    expect(maxConcurrent).toBe(1);
  });
});
