/**
 * Memory Reflection Service — thin orchestrator.
 *
 * Assembles the full memory corpus, sends to Claude Sonnet via tool_use,
 * and applies structured updates across all memory tiers in a single transaction.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { getPool } from "../db/pool.js";
import { logger } from "../logger.js";
import { isPassing, extractGrade } from "./promote.js";
import { DEFAULT_REASONING_MODEL } from "../config/models.js";

import { fetchCorpus, buildSlugIndexes, estimateTokens, fetchActiveConstraints } from "./reflect-corpus.js";
import { buildMainPrompt, buildReflectionToolSchema } from "./reflect-prompts.js";
import {
  remapSlug,
  normalizeArrayFields,
  writeConceptUpdates,
  writeCandidateDismissals,
  writeSkillCandidates,
  writeContradictions,
  writeEntityUpdates,
  writeConstraints,
} from "./reflect-writes.js";

// ── Types ──────────────────────────────────────────────────

export interface ReflectionOptions {
  model?: string;
  dryRun?: boolean;
  verbose?: boolean;
  tier?: 'all' | 'concepts' | 'episodes';
  triggerSource: string;
}

export interface ReflectionResult {
  runId: number;
  changes: {
    conceptsUpdated: number;
    skillsCreated: number;
    contradictionsResolved: number;
    entitiesUpdated: number;
    episodesPromoted: number;
  };
  overallAssessment: string;
  durationMs: number;
  /** Number of skill_candidates rows written in this run (0 if grade too low). */
  candidatesCreated: number;
  /** Number of skill_candidates dismissed as near-duplicates in this run. */
  dismissalsProcessed: number;
}

// ── Logger ─────────────────────────────────────────────────

const log = logger.child({ module: "reflect" });

// ── Time helpers ───────────────────────────────────────────

/**
 * Returns true if the current time is between 06:00 and 22:00 Pacific.
 */
function isDayTimeInPacific(): boolean {
  const now = new Date();
  const hourStr = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    hour12: false,
  });
  const hour = parseInt(hourStr, 10);
  return hour >= 6 && hour < 22;
}

// ── Zod Schemas ────────────────────────────────────────────

const ConceptUpdateSchema = z.object({
  concept_id: z.string(),
  action: z.enum(['raise', 'lower', 'deprecate', 'merge']),
  importance_delta: z.number().optional(),
  merge_target_id: z.string().optional(),
  reason: z.string(),
});

const NewSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  trigger_pattern: z.string().optional(),
  steps: z.unknown().optional(),
  confidence: z.number().min(0).max(1),
  source_episode_ids: z.array(z.string()).optional(),
});

const ContradictionSchema = z.object({
  winner_concept_id: z.string(),
  loser_concept_id: z.string(),
  reason: z.string(),
});

const EntityUpdateSchema = z.object({
  entity_id: z.string(),
  action: z.enum(['add_relationship', 'remove_relationship', 'reclassify']),
  details: z.unknown().default({}),
});

const ConstraintSchema = z.object({
  pattern: z.enum(["NEVER", "STOP_DO", "PREFER", "WARN"]),
  content: z.string(),
});

const ReflectionOutputSchema = z.object({
  concept_updates: z.array(ConceptUpdateSchema),
  new_skills: z.array(NewSkillSchema),
  contradictions: z.array(ContradictionSchema),
  entity_updates: z.array(EntityUpdateSchema),
  new_constraints: z.array(ConstraintSchema).default([]),
  overall_assessment: z.string(),
  candidate_dismissals: z.array(z.object({
    candidate_id: z.number(),
    reason: z.string(),
  })).default([]),
});

// ── Helpers ────────────────────────────────────────────────

function extractToolInput(response: Anthropic.Message, toolName: string): unknown {
  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === toolName,
  );
  if (!block) throw new Error(`No tool_use block with name "${toolName}" in response`);
  return block.input;
}

// ── Main export ────────────────────────────────────────────

export async function runReflection(opts: ReflectionOptions): Promise<ReflectionResult> {
  const start = Date.now();
  const model = opts.model ?? DEFAULT_REASONING_MODEL;
  const pool = getPool();

  log.info({ triggerSource: opts.triggerSource, model, dryRun: opts.dryRun }, "reflection starting");

  // ── Phase 1: Fetch corpus ──────────────────────────────
  const fetchStart = Date.now();
  const corpus = await fetchCorpus(pool);
  const slugTexts = buildSlugIndexes(corpus);
  const activeConstraints = await fetchActiveConstraints(pool);
  const { episodeSlugIndex, conceptSlugIndex, entitySlugIndex } = slugTexts.indexes;

  const { totalTokens, mode } = estimateTokens(corpus);
  const fetchDurationMs = Date.now() - fetchStart;

  log.info(
    { concepts: corpus.concepts.length, episodes: corpus.episodes.length, traces: corpus.traces.length, entities: corpus.entities.length, existingSkills: corpus.existingSkills.length, pendingCandidates: corpus.pendingCandidates.length, durationMs: fetchDurationMs },
    "reflection corpus fetched",
  );
  log.info({ totalTokens, mode }, "reflection corpus token estimate");
  log.debug(
    { conceptSlugs: conceptSlugIndex.size, episodeSlugs: episodeSlugIndex.size, entitySlugs: entitySlugIndex.size },
    "slug indexes built",
  );

  if (mode === 'tiered') {
    log.warn("corpus exceeds 350K threshold — tiered mode not yet implemented, proceeding with full corpus");
  }

  // ── Phase 2: Build prompt + call LLM ──────────────────
  const prompt = buildMainPrompt(corpus, slugTexts, activeConstraints);
  const tools = buildReflectionToolSchema();

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set — cannot run reflection");

  const client = new Anthropic({ apiKey: anthropicKey });
  const llmStart = Date.now();

  log.debug(
    { promptLength: prompt.length, episodesText: slugTexts.episodesText, episodeSlugs: episodeSlugIndex.size, conceptSlugs: conceptSlugIndex.size, entitySlugs: entitySlugIndex.size },
    "reflect llm input",
  );

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    tools: tools as Parameters<typeof client.messages.create>[0]['tools'],
    tool_choice: { type: "tool", name: "reflection_output" },
    messages: [{ role: "user", content: prompt }],
  });

  const llmDurationMs = Date.now() - llmStart;
  const inputTokens = response.usage?.input_tokens;
  const outputTokens = response.usage?.output_tokens;

  log.info({ model, inputTokens, outputTokens, durationMs: llmDurationMs }, "reflection llm_call complete");

  // ── Phase 3: Normalize + parse ─────────────────────────
  const rawOutput = extractToolInput(response, "reflection_output") as Record<string, unknown>;

  log.debug({ rawNewSkills: rawOutput.new_skills }, "reflect llm raw new_skills (before remap)");

  try {
    mkdirSync("/tmp/debug", { recursive: true });
    writeFileSync(
      `/tmp/debug/reflect-${Date.now()}.json`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        episodesText: slugTexts.episodesText,
        episodeSlugIndex: Object.fromEntries(episodeSlugIndex),
        conceptSlugIndex: Object.fromEntries(conceptSlugIndex),
        entitySlugIndex: Object.fromEntries(entitySlugIndex),
        rawNewSkills: rawOutput.new_skills,
      }, null, 2),
    );
  } catch (e) {
    log.warn({ err: String(e) }, "debug dump write failed");
  }

  normalizeArrayFields(rawOutput);

  const parseResult = ReflectionOutputSchema.safeParse(rawOutput);
  if (!parseResult.success) {
    throw new Error(`Reflection schema validation failed: ${JSON.stringify(parseResult.error)}`);
  }

  const output = parseResult.data;

  // ── Slug → UUID remapping ───────────────────────────────
  for (const u of output.concept_updates) {
    u.concept_id = remapSlug(u.concept_id, conceptSlugIndex, 'concept_id');
    if (u.merge_target_id !== undefined) {
      u.merge_target_id = remapSlug(u.merge_target_id, conceptSlugIndex, 'merge_target_id');
    }
  }
  for (const c of output.contradictions) {
    c.winner_concept_id = remapSlug(c.winner_concept_id, conceptSlugIndex, 'winner_concept_id');
    c.loser_concept_id  = remapSlug(c.loser_concept_id,  conceptSlugIndex, 'loser_concept_id');
  }
  for (const u of output.entity_updates) {
    u.entity_id = remapSlug(u.entity_id, entitySlugIndex, 'entity_id');
    const det = u.details as Record<string, unknown>;
    if (typeof det.target_entity_id === 'string') {
      det.target_entity_id = remapSlug(det.target_entity_id, entitySlugIndex, 'details.target_entity_id');
    }
    if (typeof det.target_id === 'string') {
      det.target_id = remapSlug(det.target_id, entitySlugIndex, 'details.target_id');
    }
  }

  log.info({
    conceptUpdates: output.concept_updates.length,
    newSkills: output.new_skills.length,
    contradictions: output.contradictions.length,
    entityUpdates: output.entity_updates.length,
  }, "reflection output parsed");

  // ── Quality gate ────────────────────────────────────────
  const grade = extractGrade(output.overall_assessment);
  const qualityPasses = grade !== "" && isPassing(grade);
  if (!qualityPasses) {
    log.warn(
      { grade: grade || "(unparseable)", assessment: output.overall_assessment.slice(0, 80) },
      "Skipping skill candidate writes — quality grade below threshold (or unparseable)",
    );
  }

  if (opts.dryRun) {
    log.info("dry run — skipping all DB writes");
    return {
      runId: -1,
      changes: {
        conceptsUpdated: output.concept_updates.length,
        skillsCreated: output.new_skills.length,
        contradictionsResolved: output.contradictions.length,
        entitiesUpdated: output.entity_updates.length,
        episodesPromoted: 0,
      },
      overallAssessment: output.overall_assessment,
      durationMs: Date.now() - start,
      candidatesCreated: 0,
      dismissalsProcessed: 0,
    };
  }

  // ── Phase 4: Write to DB in a transaction ──────────────
  const pgPool = getPool();
  const dbClient = await pgPool.connect();
  let runId = -1;
  let candidatesCreated = 0;
  let dismissalsProcessed = 0;

  const changes = {
    conceptsUpdated: 0,
    skillsCreated: 0,
    contradictionsResolved: 0,
    entitiesUpdated: 0,
    episodesPromoted: 0,
  };

  const conceptIdSet = new Set<string>(corpus.concepts.map((c) => c.id));

  try {
    await dbClient.query("BEGIN");

    const { rows: runRows } = await dbClient.query(
      `INSERT INTO reflection_runs
         (trigger_source, model, input_tokens, output_tokens, status)
       VALUES ($1, $2, $3, $4, 'running')
       RETURNING id`,
      [opts.triggerSource, model, inputTokens ?? null, outputTokens ?? null],
    );
    runId = runRows[0].id as number;

    const sp = { count: 0 };

    changes.conceptsUpdated = await writeConceptUpdates(dbClient, output.concept_updates, conceptSlugIndex, sp);
    dismissalsProcessed = await writeCandidateDismissals(dbClient, output.candidate_dismissals ?? [], sp);
    candidatesCreated = await writeSkillCandidates(dbClient, output.new_skills, episodeSlugIndex, runId, qualityPasses, sp);
    changes.skillsCreated = candidatesCreated;
    changes.contradictionsResolved = await writeContradictions(dbClient, output.contradictions, conceptIdSet, sp);
    changes.entitiesUpdated = await writeEntityUpdates(dbClient, output.entity_updates as Array<{ entity_id: string; action: string; details: unknown }>, entitySlugIndex, sp, runId);
    await writeConstraints(dbClient, output.new_constraints ?? [], sp);

    // ── Post-run notification flag ────────────────────────
    let pendingMorningNotify = false;
    if (candidatesCreated > 0) {
      if (isDayTimeInPacific()) {
        log.info({ candidatesCreated, runId }, "daytime — caller will deliver candidates-ready notification");
      } else {
        pendingMorningNotify = true;
        log.info({ candidatesCreated, runId }, "nighttime — setting pending_morning_notify=TRUE for morning cron");
      }
    }

    const durationMs = Date.now() - start;
    await dbClient.query(
      `UPDATE reflection_runs
       SET status = 'completed',
           duration_ms = $2,
           concepts_updated = $3,
           skills_created = $4,
           contradictions_resolved = $5,
           entities_updated = $6,
           episodes_promoted = $7,
           overall_assessment = $8,
           pending_morning_notify = $9
       WHERE id = $1`,
      [
        runId,
        durationMs,
        changes.conceptsUpdated,
        changes.skillsCreated,
        changes.contradictionsResolved,
        changes.entitiesUpdated,
        changes.episodesPromoted,
        output.overall_assessment,
        pendingMorningNotify,
      ],
    );

    await dbClient.query("COMMIT");

    log.info({ runId, changes, candidatesCreated, durationMs }, "reflection complete");

    return {
      runId,
      changes,
      overallAssessment: output.overall_assessment,
      durationMs,
      candidatesCreated,
      dismissalsProcessed,
    };
  } catch (err) {
    await dbClient.query("ROLLBACK");
    log.error({ err, runId }, "reflection transaction failed — rolled back");

    if (runId > 0) {
      try {
        await pgPool.query(
          `UPDATE reflection_runs SET status = 'failed', rolled_back = true WHERE id = $1`,
          [runId],
        );
      } catch (updateErr) {
        log.error({ updateErr }, "failed to update reflection_run status to failed");
      }
    }

    throw err;
  } finally {
    dbClient.release();
  }
}
