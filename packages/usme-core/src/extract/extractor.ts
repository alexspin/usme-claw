import OpenAI from "openai";
import { z } from "zod";
import type pg from "pg";
import { FACT_EXTRACTION_V1 } from "./prompts/fact-extraction-v1.js";
import { insertSensoryTrace, findSimilarTrace, findSimilarTraces } from "../db/queries.js";
import { embedBatch } from "../embed/index.js";
import { logger } from "../logger.js";
import { callOpenAITool } from "../llm/openai-tool.js";
import { DEFAULT_FAST_MODEL } from "../config/models.js";

export const DEDUP_SIMILARITY_THRESHOLD = 0.95;

// ── Types ──────────────────────────────────────────────────

export interface ExtractedItem {
  type: "fact" | "preference" | "decision" | "plan" | "anomaly" | "ephemeral" | "insight";
  content: string;
  utility: "high" | "medium" | "low" | "discard";
  provenance_kind: "user" | "tool" | "model";
  tags: string[];
  ephemeral_ttl_hours: number | null;
}

const FactItemSchema = z.object({
  content: z.string(),
  fact_type: z.string(),
  utility: z.enum(["high", "medium", "low", "discard"]),
  confidence: z.number().min(0).max(1),
  provenance_kind: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const FactExtractionResultSchema = z.object({
  items: z.array(FactItemSchema),
});

export type FactExtractionResult = z.infer<typeof FactExtractionResultSchema>;

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

const log = logger.child({ module: "extractor" });

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
  client: OpenAI,
  ctx: ExtractionContext,
  config?: ExtractorConfig,
): Promise<FactExtractionResult> {
  const prompt = buildPrompt(ctx.serializedTurn);

  let output: unknown;
  try {
    ({ output } = await callOpenAITool({
      client,
      model: config?.model ?? DEFAULT_FAST_MODEL,
      maxTokens: config?.maxTokens ?? 2048,
      tool: {
        name: "extract_facts",
        description: "Extract factual items from the conversation turn",
        input_schema: {
          type: "object" as const,
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  fact_type: { type: "string" },
                  utility: { type: "string", enum: ["high", "medium", "low", "discard"] },
                  confidence: { type: "number" },
                  provenance_kind: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                },
                required: ["content", "fact_type", "utility", "confidence"],
              },
            },
          },
          required: ["items"],
        },
      },
      prompt,
    }));
  } catch (err) {
    log.warn({ err }, "no usable tool call in extraction response");
    return { items: [] };
  }

  const parsed = FactExtractionResultSchema.safeParse(output);
  if (!parsed.success) {
    log.error({ error: parsed.error }, "extraction schema validation failed");
    return { items: [] };
  }
  return parsed.data;
}

// ── Persist to DB ──────────────────────────────────────────

export async function persistExtractedItems(
  pool: pg.Pool,
  ctx: ExtractionContext,
  result: FactExtractionResult,
  embeddingApiKey?: string,
): Promise<string[]> {
  const ids: string[] = [];

  // Filter out discards first
  const keepItems = result.items.filter(item => item.utility !== "discard");

  // Batch embed all non-discard items at once
  const embeddings: (number[] | null)[] = keepItems.map(() => null);
  if (embeddingApiKey && keepItems.length > 0) {
    log.debug({ count: keepItems.length }, "batch embedding items");
    try {
      const contents = keepItems.map(item => item.content);
      const batchResult = await embedBatch(contents, embeddingApiKey);
      for (let i = 0; i < batchResult.length; i++) {
        embeddings[i] = batchResult[i];
      }
    } catch (err) {
      log.error({ err }, "Failed to batch embed items, storing without embeddings");
    }
  }

  // Batch near-duplicate check — one query instead of N
  let dupResults: boolean[] = new Array(keepItems.length).fill(false);
  try {
    dupResults = await findSimilarTraces(pool, embeddings, DEDUP_SIMILARITY_THRESHOLD);
  } catch (err) {
    log.debug({ err }, "findSimilarTraces batch check failed (continuing without dedup)");
  }

  for (let i = 0; i < keepItems.length; i++) {
    const item = keepItems[i];
    const embedding = embeddings[i];

    // Near-duplicate suppression
    if (dupResults[i]) {
      log.info(`Skipped near-duplicate item: "${item.content.slice(0, 80)}"`);
      continue;
    }

    try {
      const id = await insertSensoryTrace(pool, {
        session_id: ctx.sessionId,
        turn_index: ctx.turnIndex,
        item_type: "extracted",
        memory_type: item.fact_type as ExtractedItem["type"],
        content: item.content,
        embedding,
        provenance_kind: (item.provenance_kind ?? "model") as ExtractedItem["provenance_kind"],
        provenance_ref: null,
        utility_prior: item.utility,
        tags: item.tags ?? [],
        extractor_ver: FACT_EXTRACTION_V1.version,
        metadata: {},
        episodified_at: null,
        expires_at: computeExpiresAt(null),
      });
      ids.push(id);
    } catch (err) {
      log.error({ err }, "Failed to insert sensory trace");
    }
  }

  log.info(
    `Persisted ${ids.length}/${result.items.length} items for session=${ctx.sessionId} turn=${ctx.turnIndex}`,
  );

  return ids;
}

// ── Fire-and-Forget Entry Point ────────────────────────────

export async function runFactExtraction(
  client: OpenAI,
  pool: pg.Pool,
  ctx: ExtractionContext,
  config?: ExtractorConfig & { embeddingApiKey?: string },
): Promise<void> {
  try {
    const result = await extractFacts(client, ctx, config);
    await persistExtractedItems(pool, ctx, result, config?.embeddingApiKey);
  } catch (err) {
    log.error(
      { err },
      `Fact extraction failed for session=${ctx.sessionId} turn=${ctx.turnIndex}`,
    );
    // Non-blocking: swallow error, extraction is best-effort
  }
}
