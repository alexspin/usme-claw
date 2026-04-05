import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { FACT_EXTRACTION_V1 } from "./prompts/fact-extraction-v1.js";
import { insertSensoryTrace } from "../db/queries.js";

// ── Types ──────────────────────────────────────────────────

export interface ExtractedItem {
  type: "fact" | "preference" | "decision" | "plan" | "anomaly" | "ephemeral";
  content: string;
  utility: "high" | "medium" | "low" | "discard";
  provenance_kind: "user" | "tool" | "model";
  tags: string[];
  ephemeral_ttl_hours: number | null;
}

export interface FactExtractionResult {
  items: ExtractedItem[];
}

export interface ExtractionContext {
  sessionId: string;
  turnIndex: number;
  serializedTurn: string;
}

export interface ExtractorConfig {
  model?: string;
  maxTokens?: number;
}

// ── Logger ─────────────────────────────────────────────────

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`[usme:extract] ${msg}`, data ?? ""),
  error: (msg: string, err?: unknown) =>
    console.error(`[usme:extract] ERROR ${msg}`, err ?? ""),
};

// ── Core Extraction ────────────────────────────────────────

function buildPrompt(serializedTurn: string): string {
  return FACT_EXTRACTION_V1.template
    .replace("{date}", new Date().toISOString().split("T")[0])
    .replace("{serialized_turn}", serializedTurn);
}

function computeExpiresAt(ttlHours: number | null): Date | null {
  if (ttlHours == null || ttlHours <= 0) return null;
  return new Date(Date.now() + ttlHours * 3600_000);
}

export async function extractFacts(
  client: Anthropic,
  ctx: ExtractionContext,
  config?: ExtractorConfig,
): Promise<FactExtractionResult> {
  const prompt = buildPrompt(ctx.serializedTurn);

  const response = await client.messages.create({
    model: config?.model ?? "claude-haiku-4-20250414",
    max_tokens: config?.maxTokens ?? 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const parsed = JSON.parse(text) as FactExtractionResult;

  if (!Array.isArray(parsed.items)) {
    throw new Error("Fact extraction returned invalid structure: missing items array");
  }

  return parsed;
}

// ── Persist to DB ──────────────────────────────────────────

export async function persistExtractedItems(
  pool: pg.Pool,
  ctx: ExtractionContext,
  result: FactExtractionResult,
): Promise<string[]> {
  const ids: string[] = [];

  for (const item of result.items) {
    if (item.utility === "discard") continue;

    const id = await insertSensoryTrace(pool, {
      session_id: ctx.sessionId,
      turn_index: ctx.turnIndex,
      item_type: "extracted",
      memory_type: item.type,
      content: item.content,
      embedding: null, // embedding generated separately
      provenance_kind: item.provenance_kind,
      provenance_ref: null,
      utility_prior: item.utility,
      tags: item.tags,
      extractor_ver: FACT_EXTRACTION_V1.version,
      metadata: {},
      episodified_at: null,
      expires_at: computeExpiresAt(item.ephemeral_ttl_hours),
    });

    ids.push(id);
  }

  log.info(
    `Persisted ${ids.length}/${result.items.length} items for session=${ctx.sessionId} turn=${ctx.turnIndex}`,
  );

  return ids;
}

// ── Fire-and-Forget Entry Point ────────────────────────────

export async function runFactExtraction(
  client: Anthropic,
  pool: pg.Pool,
  ctx: ExtractionContext,
  config?: ExtractorConfig,
): Promise<void> {
  try {
    const result = await extractFacts(client, ctx, config);
    await persistExtractedItems(pool, ctx, result);
  } catch (err) {
    log.error(
      `Fact extraction failed for session=${ctx.sessionId} turn=${ctx.turnIndex}`,
      err,
    );
    // Non-blocking: swallow error, extraction is best-effort
  }
}
