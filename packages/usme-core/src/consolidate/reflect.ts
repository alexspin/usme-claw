/**
 * Memory Reflection Service.
 *
 * Assembles the full memory corpus, sends to Claude Sonnet via tool_use,
 * and applies structured updates across all memory tiers in a single transaction.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import { mkdirSync, writeFileSync } from "node:fs";
import { getPool } from "../db/pool.js";
import { logger } from "../logger.js";
import { isPassing, extractGrade } from "./promote.js";
import { DEFAULT_REASONING_MODEL } from "../config/models.js";

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
 * Used to decide whether to deliver skill candidate notifications immediately
 * or defer them to the morning cron.
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
  // Slugs are short kebab-case strings like "fix-postgres-savepoint". We store them as-is
  // and remap to UUIDs via episodeSlugIndex after the Zod parse.
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
  details: z.unknown(),
});

const ReflectionOutputSchema = z.object({
  concept_updates: z.array(ConceptUpdateSchema),
  new_skills: z.array(NewSkillSchema),
  contradictions: z.array(ContradictionSchema),
  entity_updates: z.array(EntityUpdateSchema),
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
     LIMIT 60`,
  );

  const { rows: traces } = await pool.query(
    `SELECT id, content, memory_type, created_at
     FROM sensory_trace
     WHERE exclude_from_reflection = false
       AND created_at > NOW() - INTERVAL '48 hours'
     ORDER BY created_at DESC
     LIMIT 500`,
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
  const existingSkillNames = existingSkills.length > 0
    ? existingSkills.map((r: { name: string }) => `"${r.name}"`).join(', ')
    : '(none yet)';

  const candidatesResult = await pool.query(
    `SELECT id, name, description FROM skill_candidates WHERE dismissed_at IS NULL ORDER BY created_at DESC`
  );
  const pendingCandidates = candidatesResult.rows;

  const fetchDurationMs = Date.now() - fetchStart;
  log.info(
    { concepts: concepts.length, episodes: episodes.length, traces: traces.length, entities: entities.length, existingSkills: existingSkills.length, pendingCandidates: pendingCandidates.length, durationMs: fetchDurationMs },
    "reflection corpus fetched",
  );

  // ── Token estimate ─────────────────────────────────────
  const conceptTokens = concepts.reduce((s: number, c: { content: string }) => s + Math.ceil(c.content.length / 4), 0);
  const episodeTokens = episodes.reduce((s: number, e: { summary: string }) => s + Math.ceil(e.summary.length / 4), 0);
  const traceTokens = traces.reduce((s: number, t: { content: string }) => s + Math.ceil(t.content.length / 4), 0);
  const totalTokens = conceptTokens + episodeTokens + traceTokens;
  const threshold = 350_000;
  const mode = totalTokens > threshold ? 'tiered' : 'full';

  log.info({ totalTokens, threshold, mode }, "reflection corpus token estimate");
  if (mode === 'tiered') {
    log.warn("corpus exceeds 350K threshold — tiered mode not yet implemented, proceeding with full corpus");
  }

  // ── Phase 2: Build prompt ──────────────────────────────
  const conceptsText = concepts
    .map((c: { id: string; concept_type: string; content: string; utility_score: number; confidence: number }) =>
      `[concept:${c.id}] (${c.concept_type}, util=${c.utility_score.toFixed(2)}, conf=${c.confidence.toFixed(2)}) ${c.content}`)
    .join("\n");

  // Build a slug→UUID map so the LLM gets short memorable keys instead of 36-char UUIDs.
  // The LLM selects from [ep:<slug>] labels it actually sees in the corpus, then we remap
  // slugs back to real UUIDs before DB insertion. Avoids the working-memory recall problem
  // that caused the LLM to invent integers when asked to cite UUIDs from 90K+ tokens back.
  const episodeSlugIndex = new Map<string, string>(); // slug → uuid
  const slugCounts = new Map<string, number>();        // for collision dedup

  function makeSlug(summary: string): string {
    // Take first 6 meaningful words, kebab-case, max 40 chars
    const slug = summary
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join('-')
      .slice(0, 40)
      .replace(/-+$/, '');
    return slug || 'episode';
  }

  const episodesText = episodes
    .map((e: { id: string; summary: string; access_count: number; importance_score: number }) => {
      let slug = makeSlug(e.summary);
      const count = (slugCounts.get(slug) ?? 0) + 1;
      slugCounts.set(slug, count);
      if (count > 1) slug = `${slug}-${count}`;
      episodeSlugIndex.set(slug, e.id);
      return `[ep:${slug}] (access=${e.access_count}, importance=${e.importance_score}) ${e.summary}`;
    })
    .join("\n");

  log.debug({ slugCount: episodeSlugIndex.size, slugs: Array.from(episodeSlugIndex.keys()) }, "episode slug index built");

  const tracesText = traces
    .map((t: { id: string; memory_type: string | null; content: string }) =>
      `[trace:${t.id}] [${t.memory_type ?? 'unknown'}] ${t.content}`)
    .join("\n");

  const entitiesText = entities
    .map((e: { id: string; name: string; entity_type: string; canonical: string | null; relationships: unknown[] | null }) =>
      `[entity:${e.id}] ${e.name} (${e.entity_type}) canonical=${e.canonical ?? 'none'} relationships=${e.relationships?.length ?? 0}`)
    .join("\n");

  const prompt = `You are the memory curator for an AI assistant called Rufus. Rufus uses a multi-tier semantic memory system called USME (Utility-Shaped Memory Ecology) to maintain persistent knowledge across conversations. Your job is to review the full memory corpus and make structured improvements: consolidating duplicates, correcting stale information, surfacing patterns as reusable skills, and mapping relationships between entities.

This is not a retrieval task. You are acting as an editor — reading the whole library and deciding what to keep, what to merge, what to discard, and what new knowledge should be formalized.

## Why this matters

Without periodic reflection, the memory system accumulates noise: outdated facts that were true once, near-duplicate concepts that should be one entry, ephemeral observations that got promoted to stable knowledge by mistake, and recurring workflows that nobody has formalized as a reusable skill. Your review corrects all of this in a single pass.

## Memory Type Definitions

Before reviewing, understand what each tier holds and what good vs. bad memory looks like for each:

**sensory_trace** — Raw per-turn observations. Specific facts, preferences, decisions, and anomalies captured directly from conversations. These are high-volume and short-lived.
- Good: "Alex prefers lru-cache over custom Map-based caching"
- Good: "The gateway restart script must use setsid to detach from the parent process"
- Bad: "Alex likes clean code" (too vague to act on)
- Bad: "Rufus helped Alex" (not a fact, just noise)

**episodes** — Narrative summaries of thematic clusters of traces. An episode tells a coherent story: what was attempted, what was decided, what succeeded or failed. Good episodes have a clear subject and outcome and would still be useful to a reader a month from now. Bad episodes are disconnected lists of facts with no unifying thread, or so short they add nothing a trace doesn't already cover.

**concepts** — Stable, long-term knowledge intended to persist indefinitely. A good concept is a durable truth — a preference that holds across projects ("battle-tested libraries over custom implementations"), a decision that was made and stands ("embeddings route through OpenAI, not Anthropic"), or a relationship fact ("Ronan calls Alex weekly at 5:30 PM Pacific"). Bad concepts are too specific to a single event, already superseded by something more recent, or so generic they provide no actionable signal. Concepts that contradict each other need resolution — only one can be true.

**entities** — Named things: people, projects, tools, organizations. An entity is worth tracking when it's referenced frequently enough to warrant mapping its relationships.
- Good relationship: Alex MAINTAINS usme-claw, Rufus USES ruflo-swarm, nightly.ts GATES ON importance_score
- Bad relationship: vague associations with no directional meaning ("Alex — USME")
Orphan entities with no relationships and low reference frequency should be candidates for pruning.

**skills** — Reusable procedures the agent has learned to perform well, extracted from recurring patterns in episodes. A good skill is generalizable: it applies to future situations beyond the specific case that produced it.
- Good: "How to deploy an OpenClaw plugin" (transfers to any plugin deployment)
- Good: "How to diagnose a silent DB connectivity failure" (transfers to any DB issue)
- Bad: "How to fix the USME importance_score schema" (too specific, won't recur)
- Bad: "Run npm run build from usme-openclaw/" (a step, not a skill)
Prefer abstract, cross-domain patterns over project-specific how-tos. Ask: if the specific project changed, would this skill still be useful?

## Memory Corpus

### Active Concepts (${concepts.length})
${conceptsText || '(none)'}

### Recent Episodes (${episodes.length})
${episodesText || '(none)'}

### Recent Sensory Traces — last 48h (${traces.length})
${tracesText || '(none)'}

### Entities (${entities.length})
${entitiesText || '(none)'}

## Instructions

**Step 1 — Reason first.**

Before producing any output, think through the corpus carefully. Use a <thinking> block for your reasoning. Consider:
- Which concepts are still true vs. stale or superseded?
- Which concepts are near-duplicates that should be merged?
- What patterns recur across multiple episodes that would make a generalizable skill?
- Which entities have enough relationship evidence to warrant updates?
- Are there any contradictions that need a winner picked?

Do not rush to the structured output. The thinking block is where you do the real work. The structured output should follow naturally from that reasoning.

**Step 2 — Produce structured output.**

After your thinking block, call the reflection_output tool with:

1. **concept_updates** — raise/lower importance, deprecate outdated or superseded concepts, merge duplicates. For each, ask: Is this still true? Is it specific enough to be useful? Is it already captured more precisely elsewhere?

2. **new_skills** — patterns that recur across multiple episodes and would transfer to similar future situations. Only include skills with confidence >= 0.5; anything lower is not worth proposing. Prefer fewer, higher-quality skills over a long list of marginal ones. **Do not propose a skill whose name already exists in the skills table** — duplicates will be silently dropped. For each skill, populate **source_episode_ids** with the slug strings from the [ep:<slug>] labels in the corpus above that evidence the pattern — copy the slug exactly as it appears (e.g. ["fix-postgres-savepoint-cascade", "debug-max-tokens-truncation"]). Do not invent slugs that are not in the corpus.

Active skills (already promoted — do NOT reproduce these):
${existingSkills.length > 0 ? existingSkills.map((s: { name: string }) => `- ${s.name}`).join('\n') : '(none yet)'}

Pending review queue (already in the candidate backlog — do NOT propose near-duplicates of these):
${pendingCandidates.length > 0 ? pendingCandidates.map((c: { id: number; name: string; description: string }) => `- [${c.id}] ${c.name}: ${c.description}`).join('\n') : '(none yet)'}

When you see near-duplicates in the pending review queue, include them in candidate_dismissals with one of these reasons:
- "too specific: single incident, will not recur"
- "duplicate: covered by [candidate name]"
- "micro-pattern: not generalizable across domains"

**CRITICAL — array field rules:** concept_updates, new_skills, contradictions, and entity_updates MUST always be JSON arrays. If there are no items, return an empty array []. NEVER return a string, null, or words like "None", "N/A", or "NONE" for these fields — those values will be silently lost and the data will be discarded.

**CRITICAL — JSON string encoding rules (read carefully):** All string values inside the tool call JSON MUST follow strict JSON encoding. This means:
- Newlines inside strings MUST be encoded as the two-character escape sequence \n — NEVER as a literal line break
- Tabs MUST be encoded as \t — NEVER as a literal tab character
- Backslashes MUST be encoded as \\
- Double quotes inside strings MUST be encoded as \"
- No other ASCII control characters (characters with code points 0–31) are allowed inside JSON strings

For example, a multi-line description MUST be written as a single JSON string like:
"description": "First sentence. Second sentence.\nThird sentence."

NOT as a literal multi-line block. If you write actual line breaks inside a JSON string value, the JSON becomes invalid and ALL data in that array field will be silently discarded. When in doubt, keep descriptions to a single paragraph with no newlines at all.

3. **contradictions** — concepts that conflict with each other or with recent episode evidence. Pick the winner based on recency and strength of evidence, not just the confidence score alone.

4. **entity_updates** — add relationships that are clearly established by episode and trace evidence. Skip speculative or one-off associations.

5. **overall_assessment** — grade the corpus health (A/B/C/D), identify the most important gaps or improvement opportunities, and flag any patterns that should be addressed before the next reflection run.`;

  // ── Phase 3: LLM call ──────────────────────────────────
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY not set — cannot run reflection");
  }

  const client = new Anthropic({ apiKey: anthropicKey });
  const llmStart = Date.now();

  log.debug(
    {
      promptLength: prompt.length,
      episodesTextLength: episodesText.length,
      episodesText,
      slugCount: episodeSlugIndex.size,
    },
    "reflect llm input"
  );

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    tools: [{
      name: "reflection_output",
      description: "Structured output from memory corpus reflection",
      input_schema: {
        type: "object" as const,
        properties: {
          concept_updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                concept_id: { type: "string" },
                action: { type: "string", enum: ["raise", "lower", "deprecate", "merge"] },
                importance_delta: { type: "number" },
                merge_target_id: { type: "string" },
                reason: { type: "string" },
              },
              required: ["concept_id", "action", "reason"],
            },
          },
          new_skills: {
            type: "array",
            description: "Must be a JSON array. Use [] if there are no new skills — never return a string or null.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                trigger_pattern: { type: "string" },
                confidence: { type: "number" },
                source_episode_ids: { type: "array", items: { type: "string", description: "Slug from [ep:<slug>] label in corpus — copy exactly, do not invent" } },
              },
              required: ["name", "description", "confidence"],
            },
          },
          contradictions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                winner_concept_id: { type: "string" },
                loser_concept_id: { type: "string" },
                reason: { type: "string" },
              },
              required: ["winner_concept_id", "loser_concept_id", "reason"],
            },
          },
          entity_updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                entity_id: { type: "string" },
                action: { type: "string", enum: ["add_relationship", "remove_relationship", "reclassify"] },
                details: { type: "object" },
              },
              required: ["entity_id", "action", "details"],
            },
          },
          overall_assessment: { type: "string" },
          candidate_dismissals: {
            type: "array",
            description: "IDs of pending skill_candidates to dismiss as near-duplicates or non-generalizable patterns.",
            items: {
              type: "object",
              properties: {
                candidate_id: { type: "number" },
                reason: { type: "string" },
              },
              required: ["candidate_id", "reason"],
            },
          },
        },
        required: ["concept_updates", "new_skills", "contradictions", "entity_updates", "overall_assessment"],
      },
    }],
    tool_choice: { type: "tool", name: "reflection_output" },
    messages: [{ role: "user", content: prompt }],
  });

  const llmDurationMs = Date.now() - llmStart;
  const inputTokens = response.usage?.input_tokens;
  const outputTokens = response.usage?.output_tokens;

  log.info({ model, inputTokens, outputTokens, durationMs: llmDurationMs }, "reflection llm_call complete");

  // Normalise LLM output: Sonnet sometimes returns array fields as JSON-encoded strings
  // instead of actual arrays (double-encoding). This happens especially for fields with
  // complex nested content (multi-line descriptions with literal newlines in string values).
  // We apply a three-strategy parse to recover the data rather than silently dropping it.
  const rawOutput = extractToolInput(response, "reflection_output") as Record<string, unknown>;

  log.debug(
    {
      rawNewSkills: (rawOutput as Record<string, unknown>).new_skills,
    },
    "reflect llm raw new_skills (before remap)"
  );

  try {
    mkdirSync("/tmp/debug", { recursive: true });
    writeFileSync(
      `/tmp/debug/reflect-${Date.now()}.json`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        episodesText,
        slugIndex: Object.fromEntries(episodeSlugIndex),
        rawNewSkills: (rawOutput as Record<string, unknown>).new_skills,
      }, null, 2),
    );
  } catch (e) {
    log.warn({ err: String(e) }, "debug dump write failed");
  }

  const arrayFields = ["concept_updates", "new_skills", "contradictions", "entity_updates"] as const;

  function tryParseArray(raw: string): unknown[] | null {
    // Strategy 1: direct parse (handles correctly-encoded double-encoded arrays)
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v;
    } catch { /* fall through */ }

    // Strategy 2: jsonrepair — battle-tested library that handles unescaped newlines,
    // tabs, trailing commas, unquoted keys, and other common LLM JSON output mistakes.
    // This is far more robust than hand-rolled sanitization.
    try {
      const repaired = jsonrepair(raw);
      const v = JSON.parse(repaired);
      if (Array.isArray(v)) return v;
    } catch (e2) {
      log.warn({ parseError: String(e2), sample: raw.slice(0, 500) }, 'strategy 2 (jsonrepair) failed');
    }

    // Strategy 3: bracket-boundary extraction + jsonrepair.
    // Find the outermost [ ... ] and attempt to repair+parse just that slice.
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

  for (const field of arrayFields) {
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

  const parseResult = ReflectionOutputSchema.safeParse(rawOutput);
  if (!parseResult.success) {
    throw new Error(`Reflection schema validation failed: ${JSON.stringify(parseResult.error)}`);
  }

  const output = parseResult.data;

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
    const durationMs = Date.now() - start;
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
      durationMs,
      candidatesCreated: 0,
      dismissalsProcessed: 0,
    };
  }

  // ── Phase 4: Write to DB in a transaction ──────────────
  const pgPool = getPool();
  const client2 = await pgPool.connect();
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

  try {
    await client2.query("BEGIN");

    // Insert reflection_run row
    const { rows: runRows } = await client2.query(
      `INSERT INTO reflection_runs
         (trigger_source, model, input_tokens, output_tokens, status)
       VALUES ($1, $2, $3, $4, 'running')
       RETURNING id`,
      [opts.triggerSource, model, inputTokens ?? null, outputTokens ?? null],
    );
    runId = runRows[0].id;

    // Apply concept updates
    let spCount = 0;
    for (const update of output.concept_updates) {
      const sp = `sp_${spCount++}`;
      await client2.query(`SAVEPOINT ${sp}`);
      try {
        if (update.action === 'deprecate') {
          await client2.query(
            `UPDATE concepts SET is_active = false, updated_at = NOW() WHERE id = $1`,
            [update.concept_id],
          );
          changes.conceptsUpdated++;
        } else if (update.action === 'merge' && update.merge_target_id) {
          await client2.query(
            `UPDATE concepts SET is_active = false, superseded_by = $2, updated_at = NOW() WHERE id = $1`,
            [update.concept_id, update.merge_target_id],
          );
          changes.conceptsUpdated++;
        } else if (update.action === 'raise' || update.action === 'lower') {
          const delta = update.importance_delta ?? (update.action === 'raise' ? 0.1 : -0.1);
          await client2.query(
            `UPDATE concepts
             SET utility_score = GREATEST(0, LEAST(1.0, utility_score + $2)), updated_at = NOW()
             WHERE id = $1`,
            [update.concept_id, delta],
          );
          changes.conceptsUpdated++;
        }
        await client2.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (err) {
        await client2.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        log.error({ err, update }, "concept update failed — skipping");
      }
    }

    // ── Process candidate_dismissals ────────────────────
    const dismissals = output.candidate_dismissals ?? [];
    if (dismissals.length > 0) {
      await client2.query('SAVEPOINT candidate_dismissals');
      try {
        for (const d of dismissals) {
          await client2.query(
            `UPDATE skill_candidates SET dismissed_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [d.candidate_id]
          );
          dismissalsProcessed++;
        }
        await client2.query('RELEASE SAVEPOINT candidate_dismissals');
        log.info(`Dismissed ${dismissalsProcessed} candidates`);
      } catch (err) {
        await client2.query('ROLLBACK TO SAVEPOINT candidate_dismissals');
        log.error({ err }, 'Failed to process candidate_dismissals');
      }
    }

    // ── Apply new skills (quality-gated) ────────────────
    // ALL qualifying candidates (confidence >= 0.5) go to skill_candidates.
    // quality_tier:
    //   0.70+ → 'candidate'
    //   0.50–0.69 → 'draft'
    //   < 0.50 → skip
    if (qualityPasses) {
      for (const skill of output.new_skills) {
        if (skill.confidence < 0.5) {
          log.info({ name: skill.name, confidence: skill.confidence }, "skill skipped — confidence below 0.5");
          continue;
        }

        const qualityTier = skill.confidence >= 0.7 ? 'candidate' : 'draft';

        // trgm similarity guard
        const trgmCheck = await client2.query(
          `SELECT id, name FROM skill_candidates WHERE dismissed_at IS NULL AND similarity(name, $1) > 0.5 ORDER BY similarity(name, $1) DESC LIMIT 1`,
          [skill.name]
        );
        if (trgmCheck.rows.length > 0) {
          log.info(`Skipping '${skill.name}' — too similar to existing candidate '${trgmCheck.rows[0].name}' (trgm guard)`);
          continue;
        }

        const sp = `sp_${spCount++}`;
        await client2.query(`SAVEPOINT ${sp}`);
        try {
          await client2.query(
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
              // Remap slugs returned by the LLM back to real UUIDs before DB insertion.
              // The LLM was shown [ep:<slug>] labels in the corpus; we map each slug to
              // the UUID we stored in episodeSlugIndex during corpus construction.
              (() => {
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
                  {
                    skillName: skill.name,
                    slugsRequested: skill.source_episode_ids.length,
                    slugsMapped: mapped.length,
                    slugsMissed: missed.length,
                    missedSlugs: missed,
                    mappedUuids: mapped,
                  },
                  missed.length > 0 ? "skill episode remap: LLM invented slugs (not in corpus)" : "skill episode remap: all slugs matched",
                );
                return mapped.length > 0 ? mapped : null;
              })(),
              skill.confidence,
              runId,
              qualityTier,
            ],
          );
          changes.skillsCreated++;
          candidatesCreated++;
          await client2.query(`RELEASE SAVEPOINT ${sp}`);
        } catch (err) {
          await client2.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          log.error({ err, skill }, "skill_candidate insert failed — skipping");
        }
      }
    } else {
      log.info(
        { grade, newSkills: output.new_skills.length },
        "skill candidate writes skipped due to quality gate",
      );
    }

    // Apply contradictions
    for (const contradiction of output.contradictions) {
      const sp = `sp_${spCount++}`;
      await client2.query(`SAVEPOINT ${sp}`);
      try {
        await client2.query(
          `UPDATE concepts SET is_active = false, superseded_by = $2, updated_at = NOW() WHERE id = $1`,
          [contradiction.loser_concept_id, contradiction.winner_concept_id],
        );
        changes.contradictionsResolved++;
        await client2.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (err) {
        await client2.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        log.error({ err, contradiction }, "contradiction resolution failed — skipping");
      }
    }

    // Apply entity updates
    for (const update of output.entity_updates) {
      const sp = `sp_${spCount++}`;
      await client2.query(`SAVEPOINT ${sp}`);
      try {
        const details = update.details as Record<string, unknown>;
        if (update.action === 'add_relationship') {
          await client2.query(
            `INSERT INTO entity_relationships
               (source_id, target_id, relationship, confidence, valid_from, metadata)
             VALUES ($1, $2, $3, $4, NOW(), $5)`,
            [
              update.entity_id,
              details.target_entity_id ?? details.target_id ?? update.entity_id,
              details.relationship ?? 'related',
              details.confidence ?? 0.8,
              JSON.stringify({ from_reflection: runId }),
            ],
          );
          changes.entitiesUpdated++;
        } else if (update.action === 'remove_relationship') {
          await client2.query(
            `UPDATE entity_relationships SET valid_until = NOW()
             WHERE source_id = $1 AND target_id = $2 AND valid_until IS NULL`,
            [update.entity_id, details.target_entity_id ?? details.target_id ?? update.entity_id],
          );
          changes.entitiesUpdated++;
        } else if (update.action === 'reclassify') {
          await client2.query(
            `UPDATE entities SET entity_type = $2, updated_at = NOW() WHERE id = $1`,
            [update.entity_id, details.new_type ?? 'concept'],
          );
          changes.entitiesUpdated++;
        }
        await client2.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (err) {
        await client2.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        log.error({ err, update }, "entity update failed — skipping");
      }
    }

    // ── Post-run notification flag ────────────────────────
    // If candidates were written, decide whether to notify now or defer to morning.
    let pendingMorningNotify = false;
    if (candidatesCreated > 0) {
      if (isDayTimeInPacific()) {
        // Daytime: caller will deliver notification immediately based on candidatesCreated > 0.
        log.info({ candidatesCreated, runId }, "daytime — caller will deliver candidates-ready notification");
      } else {
        // Nighttime: set pending_morning_notify so the 09:00 Pacific cron picks it up.
        pendingMorningNotify = true;
        log.info({ candidatesCreated, runId }, "nighttime — setting pending_morning_notify=TRUE for morning cron");
      }
    }

    // Update reflection_run with final stats
    const durationMs = Date.now() - start;
    await client2.query(
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

    await client2.query("COMMIT");

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
    await client2.query("ROLLBACK");

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
    client2.release();
  }
}
