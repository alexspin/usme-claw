/**
 * Graph Builder — batch entity relationship inference.
 *
 * Fetches all entities ordered by relationship count (orphans first),
 * batches them, and asks Claude to infer relationships from recent evidence.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Pool } from "pg";
import { logger } from "../logger.js";
import { GRAPH_BUILDER_CONFIG } from "./reflect-config.js";
import { DEFAULT_REASONING_MODEL } from "../config/models.js";
import { makeSlug, assignSlug } from "./reflect-corpus.js";
import { buildGraphBuilderPrompt } from "./reflect-prompts.js";

const log = logger.child({ module: "graph-builder" });

// ── Types ──────────────────────────────────────────────────

export interface GraphBuilderOptions {
  model?: string;
  dryRun?: boolean;
  triggerSource: string;
}

export interface GraphBuildResult {
  batchesRun: number;
  entitiesProcessed: number;
  relationshipsWritten: number;
  durationMs: number;
}

interface EntityRecord {
  id: string;
  name: string;
  entity_type: string;
  canonical: string | null;
  rel_count: number;
}

interface ProposedRelationship {
  source_slug: string;
  relationship: string;
  target_slug: string;
  confidence: number;
}

// ── Main export ────────────────────────────────────────────

export async function runGraphBuilder(opts: GraphBuilderOptions): Promise<GraphBuildResult> {
  const start = Date.now();
  const model = opts.model ?? DEFAULT_REASONING_MODEL;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set — cannot run graph builder");

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set — cannot run graph builder");

  const pool = new Pool({ connectionString: databaseUrl });
  const client = new Anthropic({ apiKey: anthropicKey });

  log.info({ triggerSource: opts.triggerSource, model, dryRun: opts.dryRun }, "graph builder starting");

  try {
    // ── Fetch all entities (orphans first) ─────────────
    const { rows: entities } = await pool.query<EntityRecord>(
      `SELECT e.id, e.name, e.entity_type, e.canonical,
              COUNT(r.id)::int as rel_count
       FROM entities e
       LEFT JOIN entity_relationships r ON r.source_id = e.id AND r.valid_until IS NULL
       WHERE e.exclude_from_reflection = false
       GROUP BY e.id
       ORDER BY rel_count ASC, e.created_at ASC`,
    );

    // ── Fetch evidence corpus ──────────────────────────
    const { rows: traces } = await pool.query(
      `SELECT id, content, memory_type FROM sensory_trace
       WHERE exclude_from_reflection = false
         AND created_at > NOW() - INTERVAL '48 hours'
       ORDER BY created_at DESC LIMIT 500`,
    );

    const { rows: episodes } = await pool.query(
      `SELECT id, summary FROM episodes
       WHERE exclude_from_reflection = false
       ORDER BY access_count DESC LIMIT 60`,
    );

    const tracesText = traces
      .map((t: { id: string; memory_type: string | null; content: string }) =>
        `[trace:${t.id}] [${t.memory_type ?? 'unknown'}] ${t.content}`)
      .join('\n');

    const episodesText = episodes
      .map((e: { id: string; summary: string }) => `[ep:${e.id}] ${e.summary}`)
      .join('\n');

    // ── Batch entities ─────────────────────────────────
    const batchSize = GRAPH_BUILDER_CONFIG.batchSize;
    const batches: EntityRecord[][] = [];
    for (let i = 0; i < entities.length; i += batchSize) {
      batches.push(entities.slice(i, i + batchSize));
    }

    log.info({ totalEntities: entities.length, batches: batches.length, batchSize }, "entities batched");

    let totalRelationshipsWritten = 0;
    let entitiesProcessed = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      entitiesProcessed += batch.length;

      // Build slug index for this batch
      const entitySlugIndex = new Map<string, string>(); // slug → id
      const slugCounts = new Map<string, number>();

      const batchWithSlugs = batch.map((e) => {
        const slug = assignSlug(e.name, entitySlugIndex, e.id, 'entity', slugCounts);
        return { ...e, slug };
      });

      const prompt = buildGraphBuilderPrompt(
        batchWithSlugs.map((e) => ({ slug: e.slug, name: e.name, entity_type: e.entity_type, rel_count: e.rel_count })),
        tracesText,
        episodesText,
        GRAPH_BUILDER_CONFIG,
      );

      // Call Claude
      let proposed: ProposedRelationship[] = [];
      try {
        const response = await client.messages.create({
          model,
          max_tokens: 4096,
          tools: [{
            name: "graph_output",
            description: "Output relationship graph for the entity batch",
            input_schema: {
              type: "object" as const,
              properties: {
                relationships: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      source_slug: { type: "string" },
                      relationship: {
                        type: "string",
                        enum: [...GRAPH_BUILDER_CONFIG.allowedRelVerbs],
                      },
                      target_slug: { type: "string" },
                      confidence: { type: "number" },
                    },
                    required: ["source_slug", "relationship", "target_slug", "confidence"],
                  },
                },
              },
              required: ["relationships"],
            },
          }],
          tool_choice: { type: "tool", name: "graph_output" },
          messages: [{ role: "user", content: prompt }],
        });

        const block = response.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "graph_output",
        );
        if (block) {
          const input = block.input as { relationships: ProposedRelationship[] };
          proposed = Array.isArray(input.relationships) ? input.relationships : [];
        }
      } catch (err) {
        log.error({ err, batchIdx }, "graph builder LLM call failed — skipping batch");
        continue;
      }

      log.info(
        { batch: `${batchIdx + 1}/${batches.length}`, entitiesInBatch: batch.length, proposedRelationships: proposed.length },
        "batch LLM call complete",
      );

      if (opts.dryRun) {
        log.info({ proposed }, "dry run — skipping writes");
        continue;
      }

      // ── Write relationships ──────────────────────────
      let batchWritten = 0;
      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");

        for (const rel of proposed) {
          // Resolve source
          const sourceId = entitySlugIndex.get(rel.source_slug);
          if (!sourceId) {
            log.warn({ slug: rel.source_slug }, "graph builder: source slug not in batch index — skipping");
            continue;
          }

          // Resolve target: try batch index first, then DB fallback
          let targetId = entitySlugIndex.get(rel.target_slug);
          if (!targetId) {
            const targetName = rel.target_slug.replace(/-/g, ' ');
            const { rows: fallback } = await dbClient.query(
              `SELECT id FROM entities WHERE lower(name) = lower($1) LIMIT 1`,
              [targetName],
            );
            if (fallback.length > 0) {
              targetId = (fallback[0] as { id: string }).id;
            } else {
              log.warn({ slug: rel.target_slug }, "graph builder: target slug not found in index or DB — skipping");
              continue;
            }
          }

          try {
            await dbClient.query(
              `INSERT INTO entity_relationships
                 (source_id, target_id, relationship, confidence, valid_from, metadata)
               VALUES ($1, $2, $3, $4, NOW(), $5)
               ON CONFLICT (source_id, target_id, relationship, valid_until) DO NOTHING`,
              [sourceId, targetId, rel.relationship, rel.confidence, JSON.stringify({ from_graph_builder: true })],
            );
            batchWritten++;
          } catch (writeErr) {
            log.error({ writeErr, rel }, "graph builder: relationship write failed — skipping");
          }
        }

        await dbClient.query("COMMIT");
        totalRelationshipsWritten += batchWritten;
        log.info({ batchIdx: batchIdx + 1, batchWritten }, "graph builder batch written");
      } catch (txErr) {
        await dbClient.query("ROLLBACK");
        log.error({ txErr, batchIdx }, "graph builder batch transaction failed — rolled back");
      } finally {
        dbClient.release();
      }
    }

    const durationMs = Date.now() - start;
    const result: GraphBuildResult = {
      batchesRun: batches.length,
      entitiesProcessed,
      relationshipsWritten: totalRelationshipsWritten,
      durationMs,
    };

    log.info(result, "graph builder complete");
    return result;
  } finally {
    await pool.end();
  }
}
