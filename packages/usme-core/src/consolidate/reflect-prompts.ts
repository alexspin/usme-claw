/**
 * Prompt builders for the reflection pipeline.
 */

import type { ActiveConstraint, SlugTexts, ReflectionCorpus } from "./reflect-corpus.js";
import type { GRAPH_BUILDER_CONFIG } from "./reflect-config.js";

// ── Main reflection prompt ─────────────────────────────────

export function buildMainPrompt(
  corpus: ReflectionCorpus,
  slugTexts: SlugTexts,
  activeConstraints: ActiveConstraint[],
): string {
  const { conceptsText, episodesText, tracesText, entitiesText } = slugTexts;
  const { concepts, episodes, traces, entities, existingSkills, pendingCandidates } = corpus;

  const existingSkillNames = existingSkills.length > 0
    ? existingSkills.map((r) => `"${r.name}"`).join(', ')
    : '(none yet)';

  const constraintsSection = activeConstraints.length > 0
    ? `Existing active constraints — do NOT recreate these. Return only novel constraints not already covered by the list below:\n` +
      activeConstraints.map((c) => `- [${c.pattern}] ${c.content}`).join('\n')
    : '(no active constraints yet)';

  return `You are the memory curator for an AI assistant called Rufus. Rufus uses a multi-tier semantic memory system called USME (Utility-Shaped Memory Ecology) to maintain persistent knowledge across conversations. Your job is to review the full memory corpus and make structured improvements: consolidating duplicates, correcting stale information, surfacing patterns as reusable skills, and mapping relationships between entities.

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

**entities** — Named things worth tracking across time: people, projects, tools, organizations, components, and other durable objects that remain relevant across multiple conversations or work sessions. An entity is worth tracking when it is referenced repeatedly enough to justify mapping relationships.

Prefer entities that would still matter if the exact command, file, or session changed.

**Hard exclusions — NEVER create entities for these:**
- File paths, filenames, or directory names (e.g., reflect-prompts.ts, /home/alex/..., usme-openclaw/)
- Shell commands, command flags, logs, stack traces, or SQL fragments
- Commit hashes or any hex string (e.g., c1ac9ca, 920ff43)
- Version strings (e.g., v1.2.3, gpt-4o, node 22)
- Temporary session labels or generated names (e.g., plaid-harbor, young-valley, marine-zephyr)
- Generated IDs or summary slugs (e.g., sum_3fdd36b, ep:abc123)
- Migration script names (e.g., 018-entity-rel-unique.sql)
- One-off tool invocations, config keys, or environment variable names
- Any name matching the pattern: adjective-noun where both parts appear to be random words (these are ephemeral session identifiers)

**Exception:** A file, tool, or artifact may be treated as an entity **only if all three are true:**
1. It is referenced in 3 or more distinct traces or episodes as a goal-critical object
2. The user makes active decisions about it (not just runs it incidentally)
3. Removing this entity from the graph would make the graph meaningfully less useful

Examples: AGENTS.md (constantly referenced, decisions made about it) YES vs reflect-corpus.ts (mentioned in code discussions, not a decision object) NO

Ask yourself the **whiteboard test**: if a new engineer joined the team today, would you write this thing's name on the whiteboard when explaining how the system works? If not, skip it.

- Good relationship: Alex MAINTAINS usme-claw, Rufus USES ruflo-swarm, deploy-pipeline IS_A operational-component
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

**CRITICAL — use slugs, not UUIDs.** Concepts are labelled [concept:<slug>], entities are labelled [entity:<slug>], and episodes are labelled [ep:<slug>]. In every field below that references an id (concept_id, winner_concept_id, loser_concept_id, merge_target_id, entity_id, source_episode_ids), you MUST copy the slug exactly as it appears in the corpus label — do not invent or hallucinate identifiers. The server maps slugs back to real UUIDs; if you return an unknown string the item will be silently skipped.

1. **concept_updates** — raise/lower importance, deprecate outdated or superseded concepts, merge duplicates. For each, ask: Is this still true? Is it specific enough to be useful? Is it already captured more precisely elsewhere? Set concept_id to the slug from the [concept:<slug>] label. For merge actions, set merge_target_id to the slug of the concept being merged into.

2. **new_skills** — patterns that recur across multiple episodes and would transfer to similar future situations. Only include skills with confidence >= 0.5; anything lower is not worth proposing. Prefer fewer, higher-quality skills over a long list of marginal ones. **Do not propose a skill whose name already exists in the skills table** — duplicates will be silently dropped. For each skill, populate **source_episode_ids** with the slug strings from the [ep:<slug>] labels in the corpus above that evidence the pattern — copy the slug exactly as it appears (e.g. ["fix-postgres-savepoint-cascade", "debug-max-tokens-truncation"]). Do not invent slugs that are not in the corpus.

Active skills (already promoted — do NOT reproduce these):
${existingSkills.length > 0 ? existingSkills.map((s) => `- ${s.name}`).join('\n') : '(none yet)'}

Pending review queue (already in the candidate backlog — do NOT propose near-duplicates of these):
${pendingCandidates.length > 0 ? pendingCandidates.map((c) => `- [${c.id}] ${c.name}: ${c.description}`).join('\n') : '(none yet)'}

When you see near-duplicates in the pending review queue, include them in candidate_dismissals with one of these reasons:
- "too specific: single incident, will not recur"
- "duplicate: covered by [candidate name]"
- "micro-pattern: not generalizable across domains"

**CRITICAL — array field rules:** concept_updates, new_skills, contradictions, and entity_updates MUST always be JSON arrays. If there are no items, return an empty array []. NEVER return a string, null, or words like "None", "N/A", or "NONE" for these fields — those values will be silently lost and the data will be discarded.

**CRITICAL — JSON string encoding rules (read carefully):** All string values inside the tool call JSON MUST follow strict JSON encoding. This means:
- Newlines inside strings MUST be encoded as the two-character escape sequence \\n — NEVER as a literal line break
- Tabs MUST be encoded as \\t — NEVER as a literal tab character
- Backslashes MUST be encoded as \\\\
- Double quotes inside strings MUST be encoded as \\"
- No other ASCII control characters (characters with code points 0–31) are allowed inside JSON strings

For example, a multi-line description MUST be written as a single JSON string like:
"description": "First sentence. Second sentence.\\nThird sentence."

NOT as a literal multi-line block. If you write actual line breaks inside a JSON string value, the JSON becomes invalid and ALL data in that array field will be silently discarded. When in doubt, keep descriptions to a single paragraph with no newlines at all.

3. **contradictions** — concepts that conflict with each other or with recent episode evidence. Pick the winner based on recency and strength of evidence, not just the confidence score alone. Set winner_concept_id and loser_concept_id to the slugs from their [concept:<slug>] labels.

4. **entity_updates** — add a relationship only if it is evidenced by at least 2 distinct traces or episodes in this corpus. Do not add generic "related_to" or "related" edges — only directional verbs: uses, manages, owns, part_of, calls, routes_via, works_at, is_a. Do not create or update entities for ephemeral references unless they clearly function as durable, repeatedly referenced, goal-critical objects in this corpus. Maximum 20 entity_updates per run; return fewer if you cannot find 20 that clear the evidence bar. Set entity_id to the slug from the [entity:<slug>] label.

5. **new_constraints** — behavioral rules and stop-rules extracted from user correction patterns in the trace and episode corpus. Look for:
   - Repeated explicit corrections: things the user has said "stop doing" or "always do first" more than once
   - Process rules that came up multiple times (e.g., "assess before coding", "ask before changes")
   - Failure modes the user flagged as recurring and wants prevented proactively
   Only include constraints backed by at least 2 separate traces or episodes. Single one-off requests do not qualify. Use [] if nothing clears that bar. Keep each constraint to one short actionable sentence.
   Pattern meanings: NEVER = hard prohibition, STOP_DO = stop X and do Y instead, PREFER = soft preference, WARN = flag this before proceeding.

${constraintsSection}

6. **overall_assessment** — grade the corpus health (A/B/C/D), identify the most important gaps or improvement opportunities, and flag any patterns that should be addressed before the next reflection run.`;
}

// ── Reflection tool schema ─────────────────────────────────

export function buildReflectionToolSchema(): object[] {
  return [{
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
              concept_id: { type: "string", description: "Slug from [concept:<slug>] label in corpus — copy exactly, do not invent" },
              action: { type: "string", enum: ["raise", "lower", "deprecate", "merge"] },
              importance_delta: { type: "number" },
              merge_target_id: { type: "string", description: "Slug from [concept:<slug>] label of the merge target — copy exactly" },
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
              winner_concept_id: { type: "string", description: "Slug from [concept:<slug>] label — copy exactly" },
              loser_concept_id: { type: "string", description: "Slug from [concept:<slug>] label — copy exactly" },
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
              entity_id: { type: "string", description: "Slug from [entity:<slug>] label in corpus — copy exactly, do not invent" },
              action: { type: "string", enum: ["add_relationship", "remove_relationship", "reclassify"] },
              details: { type: "object" },
            },
            required: ["entity_id", "action", "details"],
          },
        },
        new_constraints: {
          type: "array",
          description: "Behavioral constraints extracted from user correction patterns. Each constraint is a durable rule the agent must observe. Extract these from: repeated explicit corrections ('stop doing X', 'always do Y first'), process rules that came up more than once, failure modes the user flagged as recurring. Only include constraints backed by at least 2 traces or episodes — not one-off requests. Use [] if none qualify.",
          items: {
            type: "object",
            properties: {
              pattern: {
                type: "string",
                enum: ["NEVER", "STOP_DO", "PREFER", "WARN"],
                description: "NEVER: hard prohibition. STOP_DO: stop X, do Y instead. PREFER: soft preference. WARN: flag this situation before proceeding.",
              },
              content: {
                type: "string",
                description: "The plain-English constraint text. Keep it short and actionable (one sentence). Example: 'Never run restart-gateway.sh directly from inside the gateway process'",
              },
            },
            required: ["pattern", "content"],
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
  }];
}

// ── Graph builder prompt ───────────────────────────────────

export function buildGraphBuilderPrompt(
  entityBatch: Array<{ slug: string; name: string; entity_type: string; rel_count: number }>,
  tracesText: string,
  episodesText: string,
  config: typeof GRAPH_BUILDER_CONFIG,
): string {
  const entitiesText = entityBatch
    .map((e) => `[entity:${e.slug}] ${e.name} (${e.entity_type}) existing_rels=${e.rel_count}`)
    .join('\n');

  return `You are building a relationship graph for an AI memory system called USME.

You are shown a batch of named entities and a corpus of recent memory evidence.
Your job: identify which relationships between these entities are clearly evidenced
by the corpus.

## What makes a good relationship

Only propose relationships that reflect something meaningful about how the world is organized — not just that two things appeared near each other in text.

Ask yourself: **"Would a human write this on a whiteboard when explaining the system?"** If yes, propose it. If no, skip it.

Good relationships capture real-world facts:
- ✅ "Alex manages Ruflo-Claw-Swarm" — a person actively managing a project
- ✅ "USME uses PostgreSQL" — architectural dependency
- ✅ "usme-claw is_a USME" — conceptual taxonomy

Bad relationships capture implementation noise:
- ❌ "reflect-corpus.ts part_of reflect.ts" — file structure, not a meaningful fact
- ❌ ".gitignore related_to dist" — config artifact, skip it
- ❌ "018-entity-rel.sql part_of migration" — migration filename, not meaningful

If both endpoints of a proposed relationship are source files, config files, or implementation artifacts, skip the relationship entirely.

## Evidence Corpus

### Recent Traces (last 48h)
${tracesText || '(none)'}

### Recent Episodes
${episodesText || '(none)'}

## Entity Batch (${entityBatch.length} entities)
${entitiesText}

## Rules
- Only propose a relationship evidenced by at least ${config.minEvidenceCount} distinct traces or episodes
- Only use these verbs: ${config.allowedRelVerbs.join(', ')}
- Do NOT use: related_to, related, associated_with, or any other vague verb
- Use [entity:slug] labels exactly as shown — do not invent slugs
- target_slug can reference entities NOT in this batch if they appear in the evidence corpus
- Return [] if no relationships meet the evidence bar

Call graph_output with:
- relationships: array of { source_slug, relationship, target_slug, confidence }
  confidence = 0.5–1.0 based on evidence strength`;
}
