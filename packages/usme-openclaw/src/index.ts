/**
 * USME OpenClaw plugin entry point.
 *
 * Three modes, controlled by config.mode (read at startup from openclaw.json):
 *
 *   active    — Full retrieval + assembly pipeline runs every turn. The assembled
 *               context block is injected into the prompt via prependContext.
 *               Writes a structured JSON-lines entry to the injection log each turn.
 *
 *   log-only  — Same retrieval + assembly pipeline as active mode, but nothing is
 *               injected into the context window. Writes the same log entry.
 *               Use for validation/testing before going live.
 *
 *   off       — USME does nothing. No DB connections, no hooks registered,
 *               no scheduler started, no log entries written.
 *
 * The injection log is separate from the gateway's main log.
 * Path: USME_INJECTION_LOG env var || /tmp/usme/injection.jsonl
 * Format: one JSON object per line (JSON lines), human-readable.
 */

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  getPool,
  closePool,
  startScheduler,
  assemble as coreAssemble,
  embedText,
  stripMetadataEnvelope,
  bumpAccessCounts,
  logger,
} from "@usme/core";
import type { SchedulerHandle } from "@usme/core";
import { resolveConfig } from "./config.js";
import { injectedToSystemAddition, extractText } from "./plugin.js";

export const id = "usme-claw";

// ── Injection log ──────────────────────────────────────────────────────────────

const INJECTION_LOG_FILE =
  process.env.USME_INJECTION_LOG ?? "/tmp/usme/injection.jsonl";

function ensureInjectionLogDir(): void {
  const dir = path.dirname(INJECTION_LOG_FILE);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Best-effort: if dir creation fails, writes below will also fail and be swallowed
  }
}

interface InjectionLogEntry {
  /** ISO-8601 wall time */
  ts: string;
  sessionId: string;
  /** "active" | "log-only" */
  mode: string;
  /** Number of memory items packed into the context block */
  itemsSelected: number;
  /** Number of candidates considered before packing */
  itemsConsidered: number;
  /** Memory tiers that contributed candidates */
  tiersQueried: string[];
  /** Estimated tokens of the injected context block (0 in log-only) */
  tokensInjected: number;
  /** End-to-end pipeline duration in milliseconds */
  durationMs: number;
  /** True only in active mode when a non-empty context block was returned */
  injected: boolean;
  /** Full text of the assembled context block (empty string when no items) */
  contextBlock: string;
}

/**
 * Append one JSON-lines entry to the injection log (synchronous, best-effort).
 * Errors are swallowed so logging never affects the hot path.
 */
function writeInjectionLog(entry: InjectionLogEntry): void {
  try {
    ensureInjectionLogDir();
    fs.appendFileSync(INJECTION_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Never let logging failure affect the hot path
  }
}

// ── Scheduler singleton ────────────────────────────────────────────────────────

let _schedulerHandle: SchedulerHandle | null = null;

// ── Plugin entry point ─────────────────────────────────────────────────────────

export default function usmePlugin(api: {
  on: <K extends string>(
    event: K,
    handler: (
      event: Record<string, unknown>,
      ctx?: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
    opts?: { priority?: number },
  ) => void;
  config: any;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerService?: (svc: {
    id: string;
    start: () => void;
    stop: () => Promise<void>;
  }) => void;
}) {
  const config = resolveConfig(
    api.config?.plugins?.entries?.["usme-claw"]?.config,
  );

  // Treat legacy "disabled" value as "off" for backwards compatibility
  const effectiveMode = (config.mode as string) === "disabled" ? "off" : config.mode;

  // ── off mode: do nothing at all ────────────────────────────────────────────
  if (effectiveMode === "off") {
    api.logger.info("[usme] mode=off — no hooks registered, no connections opened");
    return;
  }

  // ── Shared setup (active + log-only) ──────────────────────────────────────
  const connString = `postgres://${config.db.user}:${config.db.password}@${config.db.host}:${config.db.port}/${config.db.database}`;
  const pool = getPool({
    connectionString: connString,
    max: config.db.poolMax,
    idleTimeoutMillis: config.db.idleTimeoutMs,
  });

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const openaiKey = process.env.OPENAI_API_KEY ?? "";

  if (anthropicKey) {
    if (!_schedulerHandle) {
      const anthropicClient = new Anthropic({ apiKey: anthropicKey });
      _schedulerHandle = startScheduler(anthropicClient, pool, {
        sonnetModel: config.consolidation.sonnetModel,
        opusModel: config.consolidation.skillDraftingModel,
        embeddingApiKey: openaiKey,
        cronExpression: config.consolidation.cron,
        miniConsolidationIntervalMs: 30 * 60_000,
        runOnStart: false,
      });
      api.logger.info("[usme] consolidation scheduler started");
    }
  } else {
    api.logger.warn("[usme] no ANTHROPIC_API_KEY — consolidation scheduler disabled");
  }

  const log = logger.child({ module: "index" });
  const isActive = effectiveMode === "active";

  api.logger.info(
    `[usme] mode=${effectiveMode} | injectionLog=${INJECTION_LOG_FILE}`,
  );

  // ── Hook registration ──────────────────────────────────────────────────────
  //
  // The before_prompt_build hook can return { prependContext } to inject text
  // into the prompt. Returning void/undefined leaves the prompt unchanged.
  api.on(
    "before_prompt_build",
    async (event, ctx) => {
      const ev = event as {
        prompt?: string;
        messages?: unknown[];
        sessionId?: string;
        sessionKey?: string;
      };
      const hookCtx = ctx as
        | { sessionKey?: string; sessionId?: string }
        | undefined;

      const sessionId = ev.sessionId ?? hookCtx?.sessionId ?? "unknown";
      const sessionKey = hookCtx?.sessionKey ?? "";
      if (/^agent:[^:]+:(cron|subagent):/.test(sessionKey)) {
        return undefined; // skip cron and subagent sessions — noise in memory
      }

      // Normalise messages to { role, content } pairs with plain-text content
      const rawMessages = ev.messages ?? [];
      const agentMessages = rawMessages.map((m: any) => ({
        role: typeof m?.role === "string" ? m.role : "user",
        content:
          typeof m?.content === "string"
            ? m.content
            : Array.isArray(m?.content)
              ? extractText(m.content)
              : String(m?.content ?? ""),
      }));

      const lastUserMsg = [...agentMessages]
        .reverse()
        .find((m) => m.role === "user");

      if (!lastUserMsg?.content) {
        // No user message to embed — nothing to do
        return undefined;
      }

      const query = stripMetadataEnvelope(extractText(lastUserMsg.content));
      if (!query || query.length < 3) return undefined;

      // ── Run full retrieval + assembly pipeline ─────────────────────────────
      const pipelineStart = performance.now();
      let contextBlock = "";
      let itemsSelected = 0;
      let itemsConsidered = 0;
      let tiersQueried: string[] = [];
      let tokensInjected = 0;

      try {
        const embeddingKey = config.embeddingApiKey || openaiKey;
        if (!embeddingKey) {
          log.warn("no embedding API key — skipping USME pipeline this turn");
          return undefined;
        }

        const queryEmbedding = await embedText(query, embeddingKey);

        const assemblyMode = config.assembly.defaultMode;
        const tokenBudget = (
          config.assembly.modes as Record<string, { tokenBudget: number }>
        )[assemblyMode].tokenBudget;

        const result = await coreAssemble(
          {
            query,
            sessionId,
            conversationHistory: agentMessages,
            mode: assemblyMode,
            tokenBudget,
            turnIndex: agentMessages.filter((m) => m.role === "user").length,
          },
          { pool, queryEmbedding },
        );

        itemsSelected = result.metadata.itemsSelected;
        itemsConsidered = result.metadata.itemsConsidered;
        tiersQueried = result.metadata.tiersQueried as string[];
        tokensInjected = result.metadata.tokensUsed;

        if (result.items.length > 0) {
          contextBlock = injectedToSystemAddition(result.items);

          // Fire-and-forget: bump access counts for retrieved items
          void bumpAccessCounts(pool, result.items).catch(() => {/* ignore */});
        }
      } catch (err) {
        log.error({ err }, "USME pipeline failed — skipping injection this turn");
        return undefined;
      }

      const durationMs = performance.now() - pipelineStart;

      // ── Write structured injection log entry ──────────────────────────────
      writeInjectionLog({
        ts: new Date().toISOString(),
        sessionId,
        mode: effectiveMode,
        itemsSelected,
        itemsConsidered,
        tiersQueried,
        tokensInjected,
        durationMs: Math.round(durationMs),
        injected: isActive && contextBlock.length > 0,
        contextBlock,
      });

      // ── Inject context (active mode only) ────────────────────────────────
      if (isActive && contextBlock.length > 0) {
        // prependContext is injected into the prompt by OpenClaw before the
        // model sees the conversation. This is the correct field for
        // per-turn dynamic context (not prependSystemContext which is cached).
        return { prependContext: contextBlock };
      }

      // log-only: full pipeline ran, log written, no injection
      return undefined;
    },
    { priority: -5 },
  );

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  api.registerService?.({
    id: "usme-pool",
    start: () => {},
    stop: async () => {
      _schedulerHandle?.stop();
      _schedulerHandle = null;
      await closePool();
    },
  });
}
