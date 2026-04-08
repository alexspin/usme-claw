import type pg from "pg";
import type {
  SensoryTrace,
  Episode,
  Concept,
  Skill,
  Entity,
  EntityRelationship,
  ShadowComparison,
} from "../schema/types.js";

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
    return rows[0].id;
  } catch (err) {
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
): Promise<string | null> {
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
     ON CONFLICT (session_id, turn_index) DO NOTHING
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
  // Returns null when ON CONFLICT DO NOTHING skips the insert (duplicate turn)
  return rows[0]?.id ?? null;
}

// ── Access Count Tracking ────────────────────────────────────

/**
 * Increment access counts for memory items that were selected and injected.
 * Grouped by tier for efficiency. Skips sensory_trace and entities (no access tracking).
 */
export async function bumpAccessCounts(
  pool: pg.Pool,
  items: import("../assemble/types.js").InjectedMemory[],
): Promise<void> {
  if (items.length === 0) return;

  // Group ids by tier
  const episodeIds = items.filter(i => i.tier === "episodes").map(i => i.id);
  const conceptIds = items.filter(i => i.tier === "concepts").map(i => i.id);
  const skillIds   = items.filter(i => i.tier === "skills").map(i => i.id);

  const ops: Promise<unknown>[] = [];

  if (episodeIds.length > 0) {
    ops.push(pool.query(
      `UPDATE episodes SET access_count = access_count + 1, last_accessed = NOW() WHERE id = ANY($1::uuid[])`,
      [episodeIds],
    ));
  }
  if (conceptIds.length > 0) {
    ops.push(pool.query(
      `UPDATE concepts SET access_count = access_count + 1, last_accessed = NOW() WHERE id = ANY($1::uuid[])`,
      [conceptIds],
    ));
  }
  if (skillIds.length > 0) {
    ops.push(pool.query(
      `UPDATE skills SET use_count = use_count + 1, last_used = NOW() WHERE id = ANY($1::uuid[])`,
      [skillIds],
    ));
  }

  await Promise.all(ops);
}

// ── Near-Duplicate Detection ────────────────────────────────

export async function findSimilarTrace(
  pool: pg.Pool,
  embedding: number[],
  threshold: number
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM sensory_trace
     WHERE embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) > $2
     LIMIT 1`,
    [JSON.stringify(embedding), threshold]
  );
  return result.rows.length > 0;
}

// ── Reconciliation ──────────────────────────────────────────

export async function getUnreconciledConcepts(pool: pg.Pool): Promise<Concept[]> {
  const { rows } = await pool.query(
    `SELECT * FROM concepts
     WHERE is_active = true AND metadata->>'reconciled_at' IS NULL
     ORDER BY created_at ASC`,
  );
  return rows;
}

export async function findReconciliationCandidates(
  pool: pg.Pool,
  conceptId: string,
  embedding: number[] | null,
  tags: string[],
): Promise<Concept[]> {
  const seen = new Set<string>();
  const results: Concept[] = [];

  // ANN search if embedding available
  if (embedding) {
    const vec = vecLiteral(embedding);
    const { rows } = await pool.query(
      `SELECT * FROM concepts
       WHERE embedding IS NOT NULL AND id != $1 AND is_active = true
       ORDER BY embedding <=> $2::vector
       LIMIT 10`,
      [conceptId, vec],
    );
    for (const row of rows) {
      seen.add(row.id);
      results.push(row);
    }
  }

  // Tag overlap search
  if (tags.length > 0) {
    const { rows } = await pool.query(
      `SELECT * FROM concepts
       WHERE tags && $1 AND id != $2 AND is_active = true
       LIMIT 5`,
      [tags, conceptId],
    );
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push(row);
      }
    }
  }

  return results.slice(0, 10);
}

export async function markConceptReconciled(pool: pg.Pool, conceptId: string): Promise<void> {
  await pool.query(
    `UPDATE concepts SET metadata = metadata || jsonb_build_object('reconciled_at', now()::text) WHERE id = $1`,
    [conceptId],
  );
}

export async function updateConceptContent(pool: pg.Pool, conceptId: string, newContent: string): Promise<void> {
  await pool.query(
    `UPDATE concepts SET content = $2, updated_at = now() WHERE id = $1`,
    [conceptId, newContent],
  );
}

export async function updateConceptEmbedding(pool: pg.Pool, id: string, embedding: number[]): Promise<void> {
  await pool.query('UPDATE concepts SET embedding = $2 WHERE id = $1', [id, JSON.stringify(embedding)]);
}

export async function insertAuditEntry(
  pool: pg.Pool,
  entry: {
    run_id: string;
    operation: string;
    concept_type?: string;
    new_concept_id?: string;
    target_id?: string;
    merged_id?: string;
    before_content?: string;
    after_content?: string;
    reasoning?: string;
    confidence?: number;
    temporal_note?: string;
    model_used?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memory_audit_log
       (run_id, operation, concept_type, new_concept_id, target_id, merged_id,
        before_content, after_content, reasoning, confidence, temporal_note, model_used)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      entry.run_id, entry.operation, entry.concept_type ?? null,
      entry.new_concept_id ?? null, entry.target_id ?? null, entry.merged_id ?? null,
      entry.before_content ?? null, entry.after_content ?? null,
      entry.reasoning ?? null, entry.confidence ?? null,
      entry.temporal_note ?? null, entry.model_used ?? null,
    ],
  );
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
