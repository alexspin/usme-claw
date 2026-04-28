/**
 * Write helpers for the reflection pipeline.
 * All functions accept a savepoint counter { count: number } passed by reference.
 */

import { jsonrepair } from "jsonrepair";
import { logger } from "../logger.js";
import type { z } from "zod";

const log = logger.child({ module: "reflect-writes" });

// ── Slug remap ─────────────────────────────────────────────

export function remapSlug(slug: string, index: Map<string, string>, label: string): string {
  const uuid = index.get(slug.trim());
  if (uuid !== undefined) return uuid;
  log.warn({ slug, label }, "slug not found in index — LLM may have hallucinated this identifier");
  return slug;
}

// ── Array parse recovery ───────────────────────────────────

export function tryParseArray(raw: string): unknown[] | null {
  // Strategy 1: direct parse
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch { /* fall through */ }

  // Strategy 2: jsonrepair
  try {
    const repaired = jsonrepair(raw);
    const v = JSON.parse(repaired);
    if (Array.isArray(v)) return v;
  } catch (e2) {
    log.warn({ parseError: String(e2), sample: raw.slice(0, 500) }, 'strategy 2 (jsonrepair) failed');
  }

  // Strategy 3: bracket-boundary extraction + jsonrepair
  try {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start !== -1 && end > start) {
      const slice = raw.slice(start, end + 1);
      const repaired = jsonrepair(slice);
      const v = JSON.parse(repaired);
      if (Array.isArray(v)) return v;
    }
  } catch (e3) {
    log.warn({ parseError: String(e3), sample: raw.slice(0, 500) }, 'strategy 3 (jsonrepair+bracket) failed');
  }

  return null;
}

const ARRAY_FIELDS = ["concept_updates", "new_skills", "contradictions", "entity_updates"] as const;

export function normalizeArrayFields(rawOutput: Record<string, unknown>): void {
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(rawOutput[field])) {
      if (typeof rawOutput[field] === 'string') {
        const rawStr = rawOutput[field] as string;
        const recovered = tryParseArray(rawStr);
        if (recovered !== null) {
          log.info({ field, count: recovered.length }, "recovered double-encoded array field");
          rawOutput[field] = recovered;
        } else {
          log.warn(
            { field, rawValue: rawStr.slice(0, 300) },
            "all parse strategies failed on string field — coercing to [] (data lost)",
          );
          rawOutput[field] = [];
        }
      } else if (rawOutput[field] == null) {
        log.warn({ field }, "field is null/undefined — coercing to []");
        rawOutput[field] = [];
      } else {
        log.warn({ field, got: typeof rawOutput[field] }, "field is unexpected type — coercing to []");
        rawOutput[field] = [];
      }
    }
  }
}

// ── Savepoint counter type ─────────────────────────────────

export interface SpCounter { count: number }

// ── Concept updates ────────────────────────────────────────

export async function writeConceptUpdates(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  updates: Array<{ concept_id: string; action: string; importance_delta?: number; merge_target_id?: string; reason: string }>,
  conceptSlugIndex: Map<string, string>,
  sp: SpCounter,
): Promise<number> {
  let count = 0;
  for (const update of updates) {
    const spName = `sp_${sp.count++}`;
    await client.query(`SAVEPOINT ${spName}`);
    try {
      if (update.action === 'deprecate') {
        await client.query(
          `UPDATE concepts SET is_active = false, updated_at = NOW() WHERE id = $1`,
          [update.concept_id],
        );
        count++;
      } else if (update.action === 'merge' && update.merge_target_id) {
        await client.query(
          `UPDATE concepts SET is_active = false, superseded_by = $2, updated_at = NOW() WHERE id = $1`,
          [update.concept_id, update.merge_target_id],
        );
        count++;
      } else if (update.action === 'raise' || update.action === 'lower') {
        const delta = update.importance_delta ?? (update.action === 'raise' ? 0.1 : -0.1);
        await client.query(
          `UPDATE concepts
           SET utility_score = GREATEST(0, LEAST(1.0, utility_score + $2)), updated_at = NOW()
           WHERE id = $1`,
          [update.concept_id, delta],
        );
        count++;
      }
      await client.query(`RELEASE SAVEPOINT ${spName}`);
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
      log.error({ err, update }, "concept update failed — skipping");
    }
  }
  return count;
}

// ── Candidate dismissals ───────────────────────────────────

export async function writeCandidateDismissals(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  dismissals: Array<{ candidate_id: number; reason: string }>,
  sp: SpCounter,
): Promise<number> {
  if (dismissals.length === 0) return 0;
  const spName = `sp_${sp.count++}`;
  await client.query(`SAVEPOINT ${spName}`);
  let count = 0;
  try {
    for (const d of dismissals) {
      await client.query(
        `UPDATE skill_candidates SET dismissed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [d.candidate_id],
      );
      count++;
    }
    await client.query(`RELEASE SAVEPOINT ${spName}`);
    log.info(`Dismissed ${count} candidates`);
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
    log.error({ err }, 'Failed to process candidate_dismissals');
    count = 0;
  }
  return count;
}

// ── Skill candidates ───────────────────────────────────────

export async function writeSkillCandidates(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  skills: Array<{ name: string; description: string; trigger_pattern?: string; steps?: unknown; confidence: number; source_episode_ids?: string[] }>,
  episodeSlugIndex: Map<string, string>,
  runId: number,
  qualityPasses: boolean,
  sp: SpCounter,
): Promise<number> {
  if (!qualityPasses) return 0;
  let created = 0;
  for (const skill of skills) {
    if (skill.confidence < 0.5) {
      log.info({ name: skill.name, confidence: skill.confidence }, "skill skipped — confidence below 0.5");
      continue;
    }
    const qualityTier = skill.confidence >= 0.7 ? 'candidate' : 'draft';

    const trgmCheck = await client.query(
      `SELECT id, name FROM skill_candidates WHERE dismissed_at IS NULL AND similarity(name, $1) > 0.5 ORDER BY similarity(name, $1) DESC LIMIT 1`,
      [skill.name],
    );
    if ((trgmCheck.rows as unknown[]).length > 0) {
      log.info(`Skipping '${skill.name}' — too similar to existing candidate (trgm guard)`);
      continue;
    }

    const spName = `sp_${sp.count++}`;
    await client.query(`SAVEPOINT ${spName}`);
    try {
      const mappedEpisodeIds = (() => {
        if (!skill.source_episode_ids) return null;
        const mapped: string[] = [];
        const missed: string[] = [];
        for (const s of skill.source_episode_ids) {
          const uuid = episodeSlugIndex.get(String(s).trim());
          if (uuid !== undefined) {
            mapped.push(uuid);
          } else {
            missed.push(String(s).trim());
          }
        }
        log.warn(
          { skillName: skill.name, slugsMapped: mapped.length, slugsMissed: missed.length, missedSlugs: missed },
          missed.length > 0 ? "skill episode remap: LLM invented slugs" : "skill episode remap: all slugs matched",
        );
        return mapped.length > 0 ? mapped : null;
      })();

      await client.query(
        `INSERT INTO skill_candidates
           (name, description, trigger_pattern, steps, source_episode_ids,
            confidence, reflection_run_id, quality_tier, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reflect')
         ON CONFLICT (name) DO NOTHING`,
        [
          skill.name,
          skill.description,
          skill.trigger_pattern ?? null,
          skill.steps ? JSON.stringify(skill.steps) : null,
          mappedEpisodeIds,
          skill.confidence,
          runId,
          qualityTier,
        ],
      );
      created++;
      await client.query(`RELEASE SAVEPOINT ${spName}`);
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
      log.error({ err, skill }, "skill_candidate insert failed — skipping");
    }
  }
  return created;
}

// ── Contradictions ─────────────────────────────────────────

export async function writeContradictions(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  contradictions: Array<{ winner_concept_id: string; loser_concept_id: string; reason: string }>,
  conceptIdSet: Set<string>,
  sp: SpCounter,
): Promise<number> {
  let count = 0;
  for (const contradiction of contradictions) {
    if (!conceptIdSet.has(contradiction.winner_concept_id) || !conceptIdSet.has(contradiction.loser_concept_id)) {
      log.warn({ contradiction }, "contradiction skipped — winner or loser UUID not found in fetched concepts");
      continue;
    }
    const spName = `sp_${sp.count++}`;
    await client.query(`SAVEPOINT ${spName}`);
    try {
      await client.query(
        `UPDATE concepts SET is_active = false, superseded_by = $2, updated_at = NOW() WHERE id = $1`,
        [contradiction.loser_concept_id, contradiction.winner_concept_id],
      );
      count++;
      await client.query(`RELEASE SAVEPOINT ${spName}`);
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
      log.error({ err, contradiction }, "contradiction resolution failed — skipping");
    }
  }
  return count;
}

// ── Entity updates ─────────────────────────────────────────

export async function writeEntityUpdates(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  updates: Array<{ entity_id: string; action: string; details: unknown }>,
  entitySlugIndex: Map<string, string>,
  sp: SpCounter,
  runId?: number,
): Promise<number> {
  let count = 0;
  for (const update of updates) {
    const spName = `sp_${sp.count++}`;
    await client.query(`SAVEPOINT ${spName}`);
    try {
      const details = update.details as Record<string, unknown>;
      if (update.action === 'add_relationship') {
        const relVerb = ((details.relationship ?? 'related') as string).toLowerCase();
        await client.query(
          `INSERT INTO entity_relationships
             (source_id, target_id, relationship, confidence, valid_from, metadata)
           VALUES ($1, $2, $3, $4, NOW(), $5)
           ON CONFLICT (source_id, target_id, relationship, valid_until) DO NOTHING`,
          [
            update.entity_id,
            details.target_entity_id ?? details.target_id ?? update.entity_id,
            relVerb,
            details.confidence ?? 0.8,
            JSON.stringify({ from_reflection: runId ?? null }),
          ],
        );
        count++;
      } else if (update.action === 'remove_relationship') {
        await client.query(
          `UPDATE entity_relationships SET valid_until = NOW()
           WHERE source_id = $1 AND target_id = $2 AND valid_until IS NULL`,
          [update.entity_id, details.target_entity_id ?? details.target_id ?? update.entity_id],
        );
        count++;
      } else if (update.action === 'reclassify') {
        await client.query(
          `UPDATE entities SET entity_type = $2, updated_at = NOW() WHERE id = $1`,
          [update.entity_id, details.new_type ?? 'concept'],
        );
        count++;
      }
      await client.query(`RELEASE SAVEPOINT ${spName}`);
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
      log.error({ err, update }, "entity update failed — skipping");
    }
  }
  return count;
}

// ── Constraints ────────────────────────────────────────────

export async function writeConstraints(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  constraints: Array<{ pattern: string; content: string }>,
  sp: SpCounter,
  existingConstraints?: Array<{ content: string }>,
): Promise<void> {
  if (constraints.length === 0) return;
  const spName = `sp_${sp.count++}`;
  await client.query(`SAVEPOINT ${spName}`);
  try {
    let written = 0;
    for (const c of constraints) {
      // pg_trgm dedup guard: skip if any existing constraint is too similar
      const dupCheck = await client.query(
        `SELECT content FROM constraints WHERE dismissed_at IS NULL AND similarity(content, $1) > 0.7 LIMIT 1`,
        [c.content],
      );
      if ((dupCheck.rows as unknown[]).length > 0) {
        log.info({ content: c.content.slice(0, 80) }, "constraint skipped — too similar to existing (trgm dedup)");
        continue;
      }
      await client.query(
        `INSERT INTO constraints (pattern, content) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [c.pattern, c.content],
      );
      written++;
    }
    await client.query(`RELEASE SAVEPOINT ${spName}`);
    log.info({ count: written }, "constraints written");
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
    log.error({ err }, "constraints write failed — skipping");
  }
}
