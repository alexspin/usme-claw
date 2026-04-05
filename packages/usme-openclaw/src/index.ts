/**
 * USME OpenClaw plugin entry point.
 *
 * Registers as a before_prompt_build hook for shadow mode.
 * LCM stays active and owns the context-engine slot — USME runs
 * fire-and-forget alongside it, recording shadow comparisons.
 */

import { getPool, closePool } from "@usme/core";
import { resolveConfig } from "./config.js";
import { runShadowAssemble } from "./shadow.js";

export const id = "usme-claw";

export default function usmePlugin(api: {
  on: (
    event: string,
    handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => void | undefined,
    opts?: { priority?: number },
  ) => void;
  config: any;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  registerService?: (svc: { id: string; start: () => void; stop: () => Promise<void> }) => void;
}) {
  const config = resolveConfig(api.config?.plugins?.entries?.["usme-claw"]?.config);

  if (config.mode === "disabled") {
    api.logger.info("[usme] disabled via config, no hooks registered");
    return;
  }

  const connString = `postgres://${config.db.user}:${config.db.password}@${config.db.host}:${config.db.port}/${config.db.database}`;
  const pool = getPool({
    connectionString: connString,
    max: config.db.poolMax,
    idleTimeoutMillis: config.db.idleTimeoutMs,
  });

  api.on(
    "before_prompt_build",
    (event, ctx) => {
      const ev = event as {
        messages?: Array<{ role: string; content?: string | ReadonlyArray<unknown> }>;
        sessionId?: string;
        sessionKey?: string;
      };
      const hookCtx = ctx as { sessionKey?: string; sessionId?: string } | undefined;

      const messages = ev.messages;
      const sessionId = ev.sessionId ?? hookCtx?.sessionId ?? "unknown";

      if (!messages || messages.length === 0) return undefined;

      // Fire-and-forget: run shadow assemble without blocking the hook
      const agentMessages = messages.map((m) => ({
        ...m,
        content: typeof m.content === "string" ? m.content : "",
      }));
      runShadowAssemble(pool, config, sessionId, agentMessages).catch((err) => {
        api.logger.error(`[usme] shadow assemble failed: ${err}`);
      });

      return undefined;
    },
    { priority: -5 },
  );

  api.registerService?.({
    id: "usme-pool",
    start: () => {},
    stop: async () => closePool(),
  });

  api.logger.info(
    config.mode === "shadow" ? "[usme] shadow mode active" : "[usme] active mode",
  );
}
