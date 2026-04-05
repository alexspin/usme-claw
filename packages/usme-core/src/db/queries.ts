import type pg from "pg";
import { appendFileSync, mkdirSync } from "node:fs";
import type {
  SensoryTrace,
  Episode,
  Concept,
  Skill,
  Entity,
  EntityRelationship,
  ShadowComparison,
} from "../schema/types.js";

function dbg(msg: string) {
  try { mkdirSync("/tmp/usme-debug", { recursive: true }); appendFileSync("/tmp/usme-debug/queries.log", `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

/** Format a number[] embedding as pgvector literal, or null. */
function vecLiteral(embedding: number[] | null | undefined): string | null {
  return embedding ? `[${embedding.join(",")}]` : null;
}

// ── Sensory Traces ──────────────────────────────────────────

export async function insertSensoryTrace(
  pool: pg.Pool,
  trace: Omit<SensoryTrace, "id" | "created_at">,
): Promise<string> {
  const vec = vecLiteral(trace.embedding);
  dbg(`insertSensoryTrace: session=${trace.session_id} turn=${trace.turn_index} hasEmbedding=${!!vec} vecLen=${trace.embedding?.length ?? 0}`);
  try {
    const { rows } = await pool.query(
      `INSERT INTO sensory_trace
         (session_id, turn_index, item_type, memory_type, content, embedding,
          provenance_kind, provenance_ref, utility_prior, tags, extractor_ver,
          metadata, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        trace.session_id, trace.turn_index, trace.item_type, trace.memory_type,
        trace.content, vec, trace.provenance_kind, trace.provenance_ref,
        trace.utility_prior, trace.tags, trace.extractor_ver, trace.metadata,
        trace.expires_at,
      ],
    );
    dbg(`insertSensoryTrace: OK id=${rows[0].id}`);
    return rows[0].id;
  } catch (err) {
    dbg(`insertSensoryTrace: CAUGHT ERROR: ${err}`);
    throw err;
  }
}

export async function getUnepisodifiedTraces(
  pool: pg.Pool,
  limit = 500,
): Promise<SensoryTrace[]> {
  const { rows } = await pool.query(
    `SELECT * FROM sensory_trace
     WHERE episodified_at IS NULL AND item_type = 'extracted'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function markTracesEpisodified(
  pool: pg.Pool,
  ids: string[],
): Promise<void> {
  await pool.query(
    `UPDATE sensory_trace SET episodified_at = now() WHERE id = ANY($1)`,
    [ids],
  );
}

// ── Episodes ────────────────────────────────────────────────

export async function insertEpisode(
  pool: pg.Pool,
  episode: Omit<Episode, "id" | "created_at" | "access_count" | "last_accessed">,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO episodes
       (session_ids, time_bucket, summary, embedding, source_trace_ids,
        token_count, utility_score, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      episode.session_ids, episode.time_bucket, episode.summary,
      vecLiteral(episode.embedding), episode.source_trace_ids, episode.token_count,
      episode.utility_score, episode.metadata,
    ],
  );
  return rows[0].id;
}

// ── Concepts ────────────────────────────────────────────────

export async function insertConcept(
  pool: pg.Pool,
  concept: Omit<Concept, "id" | "created_at" | "updated_at" | "access_count" | "last_accessed">,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO concepts
       (concept_type, content, embedding, utility_score, provenance_kind,
        provenance_ref, confidence, supersedes_id, superseded_by, is_active,
        tags, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      concept.concept_type, concept.content, vecLiteral(concept.embedding),
      concept.utility_score, concept.provenance_kind, concept.provenance_ref,
      concept.confidence, concept.supersedes_id, concept.superseded_by,
      concept.is_active, concept.tags, concept.metadata,
    ],
  );
  return rows[0].id;
}

export async function deactivateConcept(
  pool: pg.Pool,
  id: string,
  supersededBy: string,
): Promise<void> {
  await pool.query(
    `UPDATE concepts SET is_active = false, superseded_by = $2, updated_at = now() WHERE id = $1`,
    [id, supersededBy],
  );
}

// ── Skills ──────────────────────────────────────────────────

export async function insertSkill(
  pool: pg.Pool,
  skill: Omit<Skill, "id" | "created_at" | "updated_at" | "use_count" | "last_used">,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO skills
       (name, description, embedding, status, skill_path,
        source_episode_ids, teachability, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      skill.name, skill.description, vecLiteral(skill.embedding), skill.status,
      skill.skill_path, skill.source_episode_ids, skill.teachability,
      skill.metadata,
    ],
  );
  return rows[0].id;
}

// ── Entities ────────────────────────────────────────────────

export async function insertEntity(
  pool: pg.Pool,
  entity: Omit<Entity, "id" | "created_at" | "updated_at">,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO entities (name, entity_type, canonical, embedding, confidence, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id`,
    [entity.name, entity.entity_type, entity.canonical, vecLiteral(entity.embedding), entity.confidence, entity.metadata],
  );
  return rows[0].id;
}

export async function insertEntityRelationship(
  pool: pg.Pool,
  rel: Omit<EntityRelationship, "id" | "created_at">,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO entity_relationships
       (source_id, target_id, relationship, confidence, source_item_id,
        valid_from, valid_until, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      rel.source_id, rel.target_id, rel.relationship, rel.confidence,
      rel.source_item_id, rel.valid_from, rel.valid_until, rel.metadata,
    ],
  );
  return rows[0].id;
}

// ── Shadow Comparisons ──────────────────────────────────────

export async function insertShadowComparison(
  pool: pg.Pool,
  cmp: Omit<ShadowComparison, "id" | "created_at">,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO shadow_comparisons
       (session_id, turn_index, query_preview,
        lcm_token_count, lcm_latency_ms,
        usme_token_count, usme_latency_ms, usme_mode,
        usme_tiers_contributed, usme_items_selected, usme_items_considered,
        usme_system_addition_tokens,
        token_delta, overlap_score, usme_only_preview, lcm_only_preview,
        usme_relevance_score, usme_memory_cited, relevance_analysis_done)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id`,
    [
      cmp.session_id, cmp.turn_index, cmp.query_preview,
      cmp.lcm_token_count, cmp.lcm_latency_ms != null ? Math.round(cmp.lcm_latency_ms) : null,
      cmp.usme_token_count, cmp.usme_latency_ms != null ? Math.round(cmp.usme_latency_ms) : null, cmp.usme_mode,
      cmp.usme_tiers_contributed, cmp.usme_items_selected, cmp.usme_items_considered,
      cmp.usme_system_addition_tokens,
      cmp.token_delta, cmp.overlap_score, cmp.usme_only_preview, cmp.lcm_only_preview,
      cmp.usme_relevance_score, cmp.usme_memory_cited, cmp.relevance_analysis_done,
    ],
  );
  return rows[0].id;
}

// ── ANN Search ──────────────────────────────────────────────

export async function searchByEmbedding(
  pool: pg.Pool,
  table: "sensory_trace" | "episodes" | "concepts" | "skills" | "entities",
  embedding: number[],
  topK = 20,
): Promise<Array<{ id: string; distance: number }>> {
  const vectorLiteral = `[${embedding.join(",")}]`;
  const { rows } = await pool.query(
    `SELECT id, embedding <=> $1::vector AS distance
     FROM ${table}
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral, topK],
  );
  return rows;
}
