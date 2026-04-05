/**
 * USME-CLAW OpenClaw ContextEngine plugin.
 *
 * Implements the full ContextEngine interface, bridging the framework-agnostic
 * usme-core library to the OpenClaw plugin system.
 */

import type { Pool } from "pg";
import {
  getPool,
  closePool,
  insertSensoryTrace,
} from "@usme/core";
import {
  assemble as coreAssemble,
  type AssembleRequest,
  type AssembleOptions,
  type InjectedMemory,
} from "@usme/core/assemble/index.js";

import { resolveConfig, type UsmePluginConfig } from "./config.js";
import {
  runShadowAssemble,
  recordShadowComparison,
  type AgentMessage,
  type ShadowAssembleResult,
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
function injectedToSystemAddition(items: InjectedMemory[]): string {
  if (items.length === 0) return "";
  const lines = items.map(
    (item) => `[${item.tier}/${item.id.substring(0, 8)}] ${item.content}`,
  );
  return [
    "<usme-context>",
    "The following relevant context was retrieved from memory:",
    "",
    ...lines,
    "</usme-context>",
  ].join("\n");
}

/** Placeholder embedding generator (returns zero vector). */
function placeholderEmbedding(): number[] {
  return new Array(1536).fill(0);
}

// ── Plugin implementation ────────────────────────────────────

let turnCounter = 0;

export function createUsmeEngine(
  userConfig?: Partial<UsmePluginConfig>,
): ContextEngine {
  const config = resolveConfig(userConfig);
  let pool: Pool | null = null;

  function getDbPool(): Pool {
    if (!pool) {
      const connString = `postgres://${config.db.user}:${config.db.password}@${config.db.host}:${config.db.port}/${config.db.database}`;
      pool = getPool({
        connectionString: connString,
        max: config.db.poolMax,
        idleTimeoutMs: config.db.idleTimeoutMs,
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

      // Enqueue async extraction (non-blocking, fire-and-forget)
      setImmediate(() => {
        // In v1, extraction runs in-process via setImmediate.
        // The actual extraction logic lives in usme-core/extract.
        // For now, just log the intent; the extraction worker will
        // pick up un-extracted verbatim traces from the DB.
        console.log(
          `[usme] afterTurn: enqueued extraction for session=${sessionId}, turns=${messages.length}`,
        );
      });
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      if (config.mode === "disabled") {
        return { messages, estimatedTokens: 0 };
      }

      const budget = tokenBudget ?? config.assembly.modes[config.assembly.defaultMode].tokenBudget;
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
        queryEmbedding: placeholderEmbedding(),
      };

      // Shadow mode: run concurrently but discard output
      if (config.mode === "shadow") {
        const lcmLatencyStart = performance.now();
        const shadowResult = await runShadowAssemble(async () => {
          const start = performance.now();
          const result = await coreAssemble(assembleRequest, assembleOptions);
          return { assembleResult: result, latencyMs: performance.now() - start };
        });

        const lcmLatencyMs = performance.now() - lcmLatencyStart;
        await recordShadowComparison(
          getDbPool(),
          {
            sessionId,
            turnIndex,
            queryPreview: query.substring(0, 200),
            lcmMessages: messages,
            lcmLatencyMs,
          },
          shadowResult,
          config.shadow,
        );

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
      await closePool();
      pool = null;
    },
  };

  return engine;
}

export default createUsmeEngine;
