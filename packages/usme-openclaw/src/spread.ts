/**
 * Spreading activation: entity graph second pass after ANN retrieve().
 * Finds episodes connected through entity relationships.
 */

import type { Pool } from "pg";
import type { RetrievalCandidate } from "@usme/core";

export interface SpreadingConfig {
  maxDepth: number;       // 0 = no-op, 2 = default
  maxAdditional: number;  // cap on new items added (suggest 10)
}

export interface SpreadingMetrics {
  initialCount: number;
  entitiesMatched: number;
  connectedEntities: number;
  episodesAdded: number;
  spreadDepth: number;
  durationMs: number;
}

export async function spreadingActivation(
  candidates: RetrievalCandidate[],
  pool: Pool,
  config: SpreadingConfig,
): Promise<{ candidates: RetrievalCandidate[]; metrics: SpreadingMetrics }> {
  const start = Date.now();
  const initialCount = candidates.length;

  if (config.maxDepth === 0) {
    return {
      candidates,
      metrics: {
        initialCount,
        entitiesMatched: 0,
        connectedEntities: 0,
        episodesAdded: 0,
        spreadDepth: 0,
        durationMs: 0,
      },
    };
  }

  // Extract all text from candidate items
  const allText = candidates.map((c) => c.content).join(" ").toLowerCase();

  // Query all entities
  const { rows: entities } = await pool.query(
    `SELECT id, canonical, name FROM entities WHERE canonical IS NOT NULL`,
  );

  // Find which entity canonicals appear in candidate text
  const matchedEntityIds: string[] = [];
  for (const entity of entities as Array<{ id: string; canonical: string; name: string }>) {
    const searchStr = (entity.canonical || entity.name).toLowerCase();
    if (searchStr && allText.includes(searchStr)) {
      matchedEntityIds.push(entity.id);
    }
  }

  const entitiesMatched = matchedEntityIds.length;

  if (entitiesMatched === 0) {
    return {
      candidates,
      metrics: {
        initialCount,
        entitiesMatched: 0,
        connectedEntities: 0,
        episodesAdded: 0,
        spreadDepth: 0,
        durationMs: Date.now() - start,
      },
    };
  }

  // Walk entity_relationships up to maxDepth hops
  let currentIds = matchedEntityIds;
  const allEntityIds = new Set<string>(matchedEntityIds);
  let reachedDepth = 0;

  for (let depth = 0; depth < config.maxDepth; depth++) {
    if (currentIds.length === 0) break;

    const { rows: related } = await pool.query(
      `SELECT target_id AS related_id FROM entity_relationships
       WHERE source_id = ANY($1::uuid[]) AND (valid_until IS NULL OR valid_until > NOW())
       UNION
       SELECT source_id AS related_id FROM entity_relationships
       WHERE target_id = ANY($1::uuid[]) AND (valid_until IS NULL OR valid_until > NOW())`,
      [currentIds],
    );

    const newIds: string[] = [];
    for (const row of related as Array<{ related_id: string }>) {
      if (!allEntityIds.has(row.related_id)) {
        allEntityIds.add(row.related_id);
        newIds.push(row.related_id);
      }
    }

    currentIds = newIds;
    reachedDepth = depth + 1;
  }

  const connectedEntities = allEntityIds.size;

  // Get canonical names of all matched entities for ILIKE search
  const { rows: entityNames } = await pool.query(
    `SELECT canonical, name FROM entities WHERE id = ANY($1::uuid[]) AND (canonical IS NOT NULL OR name IS NOT NULL)`,
    [Array.from(allEntityIds)],
  );

  if (entityNames.length === 0) {
    return {
      candidates,
      metrics: {
        initialCount,
        entitiesMatched,
        connectedEntities,
        episodesAdded: 0,
        spreadDepth: reachedDepth,
        durationMs: Date.now() - start,
      },
    };
  }

  // Build ILIKE patterns for episode search
  const patterns = (entityNames as Array<{ canonical: string | null; name: string }>)
    .map((e) => `%${(e.canonical || e.name).replace(/[%_]/g, '\\$&')}%`);

  const existingIds = candidates.map((c) => c.id);

  // Find episodes referencing those entities
  const { rows: newEpisodes } = await pool.query(
    `SELECT e.id, e.summary AS content, e.importance_score, e.utility_score,
            e.access_count, e.created_at, e.embedding
     FROM episodes e
     WHERE e.summary ILIKE ANY($1::text[])
       AND e.id != ALL($2::uuid[])
     LIMIT $3`,
    [patterns, existingIds.length > 0 ? existingIds : ['00000000-0000-0000-0000-000000000000'], config.maxAdditional],
  );

  // Convert to RetrievalCandidate objects
  const newCandidates: RetrievalCandidate[] = (newEpisodes as Array<{
    id: string;
    content: string;
    importance_score: number;
    utility_score: number;
    access_count: number;
    created_at: Date;
    embedding: unknown;
  }>).map((e) => ({
    id: e.id,
    tier: 'episodes' as const,
    content: e.content,
    embedding: parseEmbedding(e.embedding),
    tokenCount: Math.ceil(e.content.length / 4),
    createdAt: new Date(e.created_at),
    provenanceKind: 'user',
    utilityPrior: 'medium' as const,
    confidence: 1.0,
    isActive: true,
    accessCount: e.access_count,
    lastAccessed: null,
    teachability: null,
    tags: [],
    similarity: 0.3, // base score for spreading activation results
  }));

  const combined = [...candidates, ...newCandidates];

  return {
    candidates: combined,
    metrics: {
      initialCount,
      entitiesMatched,
      connectedEntities,
      episodesAdded: newCandidates.length,
      spreadDepth: reachedDepth,
      durationMs: Date.now() - start,
    },
  };
}

function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as number[]; } catch { return []; }
  }
  return [];
}
