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
  runFactExtraction,
  runEntityExtraction,
  getExtractionQueue,
  logger,
} from "@usme/core";
import type { SchedulerHandle, InjectedMemory } from "@usme/core";
import { resolveConfig } from "./config.js";
import { spreadingActivation } from "./spread.js";
import { reflectCommand } from "./commands/reflect.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Unwrap Anthropic content block arrays to plain text (recursive). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((b): string[] => {
        if (!b || typeof b !== "object") return [];
        if ((b as any).type === "text" && typeof (b as any).text === "string") return [(b as any).text];
        if ((b as any).content) return [extractText((b as any).content)];
        return [];
      })
      .join("\n");
  }
  return String(content ?? "");
}

/** Convert InjectedMemory[] items into a system prompt addition. */
export function injectedToSystemAddition(items: InjectedMemory[]): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  for (const item of items) {
    const dateStr = item.createdAt instanceof Date
      ? item.createdAt.toISOString().slice(0, 10)
      : String(item.createdAt).slice(0, 10);
    const relevance = item.score >= 0.75 ? "high" : item.score >= 0.50 ? "med" : "low";
    let header = `[${item.tier} | ${dateStr} | relevance:${relevance}`;
    if (item.tags && item.tags.length > 0) {
      header += ` | tags:${item.tags.join(",")}`;
    }
    header += "]";
    lines.push(header);
    lines.push(item.content);
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return [
    "<usme-context>",
    "Relevant memories retrieved for this turn:",
    "",
    ...lines,
    "</usme-context>",
  ].join("\n");
}

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
  /** Spreading activation depth used (undefined when disabled) */
  spreadingDepth?: number;
  /** Number of entities matched during spreading activation */
  entitiesMatched?: number;
  /** Number of episodes added by spreading activation */
  episodesAdded?: number;
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

// ── Debug logger (file-based, zero deps, always writable) ───────────────────

const DBG_LOG = "/tmp/usme/debug.log";
function dbg(msg: string): void {
  try {
    fs.mkdirSync("/tmp/usme", { recursive: true });
    fs.appendFileSync(DBG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* never break the hot path */ }
}

// ── Scheduler singleton ────────────────────────────────────────────────────────

let _schedulerHandle: SchedulerHandle | null = null;

// NOTE: singleton guard removed. OpenClaw invokes the factory 4-5x per startup
// with different api instances. Only the dispatched instance fires the hook, so
// all instances must register independently. Duplicate runs per turn are acceptable.

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
  dbg(`hook registration: mode=${effectiveMode} isActive=${isActive}`);
  api.logger.info(`[usme] registering hook (mode=${effectiveMode})`);

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
      dbg(`hook fired: sessionId=${sessionId} sessionKey=${sessionKey} msgCount=${(ev.messages ?? []).length}`);

      if (/^agent:[^:]+:(cron|subagent):/.test(sessionKey)) {
        dbg(`early exit: cron/subagent session filter matched`);
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

      dbg(`lastUserMsg: ${lastUserMsg ? `"${String(lastUserMsg.content).slice(0, 80)}"` : 'NULL'}`);
      if (!lastUserMsg?.content) {
        dbg(`early exit: no user message found`);
        return undefined;
      }

      const query = stripMetadataEnvelope(extractText(lastUserMsg.content));
      dbg(`query after strip: length=${query?.length ?? 0} preview="${(query ?? "").slice(0, 60)}"`);
      if (!query || query.length < 3) {
        dbg(`early exit: query too short (${query?.length ?? 0} chars)`);
        return undefined;
      }

      // ── Run full retrieval + assembly pipeline ─────────────────────────────
      const pipelineStart = performance.now();
      let contextBlock = "";
      let itemsSelected = 0;
      let itemsConsidered = 0;
      let tiersQueried: string[] = [];
      let tokensInjected = 0;
      let _spreadingMetrics: { entitiesMatched: number; episodesAdded: number; spreadDepth: number } | undefined;

      try {
        const embeddingKey = config.embeddingApiKey || openaiKey;
        dbg(`embeddingKey: ${embeddingKey ? `set (len=${embeddingKey.length})` : 'MISSING'}`);
        if (!embeddingKey) {
          log.warn("no embedding API key — skipping USME pipeline this turn");
          dbg(`early exit: no embedding API key`);
          return undefined;
        }

        dbg(`calling embedText query="${query.slice(0, 60)}"`);
        const queryEmbedding = await embedText(query, embeddingKey);
        dbg(`embedText OK: vector length=${queryEmbedding?.length ?? 'null'}`);

        const assemblyMode = config.assembly.defaultMode;
        const tokenBudget = (
          config.assembly.modes as Record<string, { tokenBudget: number }>
        )[assemblyMode].tokenBudget;

        dbg(`calling coreAssemble: mode=${assemblyMode} tokenBudget=${tokenBudget} turnIndex=${agentMessages.filter((m) => m.role === "user").length}`);

        const spreadingDepth = config.spreading?.maxDepth ?? 2;
        const spreadingPass = spreadingDepth > 0 ? {
          run: (candidates: import("@usme/core").RetrievalCandidate[], p: import("pg").Pool) =>
            spreadingActivation(candidates, p, { maxDepth: spreadingDepth, maxAdditional: 10 }),
        } : undefined;

        const result = await coreAssemble(
          {
            query,
            sessionId,
            conversationHistory: agentMessages,
            mode: assemblyMode,
            tokenBudget,
            turnIndex: agentMessages.filter((m) => m.role === "user").length,
          },
          { pool, queryEmbedding, spreadingPass },
        );

        itemsSelected = result.metadata.itemsSelected;
        itemsConsidered = result.metadata.itemsConsidered;
        tiersQueried = result.metadata.tiersQueried as string[];
        tokensInjected = result.metadata.tokensUsed;
        _spreadingMetrics = (result.metadata as { spreadingMetrics?: { entitiesMatched: number; episodesAdded: number; spreadDepth: number } }).spreadingMetrics;
        dbg(`coreAssemble OK: itemsSelected=${itemsSelected} itemsConsidered=${itemsConsidered} tiers=${tiersQueried.join(",")} tokens=${tokensInjected} spreading.episodesAdded=${_spreadingMetrics?.episodesAdded ?? 0}`);

        if (result.items.length > 0) {
          contextBlock = injectedToSystemAddition(result.items);
          dbg(`contextBlock built: length=${contextBlock.length} chars`);
          void bumpAccessCounts(pool, result.items).catch(() => {/* ignore */});
        } else {
          dbg(`result.items is empty — contextBlock will be empty string`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        dbg(`PIPELINE ERROR: ${errMsg}`);
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
        spreadingDepth: _spreadingMetrics?.spreadDepth,
        entitiesMatched: _spreadingMetrics?.entitiesMatched,
        episodesAdded: _spreadingMetrics?.episodesAdded,
      });

      dbg(`pipeline done: durationMs=${Math.round(performance.now() - pipelineStart)} injected=${isActive && contextBlock.length > 0}`);

      // ── Fire-and-forget extraction (fact + entity) ────────────────────────
      // Runs after retrieval so it never blocks injection. Uses the same
      // agentMessages already normalized above.
      dbg(`extraction check: enabled=${config.extraction?.enabled} anthropicKey=${anthropicKey ? 'set' : 'MISSING'}`);
      if (config.extraction?.enabled && anthropicKey) {
        const serializedTurn = agentMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => {
            const text = stripMetadataEnvelope(extractText(m.content));
            return text.length >= 10 ? `[${m.role}]: ${text}` : null;
          })
          .filter((s): s is string => s !== null)
          .slice(-4)
          .join("\n\n");

        dbg(`serializedTurn length=${serializedTurn.length}`);
        if (serializedTurn) {
          const anthropicClient = new Anthropic({ apiKey: anthropicKey });
          const queue = getExtractionQueue();
          dbg(`enqueueing fact extraction model=${config.extraction.model}`);
          queue.enqueue(async () => {
            dbg(`runFactExtraction START`);
            try {
              await runFactExtraction(
                anthropicClient, pool,
                { sessionId, turnIndex: agentMessages.filter((m) => m.role === "user").length, serializedTurn },
                { model: config.extraction.model, embeddingApiKey: config.embeddingApiKey || openaiKey },
              );
              dbg(`runFactExtraction OK`);
            } catch (err) { dbg(`runFactExtraction ERROR: ${err instanceof Error ? err.message : String(err)}`); }
          });
          const entityEnabled = config.extraction.entityExtraction?.enabled;
          dbg(`entity extraction enabled=${entityEnabled}`);
          if (entityEnabled) {
            queue.enqueue(async () => {
              dbg(`runEntityExtraction START`);
              try {
                await runEntityExtraction(
                  anthropicClient, pool,
                  serializedTurn,
                  { model: config.extraction.entityExtraction.model, embeddingApiKey: config.embeddingApiKey || openaiKey },
                );
                dbg(`runEntityExtraction OK`);
              } catch (err) { dbg(`runEntityExtraction ERROR: ${err instanceof Error ? err.message : String(err)}`); }
            });
          }
        } else {
          dbg(`extraction skipped: serializedTurn empty`);
        }
      }

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
  // ── CLI command registration ──────────────────────────────────────────────
  api.on("command:usme:reflect", async (event) => {
    const args = (event.args as string[]) ?? [];
    try {
      await reflectCommand(args);
    } catch (err) {
      log.error({ err }, "reflect command failed");
    }
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  api.registerService?.({
    id: "usme-pool",
    start: () => {},
    stop: async () => {
      _schedulerHandle?.stop();
      _schedulerHandle = null;
      await getExtractionQueue().drain();
      await closePool();
    },
  });
}
