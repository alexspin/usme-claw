/**
 * Nightly consolidation job — 5-step pipeline.
 *
 * 1. Cluster sensory traces -> episode summaries (Sonnet)
 * 2. Promote recurring patterns -> concepts (Sonnet)
 * 3. Contradiction resolution + entity updates (Sonnet)
 * 4. Skill candidate drafting (Sonnet/Opus)
 * 5. Decay utility scores + prune expired traces
 *
 * Each step is idempotent — safe to re-run.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type pg from "pg";
import {
  getUnepisodifiedTraces,
  markTracesEpisodified,
  insertEpisode,
  insertConcept,
  deactivateConcept,
} from "../db/queries.js";
import { stepReconcile } from "./reconcile.js";
import { embedText } from "../embed/index.js";
import type { SensoryTrace } from "../schema/types.js";
import { logger } from "../logger.js";
import { countTokens } from "../tokenize.js";
import { DEFAULT_REASONING_MODEL, DEFAULT_FAST_MODEL } from "../config/models.js";

// ── Types ──────────────────────────────────────────────────

export interface NightlyConfig {
  sonnetModel?: string;
  opusModel?: string;
  reconciliationModel?: string;
  tracesPerBatch?: number;
  tracesPerEpisode?: number;
  decayFactor?: number;
  minUtilityScore?: number;
  contradictionCosineThreshold?: number;
  embeddingApiKey?: string;
  maxConceptsPerRun?: number;
}

export interface NightlyResult {
  runId: string;
  episodesCreated: number;
  conceptsPromoted: number;
  conceptsReconciled: number;
  contradictionsResolved: number;
  skillsDrafted: number;
  tracesDecayed: number;
  tracesPruned: number;
  durationMs: number;
}

// ── Logger ─────────────────────────────────────────────────

const log = logger.child({ module: "nightly" });

// ── Schemas ────────────────────────────────────────────────

const ImportanceSchema = z.object({
  importance_score: z.number().min(1).max(10),
});

const ConceptSchema = z.object({
  concept_type: z.enum(["fact", "preference", "decision", "relationship_summary"]),
  content: z.string().max(500),
  confidence: z.number().min(0).max(1),
  provenance_kind: z.literal("model"),
  tags: z.array(z.string()),
});

const PromoteOutputSchema = z.object({
  concepts: z.array(ConceptSchema),
});

const ContradictionOutputSchema = z.object({
  contradicts: z.boolean(),
  resolution: z.enum(["keep_a", "keep_b", "merge"]),
  merged_content: z.string().nullable(),
  reasoning: z.string(),
});

// SkillSchema and SkillDraftOutputSchema removed — stepSkillDraft retired in favour of reflect.ts pipeline.

// ── Helpers ────────────────────────────────────────────────

function extractToolInput(response: Anthropic.Message, toolName: string): unknown {
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === toolName);
  if (!block) throw new Error(`No tool_use block with name "${toolName}" in response`);
  return block.input;
}

function chunkArray<T>(arr: T[], k: number): T[][] {
  const chunkSize = Math.ceil(arr.length / k);
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}

// ── Step 1: Episodify ──────────────────────────────────────

/**
 * Cluster un-episodified sensory traces into episode summaries.
 * Uses session + time proximity clustering (D12).
 * Dynamic k: 1 episode per ~15 traces, minimum 1 (D13).
 */
export async function stepEpisodify(
  client: Anthropic,
  pool: pg.Pool,
  config: NightlyConfig,
): Promise<number> {
  const traces = await getUnepisodifiedTraces(pool, config.tracesPerBatch ?? 500);

  if (traces.length === 0) {
    log.info("Step 1: No un-episodified traces found");
    return 0;
  }

  // Group traces by session
  const bySession = new Map<string, SensoryTrace[]>();
  for (const t of traces) {
    const arr = bySession.get(t.session_id) ?? [];
    arr.push(t);
    bySession.set(t.session_id, arr);
  }

  let episodesCreated = 0;
  const tracesPerEpisode = config.tracesPerEpisode ?? 15;

  for (const [sessionId, sessionTraces] of bySession) {
    // Determine number of clusters
    const k = Math.max(1, Math.round(sessionTraces.length / tracesPerEpisode));

    // Split traces into k roughly equal chunks
    const chunks = chunkArray(sessionTraces, k);

    for (const chunk of chunks) {
      const serialized = chunk
        .map((t) => `[${t.memory_type ?? "unknown"}] ${t.content}`)
        .join("\n");

      const response = await client.messages.create({
        model: config.sonnetModel ?? DEFAULT_REASONING_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `Summarize the following extracted memory items into a single cohesive episode summary. Focus on what happened, decisions made, and key facts learned. Be concise but complete.\n\nItems:\n${serialized}\n\nRespond with only the summary text, no JSON or formatting.`,
          },
        ],
      });

      const summary =
        response.content[0].type === "text" ? response.content[0].text : "";

      const timeBucket = chunk[0].created_at;

      // Assign importance_score via Haiku tool_use call
      let importance_score = 5;
      try {
        const importanceStart = Date.now();
        const importanceResponse = await client.messages.create({
          model: DEFAULT_FAST_MODEL,
          max_tokens: 256,
          tools: [{
            name: "assign_importance",
            description: "Assign an importance score to a memory episode",
            input_schema: {
              type: "object" as const,
              properties: {
                importance_score: {
                  type: "number",
                  description: "Score 1-10: 1=trivial, 10=critical. Consider specificity, actionability, uniqueness, future relevance.",
                },
              },
              required: ["importance_score"],
            },
          }],
          tool_choice: { type: "tool", name: "assign_importance" },
          messages: [
            {
              role: "user",
              content: `Assign an importance score (1-10) to this memory episode:\n\n${summary}`,
            },
          ],
        });
        const importanceResult = ImportanceSchema.safeParse(extractToolInput(importanceResponse, "assign_importance"));
        if (importanceResult.success) {
          importance_score = Math.round(importanceResult.data.importance_score);
        } else {
          log.error({ error: importanceResult.error }, "stepEpisodify: importance schema validation failed");
        }
        const duration = Date.now() - importanceStart;
        log.info({ importance_score, duration }, "episode importance scored");
      } catch (err) {
        log.error({ err }, "stepEpisodify: Haiku importance call failed, defaulting to 5");
        importance_score = 5;
      }

      const episodeId = await insertEpisode(pool, {
        session_ids: [sessionId],
        time_bucket: timeBucket,
        summary,
        embedding: null,
        source_trace_ids: chunk.map((t) => t.id),
        token_count: countTokens(summary),
        utility_score: 0.5,
        importance_score,
        metadata: { clustered_at: new Date().toISOString() },
      });

      if (config.embeddingApiKey) {
        try {
          const vec = await embedText(summary, config.embeddingApiKey);
          await pool.query(
            "UPDATE episodes SET embedding = $1::vector WHERE id = $2",
            [JSON.stringify(vec), episodeId],
          );
          log.info(`embedded episode ${episodeId}`);
        } catch (err) {
          log.error({ err }, `embed episode ${episodeId} failed`);
        }
      }

      await markTracesEpisodified(pool, chunk.map((t) => t.id));
      episodesCreated++;
    }
  }

  log.info(`Step 1: Created ${episodesCreated} episodes from ${traces.length} traces`);
  return episodesCreated;
}

// ── Step 2: Promote to Concepts ────────────────────────────

/**
 * Identify recurring patterns across episodes and promote to stable concepts.
 */
export async function stepPromote(
  client: Anthropic,
  pool: pg.Pool,
  config: NightlyConfig,
): Promise<number> {
  // Find recent episodes not yet analyzed for promotion
  const { rows: episodes } = await pool.query(
    `SELECT id, summary, session_ids, utility_score
     FROM episodes
     WHERE metadata->>'promoted_at' IS NULL
     ORDER BY created_at DESC
     LIMIT 50`,
  );

  if (episodes.length === 0) {
    log.info("Step 2: No episodes to analyze for promotion");
    return 0;
  }

  const serialized = episodes
    .map((e: { id: string; summary: string }, i: number) => `[${i + 1}] ${e.summary}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: config.sonnetModel ?? DEFAULT_REASONING_MODEL,
    max_tokens: 8192,
    tools: [{
      name: "promote_concepts",
      description: "Extract recurring facts, preferences, or decisions worth promoting to long-term concepts.",
      input_schema: {
        type: "object" as const,
        properties: {
          concepts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                concept_type: { type: "string", enum: ["fact", "preference", "decision", "relationship_summary"] },
                content: { type: "string", description: "Concise statement, max 300 chars" },
                confidence: { type: "number" },
                provenance_kind: { type: "string", enum: ["model"] },
                tags: { type: "array", items: { type: "string" } },
              },
              required: ["concept_type", "content", "confidence", "provenance_kind", "tags"],
            },
            maxItems: 10,
          },
        },
        required: ["concepts"],
      },
    }],
    tool_choice: { type: "tool", name: "promote_concepts" },
    messages: [
      {
        role: "user",
        content: `Analyze these episode summaries and extract up to 10 of the most important recurring facts, preferences, or decisions that should be promoted to stable long-term concepts. Keep each "content" field under 200 characters. If no concepts are worth promoting, return an empty array.\n\nEpisodes:\n${serialized}`,
      },
    ],
  });

  const promoteResult = PromoteOutputSchema.safeParse(extractToolInput(response, "promote_concepts"));
  if (!promoteResult.success) {
    log.error({ error: promoteResult.error }, "stepPromote: schema validation failed");
    return 0;
  }
  const { concepts } = promoteResult.data;

  let promoted = 0;
  for (const c of concepts) {
    const conceptId = await insertConcept(pool, {
      concept_type: c.concept_type,
      content: c.content,
      embedding: null,
      utility_score: 0.5,
      provenance_kind: c.provenance_kind,
      provenance_ref: null,
      confidence: c.confidence,
      supersedes_id: null,
      superseded_by: null,
      is_active: true,
      tags: c.tags,
      metadata: { promoted_at: new Date().toISOString() },
    });
    if (config.embeddingApiKey) {
      try {
        const vec = await embedText(c.content, config.embeddingApiKey);
        await pool.query(
          "UPDATE concepts SET embedding = $1::vector WHERE id = $2",
          [JSON.stringify(vec), conceptId],
        );
        log.info(`embedded concept ${conceptId}`);
      } catch (err) {
        log.error({ err }, `embed concept ${conceptId} failed`);
      }
    }
    promoted++;
  }

  // Mark episodes as promoted
  const episodeIds = episodes.map((e: { id: string }) => e.id);
  if (promoted > 0) {
    await pool.query(
      `UPDATE episodes SET metadata = metadata || '{"promoted_at": "${new Date().toISOString()}"}'::jsonb
       WHERE id = ANY($1)`,
      [episodeIds],
    );
  }

  log.info(`Step 2: Promoted ${promoted} concepts from ${episodes.length} episodes`);
  return promoted;
}

// ── Step 3: Contradiction Resolution ───────────────────────

/**
 * Find potentially contradicting concepts (D14: cosine distance < 0.10)
 * and resolve via Sonnet.
 */
export async function stepContradictions(
  client: Anthropic,
  pool: pg.Pool,
  config: NightlyConfig,
): Promise<number> {
  const threshold = config.contradictionCosineThreshold ?? 0.10;

  // Find concept pairs with very similar embeddings (potential contradictions)
  const { rows: candidates } = await pool.query(
    `SELECT a.id AS id_a, a.content AS content_a,
            b.id AS id_b, b.content AS content_b,
            (a.embedding <=> b.embedding) AS distance
     FROM concepts a
     JOIN concepts b ON a.id < b.id
     WHERE a.is_active = true AND b.is_active = true
       AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
       AND (a.embedding <=> b.embedding) < $1
     LIMIT 20`,
    [threshold],
  );

  if (candidates.length === 0) {
    log.info("Step 3: No contradiction candidates found");
    return 0;
  }

  let resolved = 0;

  for (const pair of candidates) {
    const response = await client.messages.create({
      model: config.sonnetModel ?? DEFAULT_REASONING_MODEL,
      max_tokens: 1024,
      tools: [{
        name: "resolve_contradiction",
        description: "Analyze two memory concepts and decide how to resolve any contradiction between them.",
        input_schema: {
          type: "object" as const,
          properties: {
            contradicts: { type: "boolean" },
            resolution: { type: "string", enum: ["keep_a", "keep_b", "merge"] },
            merged_content: { type: ["string", "null"], description: "Merged statement if resolution is merge, otherwise null" },
            reasoning: { type: "string" },
          },
          required: ["contradicts", "resolution", "merged_content", "reasoning"],
        },
      }],
      tool_choice: { type: "tool", name: "resolve_contradiction" },
      messages: [
        {
          role: "user",
          content: `These two memory concepts may contradict each other. Analyze and decide:\n\nConcept A: "${pair.content_a}"\nConcept B: "${pair.content_b}"`,
        },
      ],
    });

    try {
      const contradictionResult = ContradictionOutputSchema.safeParse(extractToolInput(response, "resolve_contradiction"));
      if (!contradictionResult.success) {
        log.error({ error: contradictionResult.error }, "stepContradictions: schema validation failed");
        continue;
      }
      const decision = contradictionResult.data;

      if (!decision.contradicts) continue;

      if (decision.resolution === "keep_a") {
        await deactivateConcept(pool, pair.id_b, pair.id_a);
        resolved++;
      } else if (decision.resolution === "keep_b") {
        await deactivateConcept(pool, pair.id_a, pair.id_b);
        resolved++;
      } else if (decision.resolution === "merge") {
        const mergedContent = decision.merged_content ?? pair.content_a;
        const newId = await insertConcept(pool, {
          concept_type: "fact",
          content: mergedContent,
          embedding: null,
          utility_score: 0.5,
          provenance_kind: "model",
          provenance_ref: null,
          confidence: 1.0,
          supersedes_id: null,
          superseded_by: null,
          is_active: true,
          tags: [],
          metadata: {
            merged_from: [pair.id_a, pair.id_b],
            merged_at: new Date().toISOString(),
          },
        });
        if (config.embeddingApiKey) {
          try {
            const vec = await embedText(mergedContent, config.embeddingApiKey);
            await pool.query(
              "UPDATE concepts SET embedding = $1::vector WHERE id = $2",
              [JSON.stringify(vec), newId],
            );
            log.info(`embedded concept ${newId}`);
          } catch (err) {
            log.error({ err }, `embed concept ${newId} failed`);
          }
        }
        await deactivateConcept(pool, pair.id_a, newId);
        await deactivateConcept(pool, pair.id_b, newId);
        resolved++;
      }

      log.info(
        `Step 3: Resolved contradiction: ${decision.resolution} — ${decision.reasoning}`,
      );
    } catch {
      log.error(`Step 3: Failed to parse contradiction resolution for pair ${pair.id_a}/${pair.id_b}`);
    }
  }

  log.info(`Step 3: Resolved ${resolved} contradictions from ${candidates.length} candidates`);
  return resolved;
}

// ── Step 4: Skill Candidate Drafting (retired) ─────────────

/**
 * Skill drafting from nightly.ts has been retired.
 * All skill candidate production now goes through reflect.ts.
 * This stub preserves the call site in runNightlyConsolidation without breaking anything.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function stepSkillDraft(
  _client: Anthropic,
  _pool: pg.Pool,
  _config: NightlyConfig,
): Promise<number> {
  log.info("Step 4: stepSkillDraft is retired — skill candidates are produced by reflect.ts");
  return 0;
}

// ── Step 5: Decay + Prune ──────────────────────────────────

/**
 * Decay utility scores on episodes/concepts and prune expired sensory traces.
 */
export async function stepDecayAndPrune(
  pool: pg.Pool,
  config: NightlyConfig,
): Promise<{ decayed: number; pruned: number }> {
  const decayFactor = config.decayFactor ?? 0.95;
  const minUtility = config.minUtilityScore ?? 0.01;

  // Decay episode utility scores
  const { rowCount: episodesDecayed } = await pool.query(
    `UPDATE episodes
     SET utility_score = utility_score * $1
     WHERE utility_score > $2`,
    [decayFactor, minUtility],
  );

  // Decay concept utility scores (but not skills — D7: skills don't decay)
  const { rowCount: conceptsDecayed } = await pool.query(
    `UPDATE concepts
     SET utility_score = utility_score * $1, updated_at = now()
     WHERE utility_score > $2 AND is_active = true`,
    [decayFactor, minUtility],
  );

  const totalDecayed = (episodesDecayed ?? 0) + (conceptsDecayed ?? 0);

  // Prune expired sensory traces
  const { rowCount: pruned } = await pool.query(
    `DELETE FROM sensory_trace
     WHERE expires_at IS NOT NULL AND expires_at < now()`,
  );

  // Prune very low utility episodes
  const { rowCount: prunedEpisodes } = await pool.query(
    `DELETE FROM episodes
     WHERE utility_score <= $1 AND access_count = 0`,
    [minUtility],
  );

  const totalPruned = (pruned ?? 0) + (prunedEpisodes ?? 0);

  // Auto-dismiss skill_candidates older than 30 days (still undecided)
  const { rowCount: candidatesDismissed } = await pool.query(
    `UPDATE skill_candidates
     SET dismissed_at = NOW(), updated_at = NOW()
     WHERE dismissed_at IS NULL
       AND created_at < NOW() - INTERVAL '30 days'`,
  );
  if ((candidatesDismissed ?? 0) > 0) {
    log.info(`Step 5: Auto-dismissed ${candidatesDismissed} stale skill_candidates (>30 days old)`);
  }

  log.info(
    `Step 5: Decayed ${totalDecayed} items (factor=${decayFactor}), pruned ${totalPruned} expired/low-utility items`,
  );

  return { decayed: totalDecayed, pruned: totalPruned };
}

// ── Orchestrator ───────────────────────────────────────────

/**
 * Run the full nightly consolidation pipeline.
 * Each step is independent and idempotent.
 */
export async function runNightlyConsolidation(
  client: Anthropic,
  pool: pg.Pool,
  config: NightlyConfig = {},
): Promise<NightlyResult> {
  const start = Date.now();
  const runId = crypto.randomUUID();
  log.info(`Nightly consolidation starting (runId=${runId})`);

  const episodesCreated = await stepEpisodify(client, pool, config);
  const conceptsPromoted = await stepPromote(client, pool, config);
  const conceptsReconciled = await stepReconcile(client, pool, config, runId);
  log.info(`Step 2b: Reconciled ${conceptsReconciled} concepts`);
  const contradictionsResolved = await stepContradictions(client, pool, config);
  const skillsDrafted = await stepSkillDraft(client, pool, config);
  const { decayed, pruned } = await stepDecayAndPrune(pool, config);

  const durationMs = Date.now() - start;

  const result: NightlyResult = {
    runId,
    episodesCreated,
    conceptsPromoted,
    conceptsReconciled,
    contradictionsResolved,
    skillsDrafted,
    tracesDecayed: decayed,
    tracesPruned: pruned,
    durationMs,
  };

  log.info({ result }, "Nightly consolidation complete");
  return result;
}

/**
 * Midday partial consolidation pass: episodify + promote + reconcile only.
 * No decay, no skill drafting.
 */
export async function runPartialConsolidation(
  client: Anthropic,
  pool: pg.Pool,
  config: NightlyConfig = {},
): Promise<{ runId: string; episodesCreated: number; conceptsPromoted: number; conceptsReconciled: number }> {
  const runId = crypto.randomUUID();
  log.info(`Partial consolidation starting (runId=${runId})`);

  const episodesCreated = await stepEpisodify(client, pool, config);
  const conceptsPromoted = await stepPromote(client, pool, config);
  const conceptsReconciled = await stepReconcile(client, pool, config, runId);

  log.info({ runId, episodesCreated, conceptsPromoted, conceptsReconciled }, "Partial consolidation complete");
  return { runId, episodesCreated, conceptsPromoted, conceptsReconciled };
}

