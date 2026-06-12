import type { ParsedArgs } from "./parse.js";
import { performance } from "node:perf_hooks";

export interface DebugLogger {
  enabled: boolean;
  log: (event: string, fields?: Record<string, unknown>) => void;
  duration: <T>(event: string, fn: () => Promise<T>, fields?: Record<string, unknown>) => Promise<T>;
}

export function createDebugLogger(args: ParsedArgs): DebugLogger {
  const env = process.env.USME_CLI_DEBUG?.toLowerCase();
  const enabled = args.values.debug === true || env === "1" || env === "true";
  const started = performance.now();

  function log(event: string, fields: Record<string, unknown> = {}): void {
    if (!enabled) return;
    const elapsedMs = Math.round(performance.now() - started);
    const details = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(" ");
    process.stderr.write(
      `[usme-cli debug +${elapsedMs}ms] ${event}${details ? ` ${details}` : ""}\n`,
    );
  }

  async function duration<T>(
    event: string,
    fn: () => Promise<T>,
    fields: Record<string, unknown> = {},
  ): Promise<T> {
    log(`${event}.start`, fields);
    const t0 = performance.now();
    try {
      const result = await fn();
      log(`${event}.end`, { ...fields, durationMs: Math.round(performance.now() - t0) });
      return result;
    } catch (err) {
      log(`${event}.error`, {
        ...fields,
        durationMs: Math.round(performance.now() - t0),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return { enabled, log, duration };
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(",");
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
