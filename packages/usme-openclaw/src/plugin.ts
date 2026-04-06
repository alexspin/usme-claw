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
  startScheduler,
  stripMetadataEnvelope,
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

// ── LCM transform registration ────────────────────────────────

// ORDERING: memtx registers transforms at startup; USME registers here (per-session bootstrap)
// so USME always runs after memtx in the transform chain. Do not move this registration to module init.

const LCM_TRANSFORM_KEY = '__rufus_lcm_context_transforms';
const USME_TRANSFORM_REGISTERED_KEY = '__usme_transform_registered';

type LcmTransformFn = (sessionId: string, msgs: unknown[]) => Promise<unknown[] | null>;

function registerLcmTransform(id: string, fn: LcmTransformFn): void {
  const g = globalThis as Record<string, unknown>;
  if (!Array.isArray(g[LCM_TRANSFORM_KEY])) {
    g[LCM_TRANSFORM_KEY] = [];
  }
  const transforms = g[LCM_TRANSFORM_KEY] as Array<{ id: string; fn: LcmTransformFn }>;
  const idx = transforms.findIndex((t) => t.id === id);
  if (idx >= 0) transforms.splice(idx, 1);
  transforms.push({ id, fn });
  g[LCM_TRANSFORM_KEY] = transforms.map((t) => t.fn);
}

function registerUsmeTransformOnce(fn: LcmTransformFn): void {
  const g = globalThis as Record<string, unknown>;
  if (g[USME_TRANSFORM_REGISTERED_KEY]) return;
  g[USME_TRANSFORM_REGISTERED_KEY] = true;
  registerLcmTransform('usme-inject', fn);
}

/** Zero vector fallback for empty queries or missing API key. */
function zeroEmbedding(): number[] {
  return new Array(1536).fill(0);
}

// ── Plugin implementation ────────────────────────────────────

let turnCounter = 0;

export function createUsmeEngine(
  userConfig?: Partial<UsmePluginConfig>,
): ContextEngine {
  const config = resolveConfig(userConfig);
  let pool: Pool | null = null;
  let schedulerHandle: SchedulerHandle | null = null;

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
      ownsCompaction: true,
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

        // Register LCM context transform (per-session bootstrap, after pool is ready)
        const usmeInjectTransform: LcmTransformFn = async (
          _sessionId: string,
          msgs: unknown[],
        ): Promise<unknown[] | null> => {
          const timeoutPromise = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 150),
          );
          const workPromise = (async (): Promise<unknown[] | null> => {
            try {
              // Find the last user message
              const lastUserMsg = [...(msgs as Array<{ role: string; content?: unknown }>)]
                .reverse()
                .find((m) => m.role === "user");
              if (!lastUserMsg) return null;

              const query = typeof lastUserMsg.content === "string"
                ? lastUserMsg.content
                : JSON.stringify(lastUserMsg.content ?? "");
              if (!query) return null;

              const queryEmbedding = config.embeddingApiKey
                ? await embedText(query, config.embeddingApiKey)
                : zeroEmbedding();

              const mode = config.assembly.defaultMode;
              const budget = (config.assembly.modes as Record<string, { tokenBudget: number }>)[mode].tokenBudget;

              const assembleRequest: AssembleRequest = {
                query,
                sessionId: _sessionId,
                conversationHistory: msgs,
                mode,
                tokenBudget: budget,
                turnIndex: (msgs as Array<{ role: string }>).filter((m) => m.role === "user").length,
              };

              const assembleOptions: AssembleOptions = {
                pool: getDbPool(),
                queryEmbedding,
              };

              const result = await coreAssemble(assembleRequest, assembleOptions);
              if (!result.items || result.items.length === 0) return null;

              const contextBlock = injectedToSystemAddition(result.items);

              // Fire-and-forget shadow comparison
              void recordShadowComparison(
                getDbPool(),
                _sessionId,
                msgs as AgentMessage[],
                result,
                query,
              ).catch(() => {/* ignore */});

              // Append as new user message at end
              return [
                ...msgs,
                { role: "user", content: contextBlock },
              ];
            } catch {
              return null;
            }
          })();

          return Promise.race([workPromise, timeoutPromise]);
        };

        registerUsmeTransformOnce(usmeInjectTransform);

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

      try {
        const p = getDbPool();
        const itemId = await insertSensoryTrace(p, {
          session_id: sessionId,
          turn_index: turnCounter++,
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

      // Fire-and-forget fact extraction (non-blocking)
      setImmediate(() => {
        const anthropicClient = new Anthropic({ apiKey: anthropicKey });
        const serialized = messages
          .slice(-4) // last ~2 turns for context
          .map((m) => `[${m.role}]: ${stripMetadataEnvelope(typeof m.content === "string" ? m.content : String(m.content))}`)
          .join("\n\n");
        runFactExtraction(anthropicClient, getDbPool(), {
          sessionId,
          turnIndex: messages.length,
          serializedTurn: serialized,
        }, { model: config.extraction.model, embeddingApiKey: config.embeddingApiKey }).catch((err) => {
          console.error("[usme] afterTurn extraction failed:", err);
        });
      });
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      if (config.mode === "disabled") {
        return { messages, estimatedTokens: 0 };
      }

      const budget = tokenBudget ?? (config.assembly.modes as Record<string, { tokenBudget: number }>)[config.assembly.defaultMode].tokenBudget;
      const mode = config.assembly.defaultMode;
      const turnIndex = turnIndexFromMessages(messages);

      // Extract query from last user message
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const query = lastUserMsg
        ? typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg.content)
        : "";

      const assembleRequest: AssembleRequest = {
        query,
        sessionId,
        conversationHistory: messages,
        mode,
        tokenBudget: budget,
        turnIndex,
      };

      const assembleOptions: AssembleOptions = {
        pool: getDbPool(),
        queryEmbedding: query && config.embeddingApiKey
          ? await embedText(query, config.embeddingApiKey)
          : zeroEmbedding(),
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

        return {
          messages,
          estimatedTokens: result.metadata.tokensUsed,
          systemPromptAddition: systemAddition || undefined,
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
      await closePool();
      pool = null;
    },
  };

  return engine;
}

export default createUsmeEngine;
