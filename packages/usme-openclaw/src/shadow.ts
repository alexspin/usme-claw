/**
 * Shadow mode harness.
 *
 * In shadow mode, USME assemble() runs concurrently with LCM but its output
 * is discarded. We record a shadow_comparisons row for later analysis.
 */

import type { Pool } from "pg";
import { insertShadowComparison } from "@usme/core";
import type { ShadowComparison } from "@usme/core";
import type { AssembleResult } from "@usme/core/assemble/types.js";
import type { ShadowConfig } from "./config.js";

export interface AgentMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface ShadowRunInput {
  sessionId: string;
  turnIndex: number;
  queryPreview: string;
  lcmMessages: AgentMessage[];
  lcmLatencyMs: number;
}

export interface ShadowAssembleResult {
  assembleResult: AssembleResult;
  latencyMs: number;
}

/**
 * Run USME assemble() in shadow mode alongside LCM.
 * If assemble throws, logs the error and returns null (graceful degradation).
 */
export async function runShadowAssemble(
  assembleFn: () => Promise<ShadowAssembleResult>,
): Promise<ShadowAssembleResult | null> {
  try {
    return await assembleFn();
  } catch (err) {
    console.error("[usme-shadow] assemble() failed, degrading gracefully:", err);
    return null;
  }
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
 * Record a shadow comparison row after a turn completes.
 */
export async function recordShadowComparison(
  pool: Pool,
  input: ShadowRunInput,
  usmeResult: ShadowAssembleResult | null,
  config: ShadowConfig,
): Promise<void> {
  if (!config.logComparison) return;
  if (Math.random() > config.samplingRate) return;

  const lcmTokenCount = estimateTokens(input.lcmMessages);

  const usmeContent = usmeResult?.assembleResult.items.map((i) => i.content) ?? [];
  const lcmContent = input.lcmMessages.map((m) =>
    typeof m.content === "string" ? m.content : "",
  );

  const overlapScore = usmeResult ? computeOverlapScore(usmeContent, lcmContent) : null;

  const usmeTokenCount = usmeResult?.assembleResult.metadata.tokensUsed ?? null;
  const tokenDelta = usmeTokenCount != null ? usmeTokenCount - lcmTokenCount : null;

  const tiersContributed = usmeResult
    ? usmeResult.assembleResult.metadata.tiersQueried
    : null;

  const usmeOnlyPreview = usmeContent.length > 0
    ? usmeContent[0].substring(0, 200)
    : null;

  const lcmOnlyPreview = lcmContent.length > 0
    ? lcmContent[0].substring(0, 200)
    : null;

  const cmp: Omit<ShadowComparison, "id" | "created_at"> = {
    session_id: input.sessionId,
    turn_index: input.turnIndex,
    query_preview: input.queryPreview.substring(0, 200),
    lcm_token_count: lcmTokenCount,
    lcm_latency_ms: input.lcmLatencyMs,
    usme_token_count: usmeTokenCount,
    usme_latency_ms: usmeResult?.latencyMs ?? null,
    usme_mode: usmeResult?.assembleResult.metadata.mode ?? null,
    usme_tiers_contributed: tiersContributed,
    usme_items_selected: usmeResult?.assembleResult.metadata.itemsSelected ?? null,
    usme_items_considered: usmeResult?.assembleResult.metadata.itemsConsidered ?? null,
    usme_system_addition_tokens: null,
    token_delta: tokenDelta,
    overlap_score: overlapScore,
    usme_only_preview: usmeOnlyPreview,
    lcm_only_preview: lcmOnlyPreview,
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
