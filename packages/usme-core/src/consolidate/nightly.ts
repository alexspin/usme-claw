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
import type pg from "pg";
import {
  getUnepisodifiedTraces,
  markTracesEpisodified,
  insertEpisode,
  insertConcept,
  deactivateConcept,
  insertSkill,
} from "../db/queries.js";
import { stepReconcile } from "./reconcile.js";
import { embedText } from "../embed/index.js";
import type { SensoryTrace } from "../schema/types.js";

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

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`[usme:consolidation] ${msg}`, data ?? ""),
  error: (msg: string, err?: unknown) =>
    console.error(`[usme:consolidation] ERROR ${msg}`, err ?? ""),
};

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
        model: config.sonnetModel ?? "claude-sonnet-4-5",
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

      const episodeId = await insertEpisode(pool, {
        session_ids: [sessionId],
        time_bucket: timeBucket,
        summary,
        embedding: null,
        source_trace_ids: chunk.map((t) => t.id),
        token_count: Math.ceil(summary.length / 4),
        utility_score: 0.5,
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
          log.error(`embed episode ${episodeId} failed`, err);
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
    model: config.sonnetModel ?? "claude-sonnet-4-5",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `Analyze these episode summaries and extract any recurring facts, preferences, or decisions that should be promoted to stable long-term concepts.\n\nEpisodes:\n${serialized}\n\nRespond with valid JSON:\n{\n  "concepts": [\n    {\n      "concept_type": "fact|preference|decision|relationship_summary",\n      "content": "concise statement",\n      "confidence": 0.0-1.0,\n      "provenance_kind": "model",\n      "tags": ["tag1"]\n    }\n  ]\n}\n\nIf no concepts are worth promoting, return: { "concepts": [] }`,
      },
    ],
  });

  const text = stripJsonFences(
    response.content[0].type === "text" ? response.content[0].text : "{}"
  );

  let concepts: Array<{
    concept_type: string;
    content: string;
    confidence: number;
    provenance_kind: string;
    tags: string[];
  }> = [];

  try {
    const parsed = JSON.parse(stripJsonFences(text));
    concepts = parsed.concepts ?? [];
  } catch {
    log.error("Step 2: Failed to parse concept promotion response");
    return 0;
  }

  let promoted = 0;
  for (const c of concepts) {
    const conceptId = await insertConcept(pool, {
      concept_type: c.concept_type as "fact" | "preference" | "decision" | "relationship_summary",
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
        log.error(`embed concept ${conceptId} failed`, err);
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
  } else {
    console.log('[stepPromote] skipping markEpisodesPromoted — no concepts extracted from batch');
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
      model: config.sonnetModel ?? "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `These two memory concepts may contradict each other. Analyze and decide:\n\nConcept A: "${pair.content_a}"\nConcept B: "${pair.content_b}"\n\nRespond with valid JSON:\n{\n  "contradicts": true/false,\n  "resolution": "keep_a" | "keep_b" | "merge",\n  "merged_content": "merged statement if resolution is merge, otherwise null",\n  "reasoning": "brief explanation"\n}`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "{}";

    try {
      const decision = JSON.parse(text);

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
            log.error(`embed concept ${newId} failed`, err);
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

// ── Step 4: Skill Candidate Drafting ───────────────────────

/**
 * Identify recurring action patterns in episodes and draft skill candidates.
 */
export async function stepSkillDraft(
  client: Anthropic,
  pool: pg.Pool,
  config: NightlyConfig,
): Promise<number> {
  // Find recent episodes with high utility that haven't been skill-checked
  const { rows: episodes } = await pool.query(
    `SELECT id, summary, session_ids
     FROM episodes
     WHERE utility_score >= 0.6
       AND metadata->>'skill_checked_at' IS NULL
     ORDER BY created_at DESC
     LIMIT 30`,
  );

  if (episodes.length === 0) {
    log.info("Step 4: No episodes eligible for skill drafting");
    return 0;
  }

  const serialized = episodes
    .map((e: { id: string; summary: string }, i: number) => `[${i + 1}] ${e.summary}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: config.opusModel ?? config.sonnetModel ?? "claude-sonnet-4-5",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `Analyze these episode summaries and identify any repeatable workflows, procedures, or techniques that could be extracted as reusable "skills" (templates for future tasks).\n\nEpisodes:\n${serialized}\n\nFor each skill candidate, provide:\n- A concise name\n- A description of the procedure\n- How teachable it is (0.0 to 1.0, where 1.0 means easily replicable)\n\nRespond with valid JSON:\n{\n  "skills": [\n    {\n      "name": "skill-name",\n      "description": "what the skill does and how",\n      "teachability": 0.8\n    }\n  ]\n}\n\nIf no skills are worth drafting, return: { "skills": [] }`,
      },
    ],
  });

  const text = stripJsonFences(
    response.content[0].type === "text" ? response.content[0].text : "{}"
  );

  let skills: Array<{ name: string; description: string; teachability: number }> = [];

  try {
    const parsed = JSON.parse(stripJsonFences(text));
    skills = parsed.skills ?? [];
  } catch {
    log.error("Step 4: Failed to parse skill drafting response");
    return 0;
  }

  let drafted = 0;
  for (const s of skills) {
    const skillId = await insertSkill(pool, {
      name: s.name,
      description: s.description,
      embedding: null,
      status: "candidate",
      skill_path: `skills/${s.name.replace(/\s+/g, "-").toLowerCase()}.md`,
      source_episode_ids: episodes.map((e: { id: string }) => e.id),
      teachability: s.teachability,
      metadata: { drafted_at: new Date().toISOString() },
    });
    if (config.embeddingApiKey) {
      try {
        const vec = await embedText(s.description, config.embeddingApiKey);
        await pool.query(
          "UPDATE skills SET embedding = $1::vector WHERE id = $2",
          [JSON.stringify(vec), skillId],
        );
        log.info(`embedded skill ${skillId}`);
      } catch (err) {
        log.error(`embed skill ${skillId} failed`, err);
      }
    }
    drafted++;
  }

  // Mark episodes as skill-checked
  const episodeIds = episodes.map((e: { id: string }) => e.id);
  await pool.query(
    `UPDATE episodes SET metadata = metadata || '{"skill_checked_at": "${new Date().toISOString()}"}'::jsonb
     WHERE id = ANY($1)`,
    [episodeIds],
  );

  log.info(`Step 4: Drafted ${drafted} skill candidates from ${episodes.length} episodes`);
  return drafted;
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

  log.info("Nightly consolidation complete", result);
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

  log.info(`Partial consolidation complete`, { runId, episodesCreated, conceptsPromoted, conceptsReconciled });
  return { runId, episodesCreated, conceptsPromoted, conceptsReconciled };
}

// ── Helpers ────────────────────────────────────────────────

function stripJsonFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function chunkArray<T>(arr: T[], k: number): T[][] {
  const chunkSize = Math.ceil(arr.length / k);
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}
