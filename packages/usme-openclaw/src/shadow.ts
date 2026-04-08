/**
 * Shadow mode harness.
 *
 * In shadow mode, USME assemble() runs concurrently with LCM but its output
 * is discarded. We record a shadow_comparisons row for later analysis.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import {
  insertShadowComparison,
  assemble,
  embedText,
  runFactExtraction,
  stripMetadataEnvelope,
  getExtractionQueue,
  logger,
} from "@usme/core";
import type { ShadowComparison, AssembleResult } from "@usme/core";
import type { UsmePluginConfig } from "./config.js";
import { injectedToSystemAddition, extractText } from "./plugin.js";

const log = logger.child({ module: "shadow" });

export interface AgentMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Compute overlap score between USME items and LCM messages.
 * Word-bag Jaccard removed — use vector similarity from pgvector instead.
 */
export function computeOverlapScore(
  _usmeContent: string[],
  _lcmContent: string[],
): number {
  return 0;
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

    // Strip metadata envelope (e.g. "Sender (untrusted metadata): ..." prepended by OpenClaw)
    // before embedding so boilerplate doesn't pollute ANN retrieval.
    // Use extractText() — same as plugin.ts assemble() — to keep derivation consistent.
    const rawContent = typeof lastUserMessage.content === "string"
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage.content);
    const cleanQuery = stripMetadataEnvelope(extractText(rawContent));

    log.debug({ queryPreview: cleanQuery.slice(0, 80) }, "embedText for shadow query");
    const queryEmbedding = await embedText(cleanQuery, config.embeddingApiKey);
    log.debug({ dimensions: queryEmbedding?.length }, "embedText OK");

    const request = {
      query: cleanQuery,
      sessionId,
      conversationHistory: messages,
      mode: config.assembly.defaultMode,
      tokenBudget: (config.assembly.modes as Record<string, { tokenBudget: number }>)[config.assembly.defaultMode].tokenBudget,
      turnIndex: messages.length,
    };

    const assembleResult = await assemble(request, { pool, queryEmbedding });
    log.debug({
      selected: assembleResult.metadata.itemsSelected,
      considered: assembleResult.metadata.itemsConsidered,
      tiers: assembleResult.metadata.tiersQueried,
    }, "assemble() OK");

    await recordShadowComparison(pool, sessionId, messages, assembleResult, cleanQuery);

    // Fire-and-forget extraction: serialize the last user message and extract facts
    if (config.extraction.enabled) {
      const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
      if (anthropicKey) {
        const anthropicClient = new Anthropic({ apiKey: anthropicKey });
        const serialized = messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => {
            const text = stripMetadataEnvelope(
              typeof m.content === "string"
                ? m.content
                : Array.isArray(m.content)
                  ? (m.content as Array<{type?: string; text?: string; content?: unknown}>)
                      .flatMap(function extractBlocks(b): string[] {
                        if (!b || typeof b !== "object") return [];
                        if (b.type === "text" && typeof b.text === "string") return [b.text];
                        if (b.content) {
                          const inner = b.content;
                          return Array.isArray(inner)
                            ? inner.flatMap(extractBlocks)
                            : typeof inner === "string" ? [inner] : [];
                        }
                        return [];
                      })
                      .join("\n")
                  : ""
            );
            return text.length >= 10 ? `[${m.role}]: ${text}` : null;
          })
          .filter((s): s is string => s !== null)
          .slice(-4) // last 4 non-empty messages — slice AFTER filtering so empty tool results don't consume the window
          .join("\n\n");
        const queue = getExtractionQueue();
        queue.enqueue(async () => {
          await runFactExtraction(anthropicClient, pool, {
            sessionId,
            turnIndex: messages.length,
            serializedTurn: serialized,
          }, { model: config.extraction.model, embeddingApiKey: config.embeddingApiKey });
        });
      }
    }

    return assembleResult;
  } catch (err) {
    log.error({ err }, "runShadowAssemble failed, degrading gracefully");
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
