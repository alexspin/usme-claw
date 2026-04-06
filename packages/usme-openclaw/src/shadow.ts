/**
 * Shadow mode harness.
 *
 * In shadow mode, USME assemble() runs concurrently with LCM but its output
 * is discarded. We record a shadow_comparisons row for later analysis.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { appendFileSync, mkdirSync } from "node:fs";
function dbg(msg: string) { try { mkdirSync("/tmp/usme-debug", { recursive: true }); appendFileSync("/tmp/usme-debug/shadow.log", `[${new Date().toISOString()}] ${msg}\n`); } catch {} }
import {
  insertShadowComparison,
  assemble,
  embedText,
  runFactExtraction,
  stripMetadataEnvelope,
} from "@usme/core";
import type { ShadowComparison, AssembleResult } from "@usme/core";
import type { UsmePluginConfig } from "./config.js";
import { injectedToSystemAddition } from "./plugin.js";

export interface AgentMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Compute overlap score between USME items and LCM messages.
 * Simple token-level overlap ratio.
 */
export function computeOverlapScore(
  usmeContent: string[],
  lcmContent: string[],
): number {
  const usmeTokens = new Set(
    usmeContent.join(" ").toLowerCase().split(/\s+/),
  );
  const lcmTokens = new Set(lcmContent.join(" ").toLowerCase().split(/\s+/));

  if (usmeTokens.size === 0 && lcmTokens.size === 0) return 1.0;
  if (usmeTokens.size === 0 || lcmTokens.size === 0) return 0.0;

  let overlap = 0;
  for (const t of usmeTokens) {
    if (lcmTokens.has(t)) overlap++;
  }
  const union = new Set([...usmeTokens, ...lcmTokens]).size;
  return overlap / union;
}

/**
 * Estimate token count from messages (rough: ~4 chars per token).
 */
function estimateTokens(messages: AgentMessage[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0) / 4,
  );
}

/**
 * Run USME assemble() in shadow mode alongside LCM.
 * If assemble throws, logs the error and returns null (graceful degradation).
 */
export async function runShadowAssemble(
  pool: Pool,
  config: UsmePluginConfig,
  sessionId: string,
  messages: AgentMessage[],
): Promise<AssembleResult | null> {
  try {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMessage || !lastUserMessage.content) return null;

    dbg(`embedText for query: "${lastUserMessage.content.slice(0,80)}" apiKey=${config.embeddingApiKey ? "SET" : "MISSING"}`);
    const queryEmbedding = await embedText(lastUserMessage.content, config.embeddingApiKey);
    dbg(`embedText OK: dimensions=${queryEmbedding?.length}`);

    const request = {
      query: lastUserMessage.content,
      sessionId,
      conversationHistory: messages,
      mode: config.assembly.defaultMode,
      tokenBudget: (config.assembly.modes as Record<string, { tokenBudget: number }>)[config.assembly.defaultMode].tokenBudget,
      turnIndex: messages.length,
    };

    dbg(`assemble() calling with mode=${request.mode} budget=${request.tokenBudget}`);
    const assembleResult = await assemble(request, { pool, queryEmbedding });
    dbg(`assemble() OK: selected=${assembleResult.metadata.itemsSelected} considered=${assembleResult.metadata.itemsConsidered} tiers=${assembleResult.metadata.tiersQueried}`);

    await recordShadowComparison(pool, sessionId, messages, assembleResult, lastUserMessage.content);

    // Fire-and-forget extraction: serialize the last user message and extract facts
    dbg(`extraction check: enabled=${config.extraction.enabled} embeddingApiKey=${config.embeddingApiKey ? "SET("+config.embeddingApiKey.slice(0,8)+"...)" : "MISSING"}`);
    if (config.extraction.enabled) {
      const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
      dbg(`ANTHROPIC_API_KEY=${anthropicKey ? "SET" : "MISSING"}`);
      if (anthropicKey) {
        setImmediate(() => {
          dbg(`setImmediate fired`);
          const anthropicClient = new Anthropic({ apiKey: anthropicKey });
          const serialized = messages
            .slice(-4) // last ~2 turns for context
            .map((m) => `[${m.role}]: ${stripMetadataEnvelope(typeof m.content === "string" ? m.content : String(m.content))}`)
            .join("\n\n");
          runFactExtraction(anthropicClient, pool, {
            sessionId,
            turnIndex: messages.length,
            serializedTurn: serialized,
          }, { model: config.extraction.model, embeddingApiKey: config.embeddingApiKey }).catch((err) => {
            console.error("[usme-shadow] extraction failed:", err);
          });
        });
      }
    }

    return assembleResult;
  } catch (err) {
    dbg(`runShadowAssemble CAUGHT ERROR: ${err instanceof Error ? err.stack : err}`);
    console.error("[usme-shadow] assemble() failed, degrading gracefully:", err);
    return null;
  }
}

/**
 * Record a shadow comparison row after a turn completes.
 */
export async function recordShadowComparison(
  pool: Pool,
  sessionId: string,
  messages: AgentMessage[],
  usmeResult: AssembleResult | null,
  lastUserContent?: string,
): Promise<void> {
  const lcmTokenCount = estimateTokens(messages);

  const usmeContent = usmeResult?.items.map((i) => i.content) ?? [];
  const lcmContent = messages.map((m) =>
    typeof m.content === "string" ? m.content : "",
  );

  const overlapScore = usmeResult ? computeOverlapScore(usmeContent, lcmContent) : null;

  const cmp: Omit<ShadowComparison, "id" | "created_at"> = {
    session_id: sessionId,
    turn_index: messages.length,
    query_preview: lastUserContent?.slice(0, 200) ?? null,
    lcm_token_count: lcmTokenCount,
    lcm_latency_ms: null,
    usme_token_count: usmeResult?.metadata.tokensUsed ?? 0,
    usme_latency_ms: usmeResult?.metadata.durationMs ?? null,
    usme_mode: usmeResult?.metadata.mode ?? null,
    usme_tiers_contributed: usmeResult?.metadata.tiersQueried ?? null,
    usme_items_selected: usmeResult?.metadata.itemsSelected ?? null,
    usme_items_considered: usmeResult?.metadata.itemsConsidered ?? null,
    usme_system_addition_tokens: null,
    token_delta: usmeResult ? usmeResult.metadata.tokensUsed : null, // injection token overhead (tokens USME adds to context)
    overlap_score: overlapScore,
    usme_only_preview: usmeResult?.items.length
      ? injectedToSystemAddition(usmeResult.items)
      : null,
    lcm_only_preview: null,
    usme_relevance_score: null,
    usme_memory_cited: null,
    relevance_analysis_done: false,
  };

  try {
    await insertShadowComparison(pool, cmp);
  } catch (err) {
    console.error("[usme-shadow] Failed to record comparison:", err);
  }
}
