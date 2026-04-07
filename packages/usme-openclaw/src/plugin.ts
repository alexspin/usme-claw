/**
 * USME-CLAW OpenClaw ContextEngine plugin.
 *
 * Implements the full ContextEngine interface, bridging the framework-agnostic
 * usme-core library to the OpenClaw plugin system.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import {
  getPool,
  closePool,
  insertSensoryTrace,
  embedText,
  assemble as coreAssemble,
  runFactExtraction,
  runEntityExtraction,
  getExtractionQueue,
  startScheduler,
  stripMetadataEnvelope,
  bumpAccessCounts,
  type AssembleRequest,
  type AssembleOptions,
  type InjectedMemory,
  type SchedulerHandle,
} from "@usme/core";

import { resolveConfig, type UsmePluginConfig } from "./config.js";
import {
  runShadowAssemble,
  recordShadowComparison,
  type AgentMessage,
} from "./shadow.js";

// ── ContextEngine interface types ────────────────────────────

export interface ContextEngineInfo {
  id: string;
  name: string;
  version: string;
  ownsCompaction: boolean;
}

export interface BootstrapResult {
  ok: boolean;
  message?: string;
}

export interface IngestResult {
  ok: boolean;
  itemId?: string;
}

export interface IngestBatchResult {
  ok: boolean;
  itemIds: string[];
}

export interface AssembleResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
}

export interface SubagentSpawnPreparation {
  childSessionKey: string;
  parentSessionKey: string;
}

export interface ContextEngine {
  readonly info: ContextEngineInfo;

  bootstrap?(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<BootstrapResult>;

  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;

  ingestBatch?(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;

  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }): Promise<void>;

  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;

  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult>;

  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;

  onSubagentEnded?(params: {
    childSessionKey: string;
    reason: "deleted" | "completed" | "swept" | "released";
  }): Promise<void>;

  dispose?(): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────

/** Unwrap Anthropic content block arrays to plain text (recursive). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((b): string[] => {
        if (!b || typeof b !== "object") return [];
        if (b.type === "text" && typeof b.text === "string") return [b.text];
        if (b.content) return [extractText(b.content)];
        return [];
      })
      .join("\n");
  }
  return String(content ?? "");
}

/** Derive a turn index from the messages array length. */
function turnIndexFromMessages(messages: AgentMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
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
  // Remove trailing blank line
  if (lines[lines.length - 1] === "") lines.pop();
  return [
    "<usme-context>",
    "Relevant memories retrieved for this turn:",
    "",
    ...lines,
    "</usme-context>",
  ].join("\n");
}

/** Zero vector fallback for empty queries or missing API key. */
function zeroEmbedding(): number[] {
  return new Array(1536).fill(0);
}

// ── Plugin implementation ────────────────────────────────────

export function createUsmeEngine(
  userConfig?: Partial<UsmePluginConfig>,
): ContextEngine {
  const config = resolveConfig(userConfig);
  let pool: Pool | null = null;
  let schedulerHandle: SchedulerHandle | null = null;

  // Per-session pre-warm cache: ingest() fires embedText early, assemble() awaits the result
  const warmCache = new Map<string, Promise<number[]>>();
  const warmCacheTimestamps: Map<string, number> = new Map();

  function getDbPool(): Pool {
    if (!pool) {
      const connString = `postgres://${config.db.user}:${config.db.password}@${config.db.host}:${config.db.port}/${config.db.database}`;
      pool = getPool({
        connectionString: connString,
        max: config.db.poolMax,
        idleTimeoutMillis: config.db.idleTimeoutMs,
      });
    }
    return pool;
  }

  const engine: ContextEngine = {
    info: {
      id: "usme-claw",
      name: "USME Context Engine",
      version: "0.1.0",
      ownsCompaction: false,
    },

    async bootstrap({ sessionId }) {
      try {
        const p = getDbPool();
        // Verify connectivity
        await p.query("SELECT 1");
        console.log(`[usme] bootstrapped for session ${sessionId}, mode=${config.mode}`);

        // Start consolidation scheduler if not disabled
        if (config.mode !== "disabled" && !schedulerHandle) {
          const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
          if (anthropicKey) {
            const anthropicClient = new Anthropic({ apiKey: anthropicKey });
            const schedulerConfig = {
              cronExpression: config.consolidation.cron,
              sonnetModel: config.consolidation.sonnetModel,
              opusModel: config.consolidation.skillDraftingModel,
              embeddingApiKey: config.embeddingApiKey,
            };
            schedulerHandle = startScheduler(anthropicClient, getDbPool(), schedulerConfig);
            const { getNextCronRunISO } = (() => {
              const parts = schedulerConfig.cronExpression.trim().split(/\s+/);
              const targetMin = parseInt(parts[0], 10) || 0;
              const targetHour = parseInt(parts[1], 10) || 3;
              const next = new Date();
              next.setUTCHours(targetHour, targetMin, 0, 0);
              if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
              return { getNextCronRunISO: () => next.toISOString() };
            })();
            console.log(`[usme] consolidation scheduler started, next run: ${getNextCronRunISO()}`);
          }
        }

        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[usme] bootstrap failed:", msg);
        return { ok: false, message: msg };
      }
    },

    async ingest({ sessionId, message, isHeartbeat }) {
      if (config.mode === "disabled") return { ok: true };
      if (isHeartbeat) return { ok: true };

      // Sweep stale warmCache entries (TTL: 2 minutes, max: 200 entries)
      const now = Date.now();
      for (const [sid, ts] of warmCacheTimestamps) {
        if (now - ts > 120_000) {
          warmCache.delete(sid);
          warmCacheTimestamps.delete(sid);
        }
      }
      if (warmCache.size > 200) {
        const oldest = [...warmCacheTimestamps.entries()].sort((a, b) => a[1] - b[1])[0];
        if (oldest) {
          warmCache.delete(oldest[0]);
          warmCacheTimestamps.delete(oldest[0]);
        }
      }

      try {
        const p = getDbPool();
        const itemId = await insertSensoryTrace(p, {
          session_id: sessionId,
          turn_index: 0,
          item_type: "verbatim",
          memory_type: null,
          content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          embedding: null,
          provenance_kind: message.role === "user" ? "user" : "model",
          provenance_ref: null,
          utility_prior: "medium",
          tags: [],
          extractor_ver: null,
          metadata: { role: message.role },
          episodified_at: null,
          expires_at: null,
        });
        // Non-blocking embed-after-insert
        const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        const p2 = getDbPool();
        setImmediate(async () => {
          try {
            if (!config.embeddingApiKey) return;
            const vec = await embedText(content, config.embeddingApiKey);
            await p2.query(
              "UPDATE sensory_trace SET embedding = $1 WHERE id = $2",
              [`[${vec.join(",")}]`, itemId],
            );
          } catch (err) {
            console.error("[usme] embed-after-insert failed:", err);
          }
        });

        // Pre-warm: start embedding the user query so assemble() finds it ready
        if (message.role === "user" && config.embeddingApiKey) {
          const rawContent = typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
          const strippedQuery = stripMetadataEnvelope(extractText(rawContent));
          if (strippedQuery.length >= 10) {
            warmCache.set(sessionId, embedText(strippedQuery, config.embeddingApiKey));
            warmCacheTimestamps.set(sessionId, Date.now());
          }
        }

        return { ok: true, itemId };
      } catch (err) {
        console.error("[usme] ingest failed:", err);
        return { ok: false };
      }
    },

    async ingestBatch({ sessionId, messages, isHeartbeat }) {
      if (config.mode === "disabled") return { ok: true, itemIds: [] };
      if (isHeartbeat) return { ok: true, itemIds: [] };

      const itemIds: string[] = [];
      for (const message of messages) {
        const result = await engine.ingest({ sessionId, message });
        if (result.itemId) itemIds.push(result.itemId);
      }
      return { ok: true, itemIds };
    },

    async afterTurn({ sessionId, messages }) {
      if (config.mode === "disabled") return;
      if (!config.extraction.enabled) return;

      const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
      if (!anthropicKey) return;

      // Queue fact and entity extraction (non-blocking, serialized via queue)
      const anthropicClient = new Anthropic({ apiKey: anthropicKey });
      const serializedTurn = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const text = stripMetadataEnvelope(extractText(m.content));
          return text.length >= 10 ? `[${m.role}]: ${text}` : null;
        })
        .filter((s): s is string => s !== null)
        .slice(-4)
        .join("\n\n");
      const queue = getExtractionQueue();
      queue.enqueue(async () => { await runFactExtraction(anthropicClient, getDbPool(), { sessionId, turnIndex: messages.filter(m => m.role === 'user').length, serializedTurn }, { model: config.extraction.model, embeddingApiKey: config.embeddingApiKey }); });
      if (config.extraction.entityExtraction.enabled) {
        queue.enqueue(async () => { await runEntityExtraction(anthropicClient, getDbPool(), serializedTurn, { model: config.extraction.entityExtraction.model, embeddingApiKey: config.embeddingApiKey }); });
      }
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      if (config.mode === "disabled") {
        return { messages, estimatedTokens: 0 };
      }

      const budget = tokenBudget ?? (config.assembly.modes as Record<string, { tokenBudget: number }>)[config.assembly.defaultMode].tokenBudget;
      const mode = config.assembly.defaultMode;
      const turnIndex = turnIndexFromMessages(messages);

      // Extract query from last user message — strip metadata envelope for ANN consistency
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const rawQuery = lastUserMsg
        ? typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg.content)
        : "";
      const query = stripMetadataEnvelope(extractText(rawQuery));

      const assembleRequest: AssembleRequest = {
        query,
        sessionId,
        conversationHistory: messages,
        mode,
        tokenBudget: budget,
        turnIndex,
      };

      // Use pre-warmed embedding if available (started in ingest()), else fall back to fresh call
      const warmedEmbeddingPromise = warmCache.get(sessionId);
      warmCache.delete(sessionId); // consume — one-shot per turn

      let queryEmbedding: number[];
      if (warmedEmbeddingPromise) {
        queryEmbedding = await warmedEmbeddingPromise;
      } else {
        queryEmbedding = query && config.embeddingApiKey
          ? await embedText(query, config.embeddingApiKey)
          : zeroEmbedding();
      }

      const assembleOptions: AssembleOptions = {
        pool: getDbPool(),
        queryEmbedding,
      };

      // Shadow mode: run concurrently but discard output
      if (config.mode === "shadow") {
        await runShadowAssemble(getDbPool(), config, sessionId, messages);

        // In shadow mode, return original messages unmodified
        return { messages, estimatedTokens: 0 };
      }

      // Active mode: run assemble and inject results
      try {
        const result = await coreAssemble(assembleRequest, assembleOptions);
        const systemAddition = injectedToSystemAddition(result.items);

        // Fire-and-forget: record assembly metrics for active mode
        void recordShadowComparison(
          getDbPool(),
          sessionId,
          messages,
          result,
          query || undefined,
        ).catch(() => {/* ignore */});

        // Fire-and-forget: bump access counts for retrieved items
        void bumpAccessCounts(getDbPool(), result.items).catch(() => {/* ignore */});

        // Inject USME context as a prepended synthetic user message instead of system prompt addition.
        // This keeps the system prompt prefix stable for Anthropic prompt cache hits.
        const finalMessages = systemAddition
          ? [
              {
                role: "user" as const,
                content: systemAddition,
              } as AgentMessage,
              ...messages,
            ]
          : messages;

        return {
          messages: finalMessages,
          estimatedTokens: result.metadata.tokensUsed,
          // systemPromptAddition intentionally omitted to preserve prompt cache stability
        };
      } catch (err) {
        console.error("[usme] assemble() failed, returning original messages:", err);
        return { messages, estimatedTokens: 0 };
      }
    },

    async compact({ sessionId, force }) {
      if (config.mode === "disabled") {
        return { ok: true, compacted: false, reason: "disabled" };
      }

      // Reinterpret compact() as on-demand episode compression.
      // In v1 this triggers the episodification step synchronously.
      console.log(
        `[usme] compact: reinterpreted as episode flush, session=${sessionId}, force=${force}`,
      );

      // TODO: call consolidation/episodify when available
      return {
        ok: true,
        compacted: false,
        reason: "on-demand episode flush not yet implemented in v1",
        result: {
          tokensBefore: 0,
        },
      };
    },

    async prepareSubagentSpawn({ parentSessionKey, childSessionKey }) {
      // Minimal v1: just track the relationship
      console.log(
        `[usme] subagent spawn: parent=${parentSessionKey} child=${childSessionKey}`,
      );
      return { parentSessionKey, childSessionKey };
    },

    async onSubagentEnded({ childSessionKey, reason }) {
      // Minimal v1: log cleanup
      console.log(
        `[usme] subagent ended: child=${childSessionKey} reason=${reason}`,
      );
    },

    async dispose() {
      console.log("[usme] disposing plugin, closing DB pool");
      if (schedulerHandle) {
        schedulerHandle.stop();
        schedulerHandle = null;
      }
      await getExtractionQueue().drain();
      await closePool();
      pool = null;
    },
  };

  return engine;
}

export default createUsmeEngine;
