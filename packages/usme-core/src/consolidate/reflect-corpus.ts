/**
 * Corpus fetching and slug utilities for the reflection pipeline.
 */

import type { Pool } from "pg";
import { REFLECT_CONFIG } from "./reflect-config.js";

// ── Row types ──────────────────────────────────────────────

export interface ConceptRow {
  id: string;
  concept_type: string;
  content: string;
  utility_score: number;
  confidence: number;
  tags: unknown;
}

export interface EpisodeRow {
  id: string;
  summary: string;
  access_count: number;
  importance_score: number;
  utility_score: number;
  created_at: Date;
}

export interface TraceRow {
  id: string;
  content: string;
  memory_type: string | null;
  created_at: Date;
}

export interface EntityRow {
  id: string;
  name: string;
  entity_type: string;
  canonical: string | null;
  confidence: number;
  relationships: unknown[] | null;
}

// ── Public interfaces ──────────────────────────────────────

export interface ReflectionCorpus {
  concepts: ConceptRow[];
  episodes: EpisodeRow[];
  traces: TraceRow[];
  entities: EntityRow[];
  existingSkills: { name: string }[];
  pendingCandidates: { id: number; name: string; description: string }[];
}

export interface SlugTexts {
  conceptsText: string;
  episodesText: string;
  tracesText: string;
  entitiesText: string;
  indexes: {
    episodeSlugIndex: Map<string, string>;
    conceptSlugIndex: Map<string, string>;
    entitySlugIndex: Map<string, string>;
  };
}

export interface ActiveConstraint {
  id: number;
  pattern: string;
  content: string;
}

// ── Slug helpers ───────────────────────────────────────────

export function makeSlug(text: string, fallback = 'item'): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || fallback;
}

export function assignSlug(
  text: string,
  index: Map<string, string>,
  uuid: string,
  ns: string,
  slugCounts: Map<string, number>,
): string {
  const base = makeSlug(text, ns);
  const key = `${ns}:${base}`;
  const count = (slugCounts.get(key) ?? 0) + 1;
  slugCounts.set(key, count);
  const slug = count > 1 ? `${base}-${count}` : base;
  index.set(slug, uuid);
  return slug;
}

// ── Corpus fetch ───────────────────────────────────────────

export async function fetchCorpus(pool: Pool): Promise<ReflectionCorpus> {
  const { rows: concepts } = await pool.query(
    `SELECT id, concept_type, content, utility_score, confidence, tags
     FROM concepts
     WHERE is_active = true AND exclude_from_reflection = false
     ORDER BY utility_score DESC`,
  );

  const { rows: episodes } = await pool.query(
    `SELECT id, summary, access_count, importance_score, utility_score, created_at
     FROM episodes
     WHERE exclude_from_reflection = false
     ORDER BY (access_count + EXTRACT(EPOCH FROM (NOW() - created_at)) / -86400 + 30) DESC
     LIMIT ${REFLECT_CONFIG.episodeLimit}`,
  );

  const { rows: traces } = await pool.query(
    `SELECT id, content, memory_type, created_at
     FROM sensory_trace
     WHERE exclude_from_reflection = false
       AND created_at > NOW() - INTERVAL '${REFLECT_CONFIG.traceWindowHours} hours'
     ORDER BY created_at DESC
     LIMIT ${REFLECT_CONFIG.traceLimit}`,
  );

  const { rows: entities } = await pool.query(
    `SELECT e.id, e.name, e.entity_type, e.canonical, e.confidence,
            array_agg(json_build_object(
              'target_id', r.target_id,
              'relationship', r.relationship,
              'confidence', r.confidence
            )) FILTER (WHERE r.id IS NOT NULL) AS relationships
     FROM entities e
     LEFT JOIN entity_relationships r ON r.source_id = e.id
       AND (r.valid_until IS NULL OR r.valid_until > NOW())
     WHERE e.exclude_from_reflection = false
     GROUP BY e.id`,
  );

  const { rows: existingSkills } = await pool.query(`SELECT name FROM skills ORDER BY name`);

  const { rows: pendingCandidates } = await pool.query(
    `SELECT id, name, description FROM skill_candidates WHERE dismissed_at IS NULL ORDER BY created_at DESC`,
  );

  return { concepts, episodes, traces, entities, existingSkills, pendingCandidates };
}

// ── Slug index builder ─────────────────────────────────────

export function buildSlugIndexes(corpus: ReflectionCorpus): SlugTexts {
  const episodeSlugIndex = new Map<string, string>();
  const conceptSlugIndex = new Map<string, string>();
  const entitySlugIndex  = new Map<string, string>();
  const slugCounts       = new Map<string, number>();

  const conceptsText = corpus.concepts
    .map((c) => {
      const slug = assignSlug(c.content, conceptSlugIndex, c.id, 'concept', slugCounts);
      return `[concept:${slug}] (${c.concept_type}, util=${c.utility_score.toFixed(2)}, conf=${c.confidence.toFixed(2)}) ${c.content}`;
    })
    .join("\n");

  const episodesText = corpus.episodes
    .map((e) => {
      const slug = assignSlug(e.summary, episodeSlugIndex, e.id, 'episode', slugCounts);
      return `[ep:${slug}] (access=${e.access_count}, importance=${e.importance_score}) ${e.summary}`;
    })
    .join("\n");

  const entitiesText = corpus.entities
    .map((e) => {
      const slug = assignSlug(e.name, entitySlugIndex, e.id, 'entity', slugCounts);
      return `[entity:${slug}] ${e.name} (${e.entity_type}) canonical=${e.canonical ?? 'none'} relationships=${e.relationships?.length ?? 0}`;
    })
    .join("\n");

  const tracesText = corpus.traces
    .map((t) => `[trace:${t.id}] [${t.memory_type ?? 'unknown'}] ${t.content}`)
    .join("\n");

  return {
    conceptsText,
    episodesText,
    tracesText,
    entitiesText,
    indexes: { episodeSlugIndex, conceptSlugIndex, entitySlugIndex },
  };
}

// ── Token estimate ─────────────────────────────────────────

export function estimateTokens(corpus: ReflectionCorpus): { totalTokens: number; mode: 'full' | 'tiered' } {
  const conceptTokens = corpus.concepts.reduce((s, c) => s + Math.ceil(c.content.length / 4), 0);
  const episodeTokens = corpus.episodes.reduce((s, e) => s + Math.ceil(e.summary.length / 4), 0);
  const traceTokens   = corpus.traces.reduce((s, t) => s + Math.ceil(t.content.length / 4), 0);
  const totalTokens   = conceptTokens + episodeTokens + traceTokens;
  const mode          = totalTokens > REFLECT_CONFIG.corpusTokenThreshold ? 'tiered' : 'full';
  return { totalTokens, mode };
}

// ── Active constraints fetch ───────────────────────────────

export async function fetchActiveConstraints(pool: Pool): Promise<ActiveConstraint[]> {
  const { rows } = await pool.query(
    `SELECT id, pattern, content FROM constraints WHERE dismissed_at IS NULL ORDER BY created_at`,
  );
  return rows as ActiveConstraint[];
}
