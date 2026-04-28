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
  deliverSkillCandidates,
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
export function injectedToSystemAddition(
  items: InjectedMemory[],
  constraintLines?: string[],
): string {
  if (items.length === 0 && (!constraintLines || constraintLines.length === 0)) return "";

  const parts: string[] = ["<usme-context>"];

  if (constraintLines && constraintLines.length > 0) {
    parts.push("[constraints]");
    parts.push(...constraintLines);
    parts.push("");
  }

  if (items.length > 0) {
    parts.push("Relevant memories retrieved for this turn:");
    parts.push("");
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
    parts.push(...lines);
  }

  parts.push("</usme-context>");
  return parts.join("\n");
}

export const id = "usme-claw";

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
  registerCommand?: (cmd: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: { commandBody?: string }) => Promise<{ text: string }> | { text: string };
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
      void (async () => {
        _schedulerHandle = await startScheduler(anthropicClient, pool, {
          sonnetModel: config.consolidation.sonnetModel,
          opusModel: config.consolidation.skillDraftingModel,
          embeddingApiKey: openaiKey,
          cronExpression: config.consolidation.cron,
          miniConsolidationIntervalMs: 30 * 60_000,
          runOnStart: false,
          sendFn: async (card: string) => {
            const { execFileSync } = await import("node:child_process");
            // Build a system event that wakes Rufus and instructs it to present the card
            const eventText = `[USME-SKILL-DELIVERY] Skill candidate review is ready. Present the following skill candidates to the user for promotion decisions:\n\n${card}`;
            try {
              execFileSync(
                "openclaw",
                ["system", "event", "--text", eventText, "--mode", "now"],
                { stdio: "inherit" },
              );
              api.logger.info("[usme] skill delivery system event fired successfully");
            } catch (err) {
              api.logger.error(`[usme] skill delivery system event failed: ${err instanceof Error ? err.message : String(err)}`);
              // Log the card so it is not lost
              api.logger.info(`[usme] skill delivery card (fallback log): ${card}`);
            }
          },
        });
        api.logger.info("[usme] consolidation scheduler started");
      })();
    }
  } else {
    api.logger.warn("[usme] no ANTHROPIC_API_KEY — consolidation scheduler disabled");
  }

  const log = logger.child({ module: "index" });
  const isActive = effectiveMode === "active";

  api.logger.info(`[usme] mode=${effectiveMode}`);

  // ── Hook registration ──────────────────────────────────────────────────────
  //
  // The before_prompt_build hook can return { prependContext } to inject text
  // into the prompt. Returning void/undefined leaves the prompt unchanged.
  logger.debug({ mode: effectiveMode, isActive }, "[usme] hook registration");
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
      log.debug({ sessionId, sessionKey, msgCount: (ev.messages ?? []).length }, "[usme] hook fired");

      if (/^agent:[^:]+:(cron|subagent):/.test(sessionKey)) {
        log.debug("[usme] early exit: cron/subagent session filter matched");
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

      log.debug({ hasLastUserMsg: !!lastUserMsg, preview: lastUserMsg?.content?.slice(0, 80) }, "[usme] lastUserMsg");
      if (!lastUserMsg?.content) {
        log.debug("[usme] early exit: no user message found");
        return undefined;
      }

      const query = stripMetadataEnvelope(extractText(lastUserMsg.content));
      log.debug({ queryLength: query?.length ?? 0, preview: (query ?? "").slice(0, 60) }, "[usme] query after strip");
      if (!query || query.length < 3) {
        log.debug(`[usme] early exit: query too short (${query?.length ?? 0} chars)`);
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
        log.debug({ hasKey: !!embeddingKey, keyLen: embeddingKey?.length }, "[usme] embeddingKey check");
        if (!embeddingKey) {
          log.warn("no embedding API key — skipping USME pipeline this turn");
          log.debug("[usme] early exit: no embedding API key");
          return undefined;
        }

        log.debug({ queryPreview: query.slice(0, 60) }, "[usme] calling embedText");
        const queryEmbedding = await embedText(query, embeddingKey);
        log.debug({ vectorLength: queryEmbedding?.length ?? null }, "[usme] embedText OK");

        const assemblyMode = config.assembly.defaultMode;
        const tokenBudget = (
          config.assembly.modes as Record<string, { tokenBudget: number }>
        )[assemblyMode].tokenBudget;

        log.debug({ mode: assemblyMode, tokenBudget, turnIndex: agentMessages.filter(m => m.role === "user").length }, "[usme] calling coreAssemble");

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
        log.debug({ itemsSelected, itemsConsidered, tiersQueried, tokensInjected, spreadingEpisodesAdded: _spreadingMetrics?.episodesAdded ?? 0 }, "[usme] coreAssemble OK");

        // ── Load active constraints (outside token budget) ────────────────────────
        let constraintLines: string[] = [];
        try {
          const { rows: activeConstraints } = await pool.query(
            `SELECT pattern, content FROM constraints
             WHERE dismissed_at IS NULL
             ORDER BY created_at DESC
             LIMIT 10`,
          );
          constraintLines = activeConstraints.map(
            (r: { pattern: string; content: string }) => `${r.pattern}: ${r.content}`,
          );
        } catch (constraintErr) {
          log.warn({ err: constraintErr }, "[usme] constraints query failed (non-fatal)");
        }

        if (result.items.length > 0 || constraintLines.length > 0) {
          contextBlock = injectedToSystemAddition(result.items, constraintLines);
          log.debug({ contextBlockLength: contextBlock.length }, "[usme] contextBlock built");
          if (result.items.length > 0) {
            void bumpAccessCounts(pool, result.items).catch((err: unknown) => {
              logger.warn({ err }, "[usme] bumpAccessCounts failed (non-fatal)");
            });
          }
        } else {
          log.debug("[usme] result.items empty — contextBlock will be empty");
        }
      } catch (err) {
        log.error({ err }, "USME pipeline failed — skipping injection this turn");
        return undefined;
      }

      const durationMs = performance.now() - pipelineStart;

      // ── Write structured injection log entry ──────────────────────────────
      log.info({
        type: "injection",
        sessionId,
        mode: effectiveMode,
        itemsSelected,
        itemsConsidered,
        tiersQueried,
        tokensInjected,
        durationMs: Math.round(durationMs),
        injected: isActive && contextBlock.length > 0,
        spreadingDepth: _spreadingMetrics?.spreadDepth,
        entitiesMatched: _spreadingMetrics?.entitiesMatched,
        episodesAdded: _spreadingMetrics?.episodesAdded,
      }, "[usme] injection");

      log.debug({ durationMs: Math.round(performance.now() - pipelineStart), injected: isActive && contextBlock.length > 0 }, "[usme] pipeline done");

      // ── Fire-and-forget extraction (fact + entity) ────────────────────────
      // Runs after retrieval so it never blocks injection. Uses the same
      // agentMessages already normalized above.
      log.debug({ extractionEnabled: config.extraction?.enabled, hasAnthropicKey: !!anthropicKey }, "[usme] extraction check");
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

        log.debug({ serializedTurnLength: serializedTurn.length }, "[usme] serializedTurn");
        if (/\bHEARTBEAT\b/i.test(serializedTurn)) {
          log.debug("[usme] extraction skipped: HEARTBEAT pattern");
          // fall through to injection return below
        } else if (serializedTurn) {
          const anthropicClient = new Anthropic({ apiKey: anthropicKey });
          const queue = getExtractionQueue();
          log.debug({ model: config.extraction.model }, "[usme] enqueueing fact extraction");
          queue.enqueue(async () => {
            log.debug("[usme] runFactExtraction start");
            try {
              await runFactExtraction(
                anthropicClient, pool,
                { sessionId, turnIndex: agentMessages.filter((m) => m.role === "user").length, serializedTurn },
                { model: config.extraction.model, embeddingApiKey: config.embeddingApiKey || openaiKey },
              );
              log.debug("[usme] runFactExtraction OK");
            } catch (err) { log.error({ err }, "[usme] runFactExtraction failed"); }
          });
          const entityEnabled = config.extraction.entityExtraction?.enabled;
          log.debug({ entityExtractionEnabled: entityEnabled }, "[usme] entity extraction check");
          if (entityEnabled) {
            queue.enqueue(async () => {
              log.debug("[usme] runEntityExtraction start");
              try {
                await runEntityExtraction(
                  anthropicClient, pool,
                  serializedTurn,
                  { model: config.extraction.entityExtraction.model, embeddingApiKey: config.embeddingApiKey || openaiKey },
                );
                log.debug("[usme] runEntityExtraction OK");
              } catch (err) { log.error({ err }, "[usme] runEntityExtraction failed"); }
            });
          }
        } else {
          log.debug("[usme] extraction skipped: serializedTurn empty");
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

  // ── Strip <usme-context> blocks before transcript storage ─────────────────
  // Prevents the injected memory block from accumulating in stored messages
  // and growing the context window by ~10K tokens per turn.
  api.on(
    "before_message_write",
    (event) => {
      const ev = event as { message?: { content?: unknown } };
      if (!ev.message) return;
      const msg = ev.message as { content?: unknown };

      const strip = (s: string): string =>
        s.replace(/<usme-context>[\s\S]*?<\/usme-context>\s*/g, "");

      if (typeof msg.content === "string") {
        const cleaned = strip(msg.content);
        if (cleaned !== msg.content) {
          return { message: { ...msg, content: cleaned } };
        }
      } else if (Array.isArray(msg.content)) {
        let changed = false;
        const newContent = msg.content.map((part: any) => {
          if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
            const cleaned = strip(part.text);
            if (cleaned !== part.text) {
              changed = true;
              return { ...part, text: cleaned };
            }
          }
          return part;
        });
        if (changed) {
          return { message: { ...msg, content: newContent } };
        }
      }
    },
  );

  // ── CLI command registration ──────────────────────────────────────────────
  api.registerCommand?.({
    name: "usme-reflect",
    description: "Run the USME Memory Reflection Service on demand",
    acceptsArgs: true,
    requireAuth: false,
    async handler(ctx: { commandBody?: string }) {
      const args = (ctx.commandBody ?? "").trim().split(/\s+/).filter(Boolean);
      try {
        await reflectCommand(args);
        return { text: "Reflection complete. Check logs for details." };
      } catch (err) {
        log.error({ err }, "reflect command failed");
        return { text: `Reflection failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  api.registerService?.({
    id: "usme-pool",
    start: () => {},
    stop: async () => {
      await _schedulerHandle?.stop();
      _schedulerHandle = null;
      await getExtractionQueue().drain();
      await closePool();
    },
  });
}
