import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { appendFileSync, mkdirSync } from "node:fs";
import { FACT_EXTRACTION_V1 } from "./prompts/fact-extraction-v1.js";
import { insertSensoryTrace, findSimilarTrace } from "../db/queries.js";
import { embedBatch } from "../embed/index.js";

export const DEDUP_SIMILARITY_THRESHOLD = 0.95;

function dbg(msg: string) {
  try { mkdirSync("/tmp/usme-debug", { recursive: true }); appendFileSync("/tmp/usme-debug/extractor.log", `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// ── Types ──────────────────────────────────────────────────

export interface ExtractedItem {
  type: "fact" | "preference" | "decision" | "plan" | "anomaly" | "ephemeral" | "insight";
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

  dbg(`raw haiku response (${text.length} chars): ${JSON.stringify(text.slice(0, 300))}`);

  // Robustly extract JSON: find outermost { ... } block, ignoring any surrounding text/fences
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    dbg(`no JSON object found in response`);
    throw new Error(`Fact extraction: no JSON object found in response. Raw: ${text.slice(0, 200)}`);
  }
  const jsonText = text.slice(jsonStart, jsonEnd + 1);
  dbg(`extracted JSON (${jsonText.length} chars): ${jsonText.slice(0, 200)}`);

  const parsed = JSON.parse(jsonText) as FactExtractionResult;

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
  embeddingApiKey?: string,
): Promise<string[]> {
  dbg(`persistExtractedItems: ${result.items.length} items, apiKey=${embeddingApiKey ? "SET("+embeddingApiKey.slice(0,8)+"...)" : "MISSING"}`);
  const ids: string[] = [];

  // Filter out discards first
  const keepItems = result.items.filter(item => {
    if (item.utility === "discard") { dbg(`skip discard: "${item.content.slice(0,50)}"`); return false; }
    return true;
  });

  // Batch embed all non-discard items at once
  const embeddings: (number[] | null)[] = keepItems.map(() => null);
  if (embeddingApiKey && keepItems.length > 0) {
    dbg(`batch embedding ${keepItems.length} items`);
    try {
      const contents = keepItems.map(item => item.content);
      const batchResult = await embedBatch(contents, embeddingApiKey);
      for (let i = 0; i < batchResult.length; i++) {
        embeddings[i] = batchResult[i];
      }
      dbg(`batch embed ok: ${batchResult.length} embeddings`);
    } catch (err) {
      dbg(`batch embed FAILED: ${err}`);
      log.error(`Failed to batch embed items, storing without embeddings: ${err}`);
    }
  } else {
    dbg(`no apiKey — skipping embed`);
  }

  for (let i = 0; i < keepItems.length; i++) {
    const item = keepItems[i];
    const embedding = embeddings[i];

    // Near-duplicate suppression: skip if a very similar trace already exists
    if (embedding) {
      try {
        const isDuplicate = await findSimilarTrace(pool, embedding, DEDUP_SIMILARITY_THRESHOLD);
        if (isDuplicate) {
          dbg(`skip near-duplicate (similarity>${DEDUP_SIMILARITY_THRESHOLD}): "${item.content.slice(0,60)}"`);
          log.info(`Skipped near-duplicate item: "${item.content.slice(0, 80)}"`);
          continue;
        }
      } catch (err) {
        dbg(`findSimilarTrace FAILED (continuing without dedup): ${err}`);
      }
    }

    dbg(`insertSensoryTrace: "${item.content.slice(0,60)}" embLen=${embedding?.length ?? 0}`);
    try {
      const id = await insertSensoryTrace(pool, {
        session_id: ctx.sessionId,
        turn_index: ctx.turnIndex,
        item_type: "extracted",
        memory_type: item.type,
        content: item.content,
        embedding,
        provenance_kind: item.provenance_kind,
        provenance_ref: null,
        utility_prior: item.utility,
        tags: item.tags,
        extractor_ver: FACT_EXTRACTION_V1.version,
        metadata: {},
        episodified_at: null,
        expires_at: computeExpiresAt(item.ephemeral_ttl_hours),
      });
      dbg(`insertSensoryTrace OK: id=${id}`);
      ids.push(id);
    } catch (err) {
      dbg(`insertSensoryTrace CAUGHT ERROR: ${err}`);
      log.error(`Failed to insert sensory trace`, err);
    }
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
  config?: ExtractorConfig & { embeddingApiKey?: string },
): Promise<void> {
  dbg(`runFactExtraction: session=${ctx.sessionId} turn=${ctx.turnIndex} embeddingApiKey=${config?.embeddingApiKey ? "SET" : "MISSING"}`);
  try {
    const result = await extractFacts(client, ctx, config);
    dbg(`extractFacts returned ${result.items.length} items`);
    await persistExtractedItems(pool, ctx, result, config?.embeddingApiKey);
  } catch (err) {
    dbg(`runFactExtraction CAUGHT ERROR: ${err}`);
    log.error(
      `Fact extraction failed for session=${ctx.sessionId} turn=${ctx.turnIndex}`,
      err,
    );
    // Non-blocking: swallow error, extraction is best-effort
  }
}
