import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import { ENTITY_EXTRACTION_V1 } from "./prompts/entity-extraction-v1.js";
import {
  insertEntity,
  insertEntityRelationship,
  searchByEmbedding,
} from "../db/queries.js";
import { embedBatch } from "../embed/index.js";

// ── Types ──────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: "person" | "org" | "project" | "tool" | "location" | "concept";
  canonical: string;
}

export interface ExtractedRelationship {
  source: string; // canonical name
  target: string; // canonical name
  relationship:
    | "works_at"
    | "knows"
    | "manages"
    | "is_a"
    | "owns"
    | "uses"
    | "part_of"
    | "related_to";
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

export interface EntityExtractorConfig {
  model?: string;
  maxTokens?: number;
  cosineDedupeThreshold?: number;
  embeddingApiKey?: string;
}

// ── Logger ─────────────────────────────────────────────────

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`[usme:entity-extract] ${msg}`, data ?? ""),
  error: (msg: string, err?: unknown) =>
    console.error(`[usme:entity-extract] ERROR ${msg}`, err ?? ""),
};

// ── Core Extraction ────────────────────────────────────────

function buildPrompt(serializedTurn: string): string {
  return ENTITY_EXTRACTION_V1.template
    .replace("{date}", new Date().toISOString().split("T")[0])
    .replace("{serialized_turn}", serializedTurn);
}

export async function extractEntities(
  client: Anthropic,
  serializedTurn: string,
  config?: EntityExtractorConfig,
): Promise<EntityExtractionResult> {
  const prompt = buildPrompt(serializedTurn);

  const response = await client.messages.create({
    model: config?.model ?? "claude-haiku-4-20250414",
    max_tokens: config?.maxTokens ?? 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const parsed = JSON.parse(text) as EntityExtractionResult;

  if (!Array.isArray(parsed.entities)) {
    throw new Error("Entity extraction returned invalid structure: missing entities array");
  }

  return parsed;
}

// ── Deduplication ──────────────────────────────────────────

/**
 * Check if an entity with the same canonical name already exists.
 * If an embedding is available, also check cosine similarity >= threshold (D10: 0.90).
 * Returns the existing entity ID if a duplicate is found, null otherwise.
 */
async function findDuplicate(
  pool: pg.Pool,
  entity: ExtractedEntity,
  embedding: number[] | null,
  threshold: number,
): Promise<string | null> {
  // Step 1: Check canonical name match (precondition per D10)
  const { rows } = await pool.query(
    `SELECT id, embedding FROM entities WHERE canonical = $1 LIMIT 1`,
    [entity.canonical],
  );

  if (rows.length === 0) return null;

  // Step 2: If we have embeddings, verify cosine similarity >= threshold
  if (embedding && rows[0].embedding) {
    const similar = await searchByEmbedding(pool, "entities", embedding, 1);
    if (similar.length > 0 && similar[0].id === rows[0].id) {
      const cosineSimilarity = 1 - similar[0].distance;
      if (cosineSimilarity >= threshold) {
        return rows[0].id;
      }
    }
  }

  // Canonical name match is sufficient as precondition
  return rows[0].id;
}

// ── Persist to DB ──────────────────────────────────────────

export async function persistEntities(
  pool: pg.Pool,
  result: EntityExtractionResult,
  config?: EntityExtractorConfig,
): Promise<{ insertedEntities: number; skippedDuplicates: number; insertedRelationships: number }> {
  const threshold = config?.cosineDedupeThreshold ?? 0.9;
  const entityIdByCanonical = new Map<string, string>();
  let insertedEntities = 0;
  let skippedDuplicates = 0;

  // Batch embed all entity canonicals at once
  const entityEmbeddings: (number[] | null)[] = result.entities.map(() => null);
  if (config?.embeddingApiKey && result.entities.length > 0) {
    try {
      const canonicals = result.entities.map(e => e.canonical);
      const batchResult = await embedBatch(canonicals, config.embeddingApiKey);
      for (let i = 0; i < batchResult.length; i++) {
        entityEmbeddings[i] = batchResult[i];
      }
    } catch (err) {
      log.error(`Failed to batch embed entities`, err);
    }
  }

  // Deduplicate and insert entities
  for (let i = 0; i < result.entities.length; i++) {
    const entity = result.entities[i];
    const embedding = entityEmbeddings[i];

    const existingId = await findDuplicate(pool, entity, embedding, threshold);

    if (existingId) {
      entityIdByCanonical.set(entity.canonical, existingId);
      skippedDuplicates++;
      log.info(`Skipped duplicate entity: "${entity.name}" (canonical: "${entity.canonical}")`);
      continue;
    }

    const id = await insertEntity(pool, {
      name: entity.name,
      entity_type: entity.type,
      canonical: entity.canonical,
      embedding,
      confidence: 1.0,
      metadata: {},
    });

    entityIdByCanonical.set(entity.canonical, id);
    insertedEntities++;
  }

  // Insert relationships
  let insertedRelationships = 0;
  for (const rel of result.relationships) {
    const sourceId = entityIdByCanonical.get(rel.source);
    const targetId = entityIdByCanonical.get(rel.target);

    if (!sourceId || !targetId) {
      log.info(
        `Skipping relationship "${rel.source}" -> "${rel.target}": missing entity ID`,
      );
      continue;
    }

    await insertEntityRelationship(pool, {
      source_id: sourceId,
      target_id: targetId,
      relationship: rel.relationship,
      confidence: 1.0,
      source_item_id: null,
      valid_from: new Date(),
      valid_until: null,
      metadata: {},
    });

    insertedRelationships++;
  }

  log.info(
    `Entities: ${insertedEntities} inserted, ${skippedDuplicates} deduped. Relationships: ${insertedRelationships} inserted.`,
  );

  return { insertedEntities, skippedDuplicates, insertedRelationships };
}

// ── Fire-and-Forget Entry Point ────────────────────────────

export async function runEntityExtraction(
  client: Anthropic,
  pool: pg.Pool,
  serializedTurn: string,
  config?: EntityExtractorConfig,
): Promise<void> {
  try {
    const result = await extractEntities(client, serializedTurn, config);
    await persistEntities(pool, result, config);
  } catch (err) {
    log.error("Entity extraction failed", err);
    // Non-blocking: swallow error, extraction is best-effort
  }
}
