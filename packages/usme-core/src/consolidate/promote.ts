/**
 * Promote pipeline — skill_candidates review and promotion helpers.
 *
 * Provides functions for querying, formatting, and acting on skill candidates
 * surfaced by the reflect pipeline. Used by both scheduler (morning notify)
 * and the usme-openclaw promote command.
 */

import type pg from "pg";
import { getPool } from "../db/pool.js";
import { logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────

export interface PromoteSkillCandidate {
  id: number;
  name: string;
  description?: string;
  trigger_pattern?: string;
  steps?: unknown;
  source_episode_ids?: string[];
  confidence: number;
  reflection_run_id?: number;
  approval_status: "pending" | "accepted" | "rejected";
  accepted?: boolean;
  accepted_at?: Date;
  rejected_at?: Date;
  created_at: Date;
  updated_at: Date;
  // Columns from migration 014:
  prompted_at?: Date;
  quality_tier: "draft" | "candidate";
  defer_until?: Date;
  dismissed_at?: Date;
  promoted_skill_id?: string; // UUID
  source: "reflect" | "nightly";
}

export interface GetPromoteCandidatesOpts {
  /** Include draft-tier (0.50–0.69 confidence) candidates. Default: false */
  includeDrafts?: boolean;
  /** Ignore prompted_at / dismiss filters. Default: false */
  forceAll?: boolean;
  /** Fetch a specific candidate by id */
  id?: number;
}

// ── Logger ─────────────────────────────────────────────────

const log = logger.child({ module: "promote" });

// ── Grade helper ───────────────────────────────────────────

/**
 * Returns true for grades A, A-, B+ — the threshold for writing skill candidates.
 * The overall_assessment from reflect starts with a letter grade.
 */
export function isPassing(grade: string): boolean {
  const passing = new Set(["A+", "A", "A-", "B+"]);
  return passing.has(grade.trim().toUpperCase());
}

/**
 * Extract grade letter from overall_assessment text.
 * e.g. "B+ — memory health is good..." → "B+"
 */
export function extractGrade(overallAssessment: string): string {
  const m = overallAssessment.match(/\b([A-D][+\-]?)(?=\b|\*|\/|\s|$)/i);
  return m ? m[1] : "";
}

// ── Query ──────────────────────────────────────────────────

export async function getPromoteCandidates(
  opts: GetPromoteCandidatesOpts,
  db?: pg.Pool,
): Promise<PromoteSkillCandidate[]> {
  const pool = db ?? getPool();

  const conditions: string[] = [
    "dismissed_at IS NULL",
    "(defer_until IS NULL OR defer_until < NOW())",
  ];
  const params: unknown[] = [];

  if (!opts.forceAll) {
    conditions.push("prompted_at IS NULL");
  }

  if (!opts.includeDrafts) {
    conditions.push("quality_tier = 'candidate'");
  }

  if (opts.id !== undefined) {
    params.push(opts.id);
    conditions.push(`id = $${params.length}`);
  }

  const where = conditions.join(" AND ");

  // Order: candidate tier first (higher quality), then confidence DESC
  const orderBy = opts.includeDrafts
    ? "CASE quality_tier WHEN 'candidate' THEN 0 ELSE 1 END ASC, confidence DESC"
    : "confidence DESC";

  const { rows } = await pool.query<PromoteSkillCandidate>(
    `SELECT id, name, description, trigger_pattern, steps, source_episode_ids,
            confidence, reflection_run_id, approval_status, accepted, accepted_at,
            rejected_at, created_at, updated_at,
            prompted_at, quality_tier, defer_until, dismissed_at,
            promoted_skill_id, source
     FROM skill_candidates
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT 10`,
    params,
  );

  return rows;
}

// ── Card formatters ────────────────────────────────────────

export function buildPromoteCard(candidates: PromoteSkillCandidate[]): string {
  if (candidates.length === 0) {
    return "No skill candidates ready for review.";
  }

  const lines: string[] = [
    `☀️ ${candidates.length} skill candidate(s) ready for review:`,
  ];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ageDays = Math.floor(
      (Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24),
    );
    const confStr = Number(c.confidence).toFixed(2);
    const descLine = (c.description ?? "").replace(/\n/g, " ").slice(0, 100);
    const episodeCount = c.source_episode_ids?.length ?? 0;
    const tierBadge = c.quality_tier === "draft" ? " [draft]" : "";

    lines.push(
      `[id=${c.id}] ${c.name}${tierBadge} (conf: ${confStr}) — ${descLine}`,
    );
    lines.push(
      `   Source: ${episodeCount} episode(s) · ${ageDays}d old · ${c.quality_tier}`,
    );
  }

  lines.push("");
  lines.push(
    `Run: npx tsx promote-candidate.ts <id>  (use the [id=N] shown above)`,
  );

  return lines.join("\n");
}

export async function getDetailCard(
  candidateId: number,
  db: pg.Pool,
): Promise<string> {
  const { rows } = await db.query<PromoteSkillCandidate>(
    `SELECT id, name, description, trigger_pattern, steps, source_episode_ids,
            confidence, quality_tier, created_at, source
     FROM skill_candidates WHERE id = $1`,
    [candidateId],
  );

  if (rows.length === 0) {
    return `Candidate #${candidateId} not found.`;
  }

  const c = rows[0];
  const ageDays = Math.floor(
    (Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24),
  );
  const episodeIds = c.source_episode_ids ?? [];

  // Fetch episode summaries
  let episodeSummaries = "(none)";
  if (episodeIds.length > 0) {
    const { rows: episodes } = await db.query<{ id: number; summary: string }>(
      `SELECT id, summary FROM episodes WHERE id = ANY($1) ORDER BY id`,
      [episodeIds],
    );
    if (episodes.length > 0) {
      episodeSummaries = episodes
        .map((e) => `  [episode:${e.id}] ${e.summary.slice(0, 200)}`)
        .join("\n");
    }
  }

  const lines = [
    `── Skill Candidate #${c.id} ──`,
    `Name:        ${c.name}`,
    `Quality:     ${c.quality_tier}`,
    `Confidence:  ${Number(c.confidence).toFixed(2)}`,
    `Age:         ${ageDays} days`,
    `Source:      ${c.source}`,
    `Created:     ${new Date(c.created_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT`,
    ``,
    `Description:`,
    c.description ?? "(none)",
    ``,
    `Trigger pattern:`,
    c.trigger_pattern ?? "(none)",
    ``,
    `Source episodes (${episodeIds.length}):`,
    episodeSummaries,
  ];

  return lines.join("\n");
}

// ── Enrichment context ─────────────────────────────────────

export interface EnrichContext {
  candidateId: number;
  name: string;
  description: string;
  triggerPattern: string | null;
  confidence: number;
  qualityTier: string;
  slug: string;
  skillPath: string;
  sourceEpisodes: Array<{ id: string; summary: string; createdAt: string }>;
  relatedConcepts: Array<{ name: string; summary: string }>;
  reflectionRunGrade: string | null;
}

export async function getEnrichContext(
  candidateId: number,
  db?: pg.Pool,
): Promise<EnrichContext> {
  const pool = db ?? getPool();

  // 1. Fetch candidate
  const { rows: [candidate] } = await pool.query(
    "SELECT * FROM skill_candidates WHERE id = $1",
    [candidateId],
  );
  if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

  // 2. Fetch source episodes
  let sourceEpisodes: Array<{ id: string; summary: string; createdAt: string }> = [];
  const episodeIds = candidate.source_episode_ids ?? [];
  if (episodeIds.length) {
    const { rows } = await pool.query(
      `SELECT id, summary, created_at FROM episodes WHERE id = ANY($1::uuid[])`,
      [episodeIds],
    );
    sourceEpisodes = rows.map((r: any) => ({ id: r.id, summary: r.summary?.slice(0, 300), createdAt: r.created_at }));
  }

  // 3. Fetch related concepts
  const { rows: conceptRows } = await pool.query(
    "SELECT concept_type AS name, content AS summary FROM concepts WHERE content ILIKE '%' || $1 || '%' ORDER BY updated_at DESC LIMIT 5",
    [candidate.name],
  );
  const relatedConcepts = conceptRows.map((r: any) => ({ name: r.name, summary: r.summary }));

  // 4. Fetch reflection run grade if available
  let reflectionRunGrade: string | null = null;
  if (candidate.reflection_run_id) {
    const { rows: [run] } = await pool.query(
      "SELECT overall_assessment FROM reflection_runs WHERE id = $1",
      [candidate.reflection_run_id],
    );
    if (run?.overall_assessment) {
      reflectionRunGrade = extractGrade(run.overall_assessment);
    }
  }

  // 5. Compute slug and skillPath
  const slug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const skillPath = `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/${slug}/SKILL.md`;

  return {
    candidateId: candidate.id,
    name: candidate.name,
    description: candidate.description,
    triggerPattern: candidate.trigger_pattern ?? null,
    confidence: candidate.confidence,
    qualityTier: candidate.quality_tier,
    slug,
    skillPath,
    sourceEpisodes,
    relatedConcepts,
    reflectionRunGrade,
  };
}

// ── State mutations ────────────────────────────────────────

export async function markCandidatesPrompted(
  ids: number[],
  db: pg.Pool,
): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE skill_candidates SET prompted_at = NOW(), updated_at = NOW() WHERE id = ANY($1)`,
    [ids],
  );
  log.info({ ids }, "candidates marked prompted");
}

export async function markCandidateDismissed(
  id: number,
  db: pg.Pool,
): Promise<void> {
  await db.query(
    `UPDATE skill_candidates SET dismissed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id],
  );
  log.info({ id }, "candidate dismissed");
}

export async function deferCandidate(
  id: number,
  db: pg.Pool,
): Promise<void> {
  await db.query(
    `UPDATE skill_candidates SET defer_until = NOW() + INTERVAL '24 hours', updated_at = NOW() WHERE id = $1`,
    [id],
  );
  log.info({ id }, "candidate deferred 24h");
}

export async function markCandidatePendingWrite(
  id: number,
  db: pg.Pool,
): Promise<void> {
  await db.query(
    `UPDATE skill_candidates SET approval_status = 'accepted', accepted = true, accepted_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id],
  );
  log.info({ id }, "candidate marked pending_write (accepted)");
}
