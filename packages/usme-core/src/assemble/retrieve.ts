/**
 * Parallel ANN vector search across memory tiers using pgvector HNSW.
 */

import type { Pool } from "pg";
import type { MemoryTier, RetrievalCandidate, AssemblyModeProfile } from "./types.js";

const DEFAULT_TIER_TIMEOUT_MS = 80;
const DEFAULT_TOP_K = 20;

interface RetrieveOptions {
  pool: Pool;
  queryEmbedding: number[];
  tiers: MemoryTier[];
  topK?: number;
  tierTimeoutMs?: number;
}

/**
 * Run parallel ANN queries across enabled memory tiers.
 * Each tier query has an independent timeout (default 80ms).
 * Returns a merged candidate pool from all tiers.
 */
export async function retrieve(opts: RetrieveOptions): Promise<RetrievalCandidate[]> {
  const { pool, queryEmbedding, tiers, topK = DEFAULT_TOP_K, tierTimeoutMs = DEFAULT_TIER_TIMEOUT_MS } = opts;

  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const queries = tiers.map((tier) =>
    withTimeout(queryTier(pool, tier, embeddingStr, topK), tierTimeoutMs)
  );

  const results = await Promise.all(queries);
  return results.flat();
}

async function withTimeout<T>(promise: Promise<T[]>, ms: number): Promise<T[]> {
  return Promise.race([
    promise,
    new Promise<T[]>((resolve) => setTimeout(() => resolve([]), ms)),
  ]);
}

const TIER_QUERIES: Record<MemoryTier, string> = {
  sensory_trace: `
    SELECT id, 'sensory_trace' AS tier, content, embedding,
           length(content) / 4 AS token_count, created_at,
           provenance_kind, utility_prior, 1.0 AS confidence,
           true AS is_active, 0 AS access_count, NULL AS last_accessed,
           NULL AS teachability,
           COALESCE(tags, '{}') AS tags,
           1 - (embedding <=> $1::vector) AS similarity
    FROM sensory_trace
    WHERE embedding IS NOT NULL
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `,
  episodes: `
    SELECT id, 'episodes' AS tier, summary AS content, embedding, token_count,
           created_at, 'user' AS provenance_kind, 'medium' AS utility_prior,
           1.0 AS confidence, true AS is_active, access_count, last_accessed,
           NULL AS teachability,
           1 - (embedding <=> $1::vector) AS similarity
    FROM episodes
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `,
  concepts: `
    SELECT id, 'concepts' AS tier, content, embedding,
           length(content) / 4 AS token_count,
           created_at, provenance_kind, 'medium' AS utility_prior,
           confidence, is_active, access_count, last_accessed,
           NULL AS teachability,
           1 - (embedding <=> $1::vector) AS similarity
    FROM concepts
    WHERE embedding IS NOT NULL AND is_active = true
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `,
  skills: `
    SELECT id, 'skills' AS tier, description AS content, embedding,
           length(description) / 4 AS token_count,
           created_at, 'tool' AS provenance_kind, 'medium' AS utility_prior,
           1.0 AS confidence, (status = 'active') AS is_active,
           use_count AS access_count, last_used AS last_accessed,
           teachability,
           1 - (embedding <=> $1::vector) AS similarity
    FROM skills
    WHERE embedding IS NOT NULL AND status = 'active'
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `,
  entities: `
    SELECT id, 'entities' AS tier, name || ': ' || COALESCE(canonical, '') AS content,
           embedding,
           length(name) / 4 AS token_count,
           created_at, 'model' AS provenance_kind, 'medium' AS utility_prior,
           confidence, true AS is_active, 0 AS access_count,
           NULL AS last_accessed, NULL AS teachability,
           1 - (embedding <=> $1::vector) AS similarity
    FROM entities
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `,
};

async function queryTier(
  pool: Pool,
  tier: MemoryTier,
  embeddingStr: string,
  topK: number,
): Promise<RetrievalCandidate[]> {
  const sql = TIER_QUERIES[tier];
  const { rows } = await pool.query(sql, [embeddingStr, topK]);

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    tier,
    content: r.content as string,
    embedding: parseEmbedding(r.embedding),
    tokenCount: Number(r.token_count) || Math.ceil((r.content as string).length / 4),
    createdAt: new Date(r.created_at as string),
    provenanceKind: r.provenance_kind as string,
    utilityPrior: r.utility_prior as RetrievalCandidate["utilityPrior"],
    confidence: Number(r.confidence),
    isActive: Boolean(r.is_active),
    accessCount: Number(r.access_count),
    lastAccessed: r.last_accessed ? new Date(r.last_accessed as string) : null,
    teachability: r.teachability != null ? Number(r.teachability) : null,
    tags: tier === 'sensory_trace' ? parseTagsArray(r.tags) : [],
  }));
}

function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") return JSON.parse(raw) as number[];
  return [];
}

function parseTagsArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string' && raw.startsWith('{')) {
    // Postgres array literal: {a,b,c}
    return raw.slice(1, -1).split(',').filter(Boolean);
  }
  return [];
}
